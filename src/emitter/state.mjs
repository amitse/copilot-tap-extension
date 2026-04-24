import {
  EMITTER_STATUS,
  EMITTER_TYPE,
  LIFESPAN,
  OWNERSHIP,
  RUN_SCHEDULE
} from "../consts.mjs";
import {
  normalizeName,
  normalizeLifespan,
  normalizeOwnership
} from "../util/normalize.mjs";
import { nowIso, parseLoopInterval } from "../util/time.mjs";
import { resolveRequestedCwd } from "../util/path.mjs";
import { createEventFilter, getEventFilterInput } from "../format/event-filter.mjs";

export function buildEmitterState(spec, baseCwd, defaults = {}) {
  const name = normalizeName(spec.name);
  if (!name) {
    throw new Error("Emitter name is required.");
  }
  const command = String(spec.command ?? "").trim();
  const prompt = String(spec.prompt ?? "").trim();
  if (!command && !prompt) {
    throw new Error(`Emitter '${name}' must define either a command or a prompt.`);
  }
  if (command && prompt) {
    throw new Error(`Emitter '${name}' cannot define both command and prompt. Choose one emitter type.`);
  }

  const interval = parseLoopInterval(spec.every);
  const lifespan = normalizeLifespan(spec.scope, defaults.scope ?? LIFESPAN.TEMPORARY);
  const ownership = normalizeOwnership(spec.managedBy, defaults.managedBy ?? OWNERSHIP.MODEL_OWNED);
  const eventFilter = createEventFilter(
    getEventFilterInput(spec),
    spec.classifier?.managedBy ?? ownership,
    lifespan
  );
  const emitterType = prompt ? EMITTER_TYPE.PROMPT : EMITTER_TYPE.COMMAND;

  let runSchedule;
  if (interval?.idle) {
    if (!prompt) {
      throw new Error(`Emitter '${name}': every='idle' is only valid for prompt emitters, not command emitters.`);
    }
    runSchedule = RUN_SCHEDULE.IDLE;
  } else if (interval) {
    runSchedule = RUN_SCHEDULE.TIMED;
  } else if (prompt) {
    runSchedule = RUN_SCHEDULE.ONE_TIME;
  } else {
    runSchedule = RUN_SCHEDULE.CONTINUOUS;
  }

  const maxRuns = spec.maxRuns != null ? Math.max(1, Math.floor(Number(spec.maxRuns))) : null;

  return {
    name,
    description: String(spec.description ?? "").trim(),
    command: command || null,
    prompt: prompt || null,
    emitterType,
    runSchedule,
    every: interval?.text ?? null,
    everyMs: interval?.ms ?? null,
    requestedCwd: spec.cwd ?? null,
    cwd: resolveRequestedCwd(baseCwd, spec.cwd),
    stream: normalizeName(spec.channel, name),
    autoStart: spec.autoStart !== false,
    includeStderr: spec.includeStderr !== false,
    lifespan,
    ownership,
    eventFilter,
    maxRuns,
    startedAt: nowIso(),
    stoppedAt: null,
    lineCount: 0,
    droppedLineCount: 0,
    status: runSchedule === RUN_SCHEDULE.CONTINUOUS ? EMITTER_STATUS.RUNNING : EMITTER_STATUS.QUEUED,
    stopRequested: false,
    timer: null,
    inFlight: false,
    runCount: 0,
    lastRunAt: null,
    lastRunStatus: null,
    process: null,
    stdoutReader: null,
    stderrReader: null,
    exitCode: null
  };
}
