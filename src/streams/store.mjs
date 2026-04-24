import {
  DEFAULT_STREAM,
  EVENT_OUTCOME,
  OWNERSHIP,
  MAX_STREAM_ENTRIES,
  LIFESPAN,
  SOURCE
} from "../consts.mjs";
import {
  normalizeOutcome,
  normalizeOwnership,
  normalizeName,
  normalizeLifespan
} from "../util/normalize.mjs";
import { toText } from "../util/text.mjs";
import { nowIso } from "../util/time.mjs";
import { assertMutable } from "../util/policy.mjs";

export function createSessionInjector(overrides = {}) {
  return {
    enabled: Boolean(overrides.enabled),
    delivery: normalizeOutcome(overrides.delivery, EVENT_OUTCOME.SURFACE),
    lifespan: normalizeLifespan(overrides.scope ?? overrides.lifespan, LIFESPAN.TEMPORARY),
    ownership: normalizeOwnership(overrides.managedBy ?? overrides.ownership, OWNERSHIP.MODEL_OWNED)
  };
}

export function createStreamStore() {
  const streams = new Map();

  function ensure(rawName, description = "") {
    const name = normalizeName(rawName, DEFAULT_STREAM);
    let stream = streams.get(name);

    if (!stream) {
      stream = {
        name,
        description: String(description ?? "").trim(),
        createdAt: nowIso(),
        entries: [],
        sessionInjector: createSessionInjector()
      };
      streams.set(name, stream);
    } else if (description && !stream.description) {
      stream.description = String(description).trim();
    }

    return stream;
  }

  function append(rawStream, entry) {
    const stream = ensure(rawStream);
    const normalizedEntry = {
      timestamp: entry.timestamp ?? nowIso(),
      source: entry.source ?? SOURCE.SYSTEM,
      text: toText(entry.text).trim(),
      monitorName: entry.monitorName ?? null,
      stream: entry.stream ?? null
    };

    if (!normalizedEntry.text) {
      return null;
    }

    stream.entries.push(normalizedEntry);
    if (stream.entries.length > MAX_STREAM_ENTRIES) {
      stream.entries.splice(0, stream.entries.length - MAX_STREAM_ENTRIES);
    }

    return normalizedEntry;
  }

  function get(rawName) {
    return streams.get(normalizeName(rawName));
  }

  function list() {
    return [...streams.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  function size() {
    return streams.size;
  }

  function configureSessionInjector(rawName, options = {}) {
    const stream = ensure(rawName, options.description ?? "");

    assertMutable(stream.sessionInjector.ownership, options.force, `Session injector for stream '${stream.name}'`);

    stream.sessionInjector = createSessionInjector({
      enabled: options.enabled,
      delivery: options.delivery ?? stream.sessionInjector.delivery,
      lifespan: options.scope ?? stream.sessionInjector.lifespan,
      ownership: options.managedBy ?? stream.sessionInjector.ownership
    });

    return stream;
  }

  function applyPersistentStream(entry) {
    const stream = ensure(entry.name, entry.description ?? "");
    const configInjector = entry.sessionInjector ?? entry.subscription ?? {};
    stream.sessionInjector = createSessionInjector({
      enabled: configInjector.enabled === true,
      delivery: configInjector.delivery ?? EVENT_OUTCOME.SURFACE,
      lifespan: LIFESPAN.PERSISTENT,
      ownership: configInjector.ownership ?? configInjector.managedBy ?? OWNERSHIP.USER_OWNED
    });
    return stream;
  }

  return {
    ensure,
    append,
    get,
    list,
    size,
    configureSessionInjector,
    applyPersistentStream
  };
}
