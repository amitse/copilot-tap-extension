import { OWNERSHIP, TERMINAL_EMITTER_STATUSES } from "../consts.mjs";
import { normalizeOwnership } from "./normalize.mjs";

// User-owned entries are treated as protected unless the caller explicitly forces the change.
export function assertMutable(ownership, force, label) {
  if (normalizeOwnership(ownership, OWNERSHIP.MODEL_OWNED) === OWNERSHIP.USER_OWNED && !force) {
    throw new Error(`${label} is user-controlled. Pass force=true only when the user explicitly wants to override it.`);
  }
}

export function isTerminalEmitterStatus(status) {
  return TERMINAL_EMITTER_STATUSES.includes(status);
}
