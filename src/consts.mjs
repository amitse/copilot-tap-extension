import path from "node:path";

export const GITHUB_DIR = ".github";
export const CONFIG_FILENAME = "tap.config.json";
export const CONFIG_LOCATIONS = [
  CONFIG_FILENAME,
  `${GITHUB_DIR}${path.sep}${CONFIG_FILENAME}`
];
export const COPILOT_INSTRUCTIONS_PATH = "src/copilot-instructions.md";

export const MAX_STREAM_ENTRIES = 200;
export const DEFAULT_STREAM = "main";
export const DEFAULT_STREAM_DESCRIPTION = "Extension events";

export const RUN_INTERVAL_PATTERN =
  /^\s*(?:every\s+)?(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\s*$/i;

export const NOTIFICATION_BATCH_SIZE = 4;

export const BRAND = "※ tap";
export const LOG_PREFIX = `${BRAND}:`;

export const LIFESPAN = Object.freeze({
  TEMPORARY: "temporary",
  PERSISTENT: "persistent"
});

export const OWNERSHIP = Object.freeze({
  USER_OWNED: "userOwned",
  MODEL_OWNED: "modelOwned"
});

export const EVENT_OUTCOME = Object.freeze({
  DROP: "drop",
  KEEP: "keep",
  SURFACE: "surface",
  INJECT: "inject"
});

export const EMITTER_TYPE = Object.freeze({
  COMMAND: "command",
  PROMPT: "prompt"
});

export const RUN_SCHEDULE = Object.freeze({
  CONTINUOUS: "continuous",
  TIMED: "timed",
  ONE_TIME: "oneTime",
  IDLE: "idle"
});

export const IDLE_PROMPT_DELAY_MS = 2000;
export const IDLE_PROMPT_BACKOFF_MS = 5000;

export const EMITTER_STATUS = Object.freeze({
  QUEUED: "queued",
  WAITING: "waiting",
  RUNNING: "running",
  STOPPING: "stopping",
  STOPPED: "stopped",
  EXITED: "exited",
  COMPLETED: "completed",
  ERROR: "error"
});

export const RUN_STATUS = Object.freeze({
  SUCCESS: "success",
  FAILURE: "failure"
});

export const EMITTER_OPERATION_STATUS = Object.freeze({
  REMOVED_FROM_CONFIG: "removed-from-config",
  CONFIGURED: "configured"
});

export const TERMINAL_EMITTER_STATUSES = Object.freeze([
  EMITTER_STATUS.STOPPED,
  EMITTER_STATUS.EXITED,
  EMITTER_STATUS.COMPLETED,
  EMITTER_STATUS.ERROR
]);

export const STREAM = Object.freeze({
  STDOUT: "stdout",
  STDERR: "stderr",
  PROMPT: "prompt",
  SYSTEM: "system"
});

export const SOURCE = Object.freeze({
  SYSTEM: "system",
  TOOL: "tool",
  EMITTER: "emitter",
  EMITTER_STDERR: "emitter:stderr",
  EMITTER_PROMPT: "emitter:prompt"
});
