import { EVENT_OUTCOME, OWNERSHIP, LIFESPAN } from "../consts.mjs";

export function normalizeName(value, fallback = "") {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || fallback;
}

export function normalizeLifespan(value, fallback = LIFESPAN.TEMPORARY) {
  return String(value ?? fallback).trim().toLowerCase() === LIFESPAN.PERSISTENT
    ? LIFESPAN.PERSISTENT
    : LIFESPAN.TEMPORARY;
}

export function normalizeOwnership(value, fallback = OWNERSHIP.MODEL_OWNED) {
  return String(value ?? fallback).trim().toLowerCase() === OWNERSHIP.USER_OWNED
    ? OWNERSHIP.USER_OWNED
    : OWNERSHIP.MODEL_OWNED;
}

export function normalizeOutcome(value, fallback = EVENT_OUTCOME.SURFACE) {
  return String(value ?? fallback).trim().toLowerCase() === EVENT_OUTCOME.DROP
    ? EVENT_OUTCOME.DROP
    : fallback;
}
