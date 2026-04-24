import { EVENT_OUTCOME, EMITTER_OPERATION_STATUS, EMITTER_STATUS, LIFESPAN, OWNERSHIP } from "../consts.mjs";
import { normalizeName, normalizeLifespan, normalizeOwnership } from "../util/normalize.mjs";
import { assertMutable, isTerminalEmitterStatus } from "../util/policy.mjs";
import { createEventFilter, formatEventFilter } from "../format/event-filter.mjs";
import { buildEmitterState } from "./state.mjs";
import { createLineRouter } from "./line-router.mjs";
import { createLifecycle } from "./lifecycle.mjs";

export function createEmitterSupervisor({ streams, configStore, notifications, sessionPort, getBaseCwd, persist }) {
  const emitters = new Map();
  const lineRouter = createLineRouter({ streams, notifications });
  const lifecycle = createLifecycle({ lineRouter, sessionPort });

  async function start(spec, options = {}) {
    const baseCwd = options.baseCwd ?? getBaseCwd();
    const emitter = buildEmitterState(spec, baseCwd, options);
    const existing = emitters.get(emitter.name);

    if (existing && !isTerminalEmitterStatus(existing.status)) {
      throw new Error(`Emitter '${emitter.name}' is already active.`);
    }
    if (existing) {
      assertMutable(existing.ownership, options.force, `Emitter '${emitter.name}'`);
    }

    streams.ensure(emitter.stream, emitter.description || `Events for ${emitter.name}`);
    emitters.set(emitter.name, emitter);

    try {
      lifecycle.start(emitter);
    } catch (error) {
      emitters.delete(emitter.name);
      throw error;
    }

    if (options.subscribe === true) {
      const stream = streams.configureSessionInjector(emitter.stream, {
        enabled: true,
        delivery: options.delivery ?? EVENT_OUTCOME.SURFACE,
        scope: options.scope ?? emitter.lifespan,
        managedBy: options.managedBy ?? emitter.ownership,
        description: spec.channelDescription ?? emitter.description,
        force: options.force
      });

      void sessionPort.log(
        `${stream.sessionInjector.enabled ? "Subscribed" : "Unsubscribed"} stream '${stream.name}' with delivery=${stream.sessionInjector.delivery} lifespan=${stream.sessionInjector.lifespan} ownership=${stream.sessionInjector.ownership}.`
      );

      if (stream.sessionInjector.lifespan === LIFESPAN.PERSISTENT) {
        configStore.upsertStream(stream);
      }
    }

    if (emitter.lifespan === LIFESPAN.PERSISTENT) {
      configStore.upsertEmitter(emitter);
      persist();
    } else if (options.subscribe === true && streams.ensure(emitter.stream).sessionInjector.lifespan === LIFESPAN.PERSISTENT) {
      persist();
    }

    await sessionPort.log(
      `Started emitter '${emitter.name}' (${emitter.emitterType}, ${emitter.runSchedule}) on stream '${emitter.stream}' in ${emitter.cwd}.`
    );
    return emitter;
  }

  async function stop(name, options = {}) {
    const normalized = normalizeName(name);
    const lifespan = normalizeLifespan(options.scope, LIFESPAN.TEMPORARY);
    const emitter = emitters.get(normalized);

    if (emitter) {
      assertMutable(emitter.ownership, options.force, `Emitter '${normalized}'`);
      await lifecycle.stop(emitter);
    }

    if (lifespan === LIFESPAN.PERSISTENT) {
      const removed = configStore.removeEmitter(normalized, options.force);
      if (removed) {
        persist();
        void sessionPort.log(`Removed persistent emitter '${normalized}' from config.`);
      }

      if (!emitter && !removed) {
        throw new Error(`Emitter '${normalized}' was not found in the session or persistent config.`);
      }

      return {
        name: normalized,
        status: removed ? EMITTER_OPERATION_STATUS.REMOVED_FROM_CONFIG : emitter?.status ?? EMITTER_STATUS.STOPPED
      };
    }

    if (!emitter) {
      throw new Error(`Emitter '${normalized}' is not running in this session.`);
    }

    return emitter;
  }

  function updateEventFilter(name, input, options = {}) {
    const normalized = normalizeName(name);
    const lifespan = normalizeLifespan(options.scope, LIFESPAN.TEMPORARY);
    const ownership = normalizeOwnership(options.managedBy, OWNERSHIP.MODEL_OWNED);
    const emitter = emitters.get(normalized);
    const configEntry = configStore.findEmitter(normalized);

    if (emitter) {
      assertMutable(emitter.eventFilter.managedBy, options.force, `Event filter for emitter '${normalized}'`);
      emitter.eventFilter = createEventFilter(
        {
          includePattern: input.includePattern ?? emitter.eventFilter.includePattern,
          excludePattern: input.excludePattern ?? emitter.eventFilter.excludePattern,
          notifyPattern: input.notifyPattern ?? emitter.eventFilter.notifyPattern,
          managedBy: options.managedBy ?? emitter.eventFilter.managedBy,
          scope: lifespan
        },
        ownership,
        lifespan
      );

      if (lifespan === LIFESPAN.PERSISTENT) {
        emitter.lifespan = LIFESPAN.PERSISTENT;
        configStore.upsertEmitter(emitter);
        persist();
      }

      void sessionPort.log(`Updated event filter for emitter '${normalized}': ${formatEventFilter(emitter.eventFilter)}`);

      return emitter;
    }

    if (lifespan !== LIFESPAN.PERSISTENT || !configEntry) {
      throw new Error(`Emitter '${normalized}' is not running, so only a persistent event filter update is possible when it exists in config.`);
    }

    assertMutable(
      normalizeOwnership(configEntry.eventFilter?.managedBy ?? configEntry.classifier?.managedBy ?? configEntry.managedBy, OWNERSHIP.USER_OWNED),
      options.force,
      `Event filter for emitter '${normalized}'`
    );

    configEntry.eventFilter = {
      includePattern: input.includePattern ?? configEntry.eventFilter?.includePattern ?? configEntry.classifier?.includePattern,
      excludePattern: input.excludePattern ?? configEntry.eventFilter?.excludePattern ?? configEntry.classifier?.excludePattern,
      notifyPattern: input.notifyPattern ?? configEntry.eventFilter?.notifyPattern ?? configEntry.classifier?.notifyPattern,
      managedBy: ownership
    };

    persist();
    void sessionPort.log(`Updated persistent event filter for emitter '${normalized}': ${formatEventFilter(configEntry.eventFilter)}`);
    return {
      name: normalized,
      status: EMITTER_OPERATION_STATUS.CONFIGURED,
      eventFilter: createEventFilter(configEntry.eventFilter, ownership, LIFESPAN.PERSISTENT)
    };
  }

  async function stopAll() {
    const active = [...emitters.values()].filter((emitter) => !isTerminalEmitterStatus(emitter.status));
    await Promise.allSettled(active.map((emitter) => lifecycle.stop(emitter)));
  }

  function list() {
    return [...emitters.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  function has(name) {
    return emitters.has(normalizeName(name));
  }

  function get(name) {
    return emitters.get(normalizeName(name));
  }

  return {
    start,
    stop,
    stopAll,
    updateEventFilter,
    list,
    has,
    get
  };
}
