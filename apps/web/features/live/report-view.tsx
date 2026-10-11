"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useMutation } from "@tanstack/react-query";
import {
  createPublicApiClient,
  PublicApiError,
  type ReportAccepted,
  type ReportSubmission,
} from "@/lib/public-api";
import { uploadToStorage } from "@/lib/storage-upload";
import { readyForTelegram, telegramInitData, useIsTelegramMiniApp } from "@/lib/telegram-webapp";

/**
 * The Telegram Mini App report form.
 *
 * One screen: a photo, a location and an optional note. The bot conversation does the
 * same job in two messages; this exists because a form is faster for anyone who will open
 * a Mini App, and because it can read the phone's GPS instead of asking for a shared pin.
 *
 * Runs only inside Telegram, and says so plainly outside it - not because the page cannot
 * render in a browser, but because a report needs a signed identity and a browser has
 * none. The confirmation mechanic counts distinct reporters, so an anonymous submission
 * would be a vote nobody could weigh.
 */

type Position = { latitude: number; longitude: number; accuracy: number | null };

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_COMMENT = 300;

export function ReportView({ apiBaseUrl }: { apiBaseUrl: string }) {
  // Read as an external store rather than in an effect: the browser and Telegram cases
  // render entirely different screens, and settling it after the first paint would show
  // one and then swap to the other.
  const inTelegram = useIsTelegramMiniApp();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<{ url: string } | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  // Starts true inside Telegram, because the mount effect starts a fix immediately.
  const [locating, setLocating] = useState(inTelegram);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<ReportAccepted | null>(null);

  // Generated once per attempt, not per submit: a retry after a lost connection must
  // reuse the same key or a second tap becomes a second report.
  const attemptId = useRef<string>(crypto.randomUUID());

  const api = useMemo(
    () => createPublicApiClient(apiBaseUrl, () => telegramInitData()),
    [apiBaseUrl],
  );

  useEffect(readyForTelegram, []);

  /**
   * Ask the phone where it is. Every state change happens in a callback, never in this
   * function's body, so the mount effect below can call it without a synchronous render
   * cascade - and so the button handler and the effect share one implementation.
   */
  const requestPosition = useCallback(() => {
    navigator.geolocation.getCurrentPosition(
      (fix) => {
        setPosition({
          latitude: fix.coords.latitude,
          longitude: fix.coords.longitude,
          accuracy: Number.isFinite(fix.coords.accuracy) ? fix.coords.accuracy : null,
        });
        setLocating(false);
      },
      (error) => {
        setLocationError(
          error.code === error.PERMISSION_DENIED
            ? "Доступ к геолокации запрещён. Разрешите его в настройках."
            : "Не удалось определить геолокацию. Попробуйте ещё раз.",
        );
        setLocating(false);
      },
      // A pothole is metres wide, so an approximate network fix is not good enough.
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 10_000 },
    );
  }, []);

  const locate = useCallback(() => {
    if (!("geolocation" in navigator)) {
      setLocationError("Геолокация недоступна на этом устройстве.");
      setLocating(false);
      return;
    }
    setLocating(true);
    setLocationError(null);
    requestPosition();
  }, [requestPosition]);

  // Started as soon as the form opens: someone standing at the pothole should not have to
  // find a button before the phone begins working out where they are.
  useEffect(() => {
    if (!inTelegram) return;
    if (!("geolocation" in navigator)) return;
    requestPosition();
  }, [inTelegram, requestPosition]);

  // The object URL is created where the file is chosen, not in an effect reacting to it:
  // the two always change together, and an effect would render once with a stale preview.
  const onPickFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0] ?? null;
    setFileError(null);

    if (!picked) {
      setFile(null);
      return;
    }
    if (!picked.type.startsWith("image/")) {
      setFileError("Нужно фото.");
      setFile(null);
      return;
    }
    if (picked.size > MAX_IMAGE_BYTES) {
      setFileError("Фото слишком большое.");
      setFile(null);
      return;
    }
    setFile(picked);
    setPreview({ url: URL.createObjectURL(picked) });
  };

  // Releasing the URL is genuinely effect work: it is cleanup for an external resource,
  // and this form runs both on replacing the photo and on leaving the page. The effect
  // sets no state - it only registers the teardown.
  useEffect(() => {
    if (!preview) return;
    return () => URL.revokeObjectURL(preview.url);
  }, [preview]);

  const submit = useMutation({
    mutationFn: async (): Promise<ReportAccepted> => {
      if (!position) throw new Error("Нет геолокации");

      const body: ReportSubmission = {
        client_report_id: attemptId.current,
        latitude: position.latitude,
        longitude: position.longitude,
        location_accuracy_m: position.accuracy,
        comment: comment.trim() ? comment.trim().slice(0, MAX_COMMENT) : null,
      };
      const result = await api.submitReport(body);

      // The photo goes straight to storage, never through the API - the same arrangement
      // the drive uploader uses. A failed upload does not fail the report: the marker is
      // already on the map and a picture can follow.
      if (file && result.image_upload) {
        try {
          await uploadToStorage(result.image_upload, file);
        } catch {
          // Reported without a photo, which is still worth having.
        }
      }
      return result;
    },
    onSuccess: setAccepted,
  });

  if (!inTelegram) {
    return (
      <Centered>
        <h1 className="text-[18px] font-semibold">Отправка через Telegram</h1>
        <p className="mt-2 text-[14px] leading-5 text-secondary">
          Сообщить о яме можно из Telegram: так к сообщению привязан отправитель, и
          несколько независимых сообщений подтверждают яму автоматически.
        </p>
        <Link
          href="/live"
          className="mt-4 inline-flex h-10 items-center rounded-md border border-border-strong bg-surface px-4 text-[14px] font-medium"
        >
          Вернуться к карте
        </Link>
      </Centered>
    );
  }

  if (accepted) {
    return <Result accepted={accepted} />;
  }

  const canSubmit = Boolean(position) && !submit.isPending;

  return (
    <div className="mx-auto flex h-full w-full max-w-[520px] flex-col gap-4 overflow-y-auto p-4">
      <header>
        <h1 className="text-[18px] font-semibold leading-6">Сообщить о яме</h1>
        <p className="mt-1 text-[13px] leading-5 text-secondary">
          Фото и геолокация. Яма появится на карте как неподтверждённая.
        </p>
      </header>

      <section className="rounded-lg border border-border bg-surface p-3">
        <h2 className="text-[13px] font-semibold">Фото</h2>
        <label className="mt-2 flex h-10 w-full cursor-pointer items-center justify-center rounded-md border border-border-strong bg-raised text-[14px] font-medium">
          {file ? "Заменить фото" : "Сделать фото"}
          <input
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            onChange={onPickFile}
          />
        </label>
        {fileError && (
          <p role="alert" className="mt-2 text-[12px] text-red-ink">
            {fileError}
          </p>
        )}
        {preview && (
          // A local object URL. next/image cannot optimise a blob and does not need to.
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={preview.url}
            alt="Выбранное фото"
            className="mt-2 max-h-[240px] w-full rounded-md border border-border object-cover"
          />
        )}
      </section>

      <section className="rounded-lg border border-border bg-surface p-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[13px] font-semibold">Геолокация</h2>
          <button
            type="button"
            onClick={locate}
            disabled={locating}
            className="h-8 rounded-md border border-border-strong bg-raised px-3 text-[13px] disabled:opacity-60"
          >
            {locating ? "Определяем…" : "Обновить"}
          </button>
        </div>

        {position ? (
          <p className="tabular mt-2 font-mono text-[12px] text-secondary">
            {position.latitude.toFixed(5)}, {position.longitude.toFixed(5)}
            {position.accuracy !== null && ` · ±${Math.round(position.accuracy)} м`}
          </p>
        ) : (
          <p className="mt-2 text-[12px] text-muted">
            {locating ? "Определяем геолокацию…" : "Геолокация не определена."}
          </p>
        )}
        {locationError && (
          <p role="alert" className="mt-2 text-[12px] text-red-ink">
            {locationError}
          </p>
        )}
      </section>

      <section className="rounded-lg border border-border bg-surface p-3">
        <label htmlFor="comment" className="text-[13px] font-semibold">
          Комментарий
        </label>
        <textarea
          id="comment"
          rows={3}
          maxLength={MAX_COMMENT}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          placeholder="Например: глубокая яма в правом ряду"
          className="mt-2 w-full resize-none rounded-md border border-border-strong bg-raised px-3 py-2 text-[14px] outline-none focus:border-blue"
        />
      </section>

      {submit.isError && (
        <p role="alert" className="text-[13px] text-red-ink">
          {submit.error instanceof PublicApiError && submit.error.status === 401
            ? "Telegram не подтвердил вашу личность. Откройте приложение из бота заново."
            : "Не удалось отправить. Попробуйте ещё раз."}
        </p>
      )}

      <button
        type="button"
        disabled={!canSubmit}
        onClick={() => submit.mutate()}
        className="h-11 shrink-0 rounded-md bg-blue-strong text-[15px] font-medium text-white disabled:opacity-50"
      >
        {submit.isPending ? "Отправляем…" : "Отправить"}
      </button>

      {!position && (
        <p className="pb-2 text-center text-[12px] text-muted">
          Без геолокации отправить нельзя: яму нужно поставить на карту.
        </p>
      )}
    </div>
  );
}

function Result({ accepted }: { accepted: ReportAccepted }) {
  const remaining = Math.max(accepted.confirmations_required - accepted.distinct_reporters, 0);

  return (
    <Centered>
      <h1 className="text-[18px] font-semibold">Спасибо</h1>
      <p className="mt-2 text-[14px] leading-5 text-secondary">
        {accepted.already_reported
          ? "Это сообщение уже принято."
          : accepted.verified_now
            ? "Яма подтверждена — о ней сообщили несколько человек."
            : accepted.created_pothole
              ? `Яма добавлена как неподтверждённая. Ещё ${remaining || 1} сообщени${remaining === 1 ? "е" : "я"} — и она станет подтверждённой.`
              : `Эта яма уже есть на карте. Сообщений о ней: ${accepted.sighting_count}.`}
      </p>
      <Link
        href="/live"
        className="mt-4 inline-flex h-10 items-center rounded-md bg-blue-strong px-4 text-[14px] font-medium text-white"
      >
        Открыть карту
      </Link>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-full w-full place-items-center p-6">
      <div className="w-full max-w-[380px] text-center">{children}</div>
    </div>
  );
}
