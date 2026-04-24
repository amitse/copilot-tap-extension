import { RUN_INTERVAL_PATTERN } from "../consts.mjs";

export function nowIso() {
  return new Date().toISOString();
}

export function parseLoopInterval(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }

  const match = String(value).trim().match(RUN_INTERVAL_PATTERN);
  if (!match) {
    throw new Error(`Invalid every interval '${value}'. Use values like 30s, 5m, 2h, or 1d.`);
  }

  const amount = Number.parseInt(match[1], 10);
  if (Number.isNaN(amount) || amount < 1) {
    throw new Error(`Invalid every interval '${value}'. The number must be 1 or greater.`);
  }

  const unitToken = match[2].toLowerCase();
  let unit = "m";
  let multiplier = 60 * 1000;

  if (unitToken.startsWith("s")) {
    unit = "s";
    multiplier = 1000;
  } else if (unitToken.startsWith("h")) {
    unit = "h";
    multiplier = 60 * 60 * 1000;
  } else if (unitToken.startsWith("d")) {
    unit = "d";
    multiplier = 24 * 60 * 60 * 1000;
  }

  return {
    text: `${amount}${unit}`,
    ms: amount * multiplier
  };
}
