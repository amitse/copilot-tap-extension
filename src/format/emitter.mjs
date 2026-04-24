import { OWNERSHIP, LIFESPAN, EMITTER_TYPE, RUN_SCHEDULE } from "../consts.mjs";
import { normalizeOwnership, normalizeName } from "../util/normalize.mjs";
import { previewText } from "../util/text.mjs";
import { createEventFilter, formatEventFilter, getEventFilterInput } from "./event-filter.mjs";

export function describeEmitterWork(emitter) {
  if (emitter.command) {
    return `command=${emitter.command}`;
  }

  return `prompt=${JSON.stringify(previewText(emitter.prompt, 90))}`;
}

export function formatRunningEmitter(emitter, stream) {
  return [
    `- ${emitter.name}:`,
    `  status=${emitter.status}`,
    `  scope=${emitter.scope}`,
    `  managedBy=${emitter.managedBy}`,
    `  emitterType=${emitter.emitterType}`,
    `  runSchedule=${emitter.runSchedule}`,
    `  stream=${emitter.channel}`,
    `  sessionInjector=${stream?.sessionInjector?.enabled ? "on" : "off"}`,
    `  cwd=${emitter.cwd}`,
    `  ${describeEmitterWork(emitter)}`,
    emitter.every ? `  every=${emitter.every}` : null,
    `  autoStart=${emitter.autoStart}`,
    `  includeStderr=${emitter.includeStderr}`,
    `  runs=${emitter.runCount}`,
    `  acceptedLines=${emitter.lineCount}`,
    `  droppedLines=${emitter.droppedLineCount}`,
    `  eventFilter=${formatEventFilter(emitter.eventFilter)}`,
    emitter.description ? `  description=${emitter.description}` : null,
    emitter.lastRunAt ? `  lastRunAt=${emitter.lastRunAt}` : null,
    emitter.lastRunStatus ? `  lastRunStatus=${emitter.lastRunStatus}` : null,
    emitter.exitCode !== null && emitter.exitCode !== undefined ? `  exitCode=${emitter.exitCode}` : null
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatConfiguredEmitter(entry) {
  const eventFilter = createEventFilter(
    getEventFilterInput(entry),
    entry.eventFilter?.managedBy ?? entry.classifier?.managedBy ?? entry.managedBy ?? OWNERSHIP.USER_OWNED,
    LIFESPAN.PERSISTENT
  );
  const prompt = entry.prompt ? `  prompt=${JSON.stringify(previewText(entry.prompt, 90))}` : null;
  const command = entry.command ? `  command=${entry.command}` : null;
  const every = entry.every ? `  every=${entry.every}` : null;
  const emitterType = entry.prompt ? EMITTER_TYPE.PROMPT : EMITTER_TYPE.COMMAND;
  const runSchedule = entry.every
    ? RUN_SCHEDULE.TIMED
    : entry.prompt
      ? RUN_SCHEDULE.ONE_TIME
      : RUN_SCHEDULE.CONTINUOUS;
  return [
    `- ${normalizeName(entry.name)}:`,
    "  status=configured",
    `  scope=${LIFESPAN.PERSISTENT}`,
    `  managedBy=${normalizeOwnership(entry.managedBy, OWNERSHIP.USER_OWNED)}`,
    `  emitterType=${emitterType}`,
    `  runSchedule=${runSchedule}`,
    `  stream=${normalizeName(entry.channel, normalizeName(entry.name))}`,
    `  autoStart=${entry.autoStart !== false}`,
    `  includeStderr=${entry.includeStderr !== false}`,
    entry.cwd ? `  cwd=${entry.cwd}` : null,
    command,
    prompt,
    every,
    `  eventFilter=${formatEventFilter(eventFilter)}`,
    entry.description ? `  description=${entry.description}` : null
  ]
    .filter(Boolean)
    .join("\n");
}
