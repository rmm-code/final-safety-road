"""Everything the bot says, in one module.

Russian, because that is the language of the road users this is for. Kept apart from the
handlers so adding Uzbek later is a lookup, not a rewrite - and so nobody has to read
conversation logic to fix a typo.

The tone follows the product's writing rule: direct and operational. A person standing on
a wet road holding a phone wants to know what to send next, not to be welcomed.
"""

from __future__ import annotations

BUTTON_REPORT = "🕳 Сообщить о яме"
BUTTON_LOCATION = "📍 Отправить геолокацию"
BUTTON_CANCEL = "Отмена"
BUTTON_MAP = "🗺 Открыть карту"

START = (
    "Это бот для сообщений о ямах на дорогах.\n\n"
    "Пришлите фото ямы и её геолокацию. Мы поставим её на карту.\n\n"
    "Нажмите «{button}», чтобы начать."
)

ASK_PHOTO = "Пришлите фото ямы."

ASK_LOCATION = (
    "Фото получено. Теперь пришлите геолокацию ямы.\n\n"
    "Нажмите «{button}» или прикрепите точку на карте через скрепку."
)

ASK_PHOTO_AFTER_LOCATION = "Геолокация получена. Теперь пришлите фото ямы."

CANCELLED = "Отменено. Ничего не отправлено."

NOTHING_TO_CANCEL = "Сейчас нечего отменять."

# Sent when a report creates a new marker nobody has confirmed yet.
SAVED_NEW = (
    "Спасибо. Яма добавлена на карту как <b>неподтверждённая</b>.\n\n"
    "Она станет подтверждённой, когда о ней сообщат ещё {remaining} чел. "
    "или её увидит наша камера."
)

# Sent when the report joined a pothole that is already on the map.
SAVED_MERGED = (
    "Спасибо. Эта яма уже есть на карте — ваше сообщение добавлено к ней.\n\n"
    "Всего сообщений об этой яме: {sightings}."
)

SAVED_VERIFIED = "Спасибо. Яма <b>подтверждена</b> — о ней сообщили {reporters} чел."

SAVED_ALREADY = "Это сообщение уже было принято."

PHOTO_FAILED = (
    "Сообщение сохранено, но фото загрузить не удалось. "
    "Яма на карте — можно прислать фото ещё раз позже."
)

PHOTO_TOO_BIG = "Фото слишком большое. Пришлите его как фото, а не как файл."

NOT_A_PHOTO = (
    "Нужно фото. Пришлите изображение ямы — документы и видео бот не принимает."
)

LIVE_LOCATION_HINT = (
    "Это ваша текущая геолокация. Если яма не прямо под вами, "
    "прикрепите точку на карте через скрепку."
)

MAP_LINK = "Карта ям: {url}"

UNAVAILABLE = "Бот временно недоступен. Попробуйте позже."


def report_saved(
    *, created: bool, verified: bool, reporters: int, remaining: int, sightings: int
) -> str:
    if verified:
        return SAVED_VERIFIED.format(reporters=reporters)
    if created:
        return SAVED_NEW.format(remaining=max(remaining, 1))
    return SAVED_MERGED.format(sightings=sightings)


def main_keyboard(map_url: str = "") -> dict:
    """The persistent keyboard. One obvious action, because there is one."""
    rows: list[list[dict]] = [[{"text": BUTTON_REPORT}]]
    if map_url:
        rows.append([{"text": BUTTON_MAP}])
    return {"keyboard": rows, "resize_keyboard": True, "is_persistent": True}


def location_keyboard() -> dict:
    """Asks Telegram for the one-tap location button.

    `request_location` sends where the phone IS. That is right for someone standing at
    the pothole and wrong for someone reporting one they passed earlier, which is why
    the accompanying text explains the map-pin alternative rather than assuming.
    """
    return {
        "keyboard": [
            [{"text": BUTTON_LOCATION, "request_location": True}],
            [{"text": BUTTON_CANCEL}],
        ],
        "resize_keyboard": True,
        "one_time_keyboard": True,
    }
