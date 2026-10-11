"use client";

import { useSyncExternalStore } from "react";

/**
 * Access to the Telegram Mini App bridge, when there is one.
 *
 * The same pages run in two places: an ordinary browser, where none of this exists, and
 * inside Telegram, where `window.Telegram.WebApp` is injected. Every helper here answers
 * "are we in Telegram" honestly rather than assuming, because the browser case is not a
 * degraded mode - it is how most people will see the map.
 *
 * Typed by hand instead of pulling `@twa-dev/sdk`: what is used here is four properties
 * and three methods, and a dependency that ships its own polyfills would cost more than
 * it saves.
 */

type ThemeParams = {
  bg_color?: string;
  text_color?: string;
  hint_color?: string;
  button_color?: string;
  button_text_color?: string;
  secondary_bg_color?: string;
};

type TelegramWebApp = {
  initData: string;
  initDataUnsafe?: { user?: { id: number; first_name?: string; username?: string } };
  colorScheme?: "light" | "dark";
  themeParams?: ThemeParams;
  version?: string;
  ready: () => void;
  expand: () => void;
  close: () => void;
  HapticFeedback?: {
    notificationOccurred?: (type: "error" | "success" | "warning") => void;
  };
  MainButton?: {
    setText: (text: string) => void;
    show: () => void;
    hide: () => void;
    enable: () => void;
    disable: () => void;
    showProgress: (leaveActive?: boolean) => void;
    hideProgress: () => void;
    onClick: (handler: () => void) => void;
    offClick: (handler: () => void) => void;
  };
};

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

/**
 * Whether this page is running inside Telegram, as an external store.
 *
 * `window.Telegram` is exactly what `useSyncExternalStore` is for: a value that lives
 * outside React, is absent during server rendering, and never changes afterwards.
 * Reading it in an effect and calling setState would work, but it renders the page once
 * as "not Telegram" and then again as "Telegram" - a visible flip on the report screen,
 * where the two states show completely different content.
 */
export function useIsTelegramMiniApp(): boolean {
  return useSyncExternalStore(subscribeNever, isTelegramMiniApp, () => false);
}

/** The bridge is injected before our code runs and never withdrawn, so nothing changes. */
function subscribeNever(): () => void {
  return () => {};
}

export function telegramWebApp(): TelegramWebApp | null {
  if (typeof window === "undefined") return null;
  return window.Telegram?.WebApp ?? null;
}

/**
 * Whether this page is running inside Telegram with a usable identity.
 *
 * The bridge object alone is not enough: Telegram injects it for pages opened outside a
 * Mini App context too, where `initData` is empty and nothing can be signed. Reporting is
 * gated on the signature, so that is what gets checked.
 */
export function isTelegramMiniApp(): boolean {
  const app = telegramWebApp();
  return Boolean(app && app.initData);
}

export function telegramInitData(): string | null {
  return telegramWebApp()?.initData || null;
}

/** Tell Telegram the page has painted, and take the full sheet height. */
export function readyForTelegram(): void {
  const app = telegramWebApp();
  if (!app) return;
  try {
    app.ready();
    app.expand();
  } catch {
    // An older Telegram client missing a method must not take the page down with it:
    // the page works without the bridge, it just looks less native.
  }
}
