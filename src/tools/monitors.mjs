import { EVENT_OUTCOME, OWNERSHIP, LIFESPAN } from "../consts.mjs";
import { normalizeName } from "../util/normalize.mjs";
import { formatEventFilter } from "../format/event-filter.mjs";
import { formatConfiguredEmitter, formatRunningEmitter } from "../format/emitter.mjs";

function renderEmitterList(streams, configStore, supervisor) {
  const running = supervisor.list();
  const configured = configStore
    .getEmitters()
    .filter((entry) => !supervisor.has(entry.name))
    .sort((left, right) => normalizeName(left.name).localeCompare(normalizeName(right.name)));

  if (running.length === 0 && configured.length === 0) {
    return "No emitters have been defined for this session.";
  }

  return [
    `Session emitters (${running.length}):`,
    ...(running.length > 0
      ? running.map((emitter) => formatRunningEmitter(emitter, streams.ensure(emitter.stream)))
      : ["- <none>"]),
    "",
    `Persistent emitter definitions (${configured.length}):`,
    ...(configured.length > 0 ? configured.map((entry) => formatConfiguredEmitter(entry)) : ["- <none>"])
  ].join("\n");
}

export function createEmitterTools({ streams, configStore, supervisor, getBaseCwd }) {
  return [
    {
      name: "tap_list_emitters",
      description: "Lists session event emitters, their run schedules, and persistent definitions.",
      handler: async () => renderEmitterList(streams, configStore, supervisor)
    },
    {
      name: "tap_start_emitter",
      description: "Starts a command emitter, prompt emitter, or timed work item with event filter rules and optional session injector.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Unique emitter name." },
          command: { type: "string", description: "Shell command to run. Optional when prompt is provided." },
          prompt: { type: "string", description: "Prompt to send to the agent. Optional when command is provided." },
          description: { type: "string", description: "Short summary." },
          channel: { type: "string", description: "EventStream to receive accepted events." },
          cwd: { type: "string", description: "Optional working directory relative to the session cwd." },
          every: { type: "string", description: "Optional repeat interval like 30s, 5m, 2h, or 1d. When omitted, commands run continuously and prompts run once." },
          scope: { type: "string", description: "Use 'temporary' for session-only or 'persistent' to write config." },
          managedBy: { type: "string", description: "Ownership label: 'userOwned' or 'modelOwned'." },
          autoStart: { type: "boolean", description: "When persistent, whether the emitter should auto-start next session." },
          includeStderr: { type: "boolean", description: "Whether stderr lines are eligible for event outcome evaluation." },
          includePattern: { type: "string", description: "Only matching lines are admitted into the stream. (Legacy: prefer eventFilter rules.)" },
          excludePattern: { type: "string", description: "Matching lines are dropped before they reach the stream. (Legacy: prefer eventFilter rules.)" },
          notifyPattern: { type: "string", description: "Matching lines trigger session injection when delivery='important'. (Legacy: prefer eventFilter rules.)" },
          subscribe: { type: "boolean", description: "Whether to attach a session injector to the stream as part of emitter creation." },
          delivery: { type: "string", description: "Session injector event outcome mode: 'important' or 'all'." },
          force: { type: "boolean", description: "Required only when transferring ownership of a protected emitter." }
        },
        required: ["name"]
      },
      handler: async (args) => {
        const lifespan = args.scope ?? LIFESPAN.TEMPORARY;
        const ownership = args.managedBy ?? OWNERSHIP.MODEL_OWNED;
        const emitter = await supervisor.start(
          { ...args, scope: lifespan, managedBy: ownership },
          {
            baseCwd: getBaseCwd(),
            scope: lifespan,
            managedBy: ownership,
            subscribe: args.subscribe !== false,
            delivery: args.delivery ?? EVENT_OUTCOME.SURFACE,
            force: args.force === true
          }
        );

        return [
          `Started emitter '${emitter.name}'.`,
          `lifespan=${emitter.scope}`,
          `ownership=${emitter.managedBy}`,
          `emitterType=${emitter.workType}`,
          `runSchedule=${emitter.executionMode}`,
          emitter.every ? `every=${emitter.every}` : null,
          `stream=${emitter.channel}`,
          `sessionInjector=${streams.ensure(emitter.channel).sessionInjector.enabled ? "on" : "off"}`,
          `eventFilter=${formatEventFilter(emitter.classifier)}`
        ]
          .filter(Boolean)
          .join("\n");
      }
    },
    {
      name: "tap_set_event_filter",
      description: "Updates the event filter rules that determine event outcomes (drop, keep, surface, inject) for an emitter.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Emitter name." },
          includePattern: { type: "string", description: "Only matching lines are admitted into the stream." },
          excludePattern: { type: "string", description: "Matching lines are removed from the stream." },
          notifyPattern: { type: "string", description: "Matching lines trigger session injection when delivery='important'." },
          scope: { type: "string", description: "Use 'temporary' for session-only or 'persistent' to write config." },
          managedBy: { type: "string", description: "Ownership label: 'userOwned' or 'modelOwned'." },
          force: { type: "boolean", description: "Required only when transferring ownership of a protected emitter." }
        },
        required: ["name"]
      },
      handler: async (args) => {
        const result = supervisor.updateClassifier(args.name, args, {
          scope: args.scope ?? LIFESPAN.TEMPORARY,
          managedBy: args.managedBy ?? OWNERSHIP.MODEL_OWNED,
          force: args.force === true
        });

        const eventFilter = result.classifier ?? supervisor.get(args.name)?.classifier;
        return `Updated event filter for emitter '${normalizeName(args.name)}': ${formatEventFilter(eventFilter)}`;
      }
    },
    {
      name: "tap_stop_emitter",
      description: "Stops a running event emitter. With lifespan='persistent', also removes the stored definition from config.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Emitter name." },
          scope: { type: "string", description: "Use 'temporary' or 'persistent'." },
          force: { type: "boolean", description: "Required only when transferring ownership of a protected emitter." }
        },
        required: ["name"]
      },
      handler: async (args) => {
        const result = await supervisor.stop(args.name, {
          scope: args.scope ?? LIFESPAN.TEMPORARY,
          force: args.force === true
        });

        return `Stop requested for emitter '${normalizeName(args.name)}' (status=${result.status}).`;
      }
    }
  ];
}
