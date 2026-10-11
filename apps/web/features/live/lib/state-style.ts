import type { PublicState } from "@/lib/public-api";

/**
 * Colour by VERIFICATION STATE, for the public map only.
 *
 * A different scale from `SEVERITY_COLOUR` in the internal map, and deliberately so. The
 * two answer different questions - severity is how bad the defect is, state is whether
 * anyone has confirmed it and whether it has been repaired - and a public visitor cares
 * about the second. Reusing one colour for both would give it two meanings.
 *
 * Values mirror the tokens in `app/globals.css`; MapLibre paints into a canvas and cannot
 * read a CSS custom property, so the hex has to be repeated here. Change both together.
 */
export const STATE_COLOUR: Record<PublicState, string> = {
  unverified: "#9b86d9",
  confirmed: "#db7979",
  fixed: "#68bf9b",
};

export const STATE_LABEL: Record<PublicState, string> = {
  unverified: "Ждёт подтверждения",
  confirmed: "Подтверждена",
  fixed: "Отремонтирована",
};

/** The order the legend and the summary read in: least to most resolved. */
export const STATE_ORDER: PublicState[] = ["unverified", "confirmed", "fixed"];

/** MapLibre data-driven colour expression over the `state` property. */
export const STATE_COLOUR_EXPRESSION = [
  "match",
  ["get", "state"],
  "unverified",
  STATE_COLOUR.unverified,
  "confirmed",
  STATE_COLOUR.confirmed,
  "fixed",
  STATE_COLOUR.fixed,
  STATE_COLOUR.unverified,
];

/**
 * Repaired potholes recede.
 *
 * They stay on the map because "this was fixed" is the most useful thing a repair map can
 * show, but a solved problem must not compete for attention with an open one.
 */
export const STATE_OPACITY_EXPRESSION = [
  "match",
  ["get", "state"],
  "fixed",
  0.55,
  0.92,
];
