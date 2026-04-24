import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { CONFIG_FILENAME, CONFIG_LOCATIONS, OWNERSHIP, LIFESPAN } from "../consts.mjs";
import { normalizeOwnership, normalizeName } from "../util/normalize.mjs";
import { assertMutable } from "../util/policy.mjs";

function emptyConfig() {
  return { streams: [], emitters: [] };
}

function ensureShape(config) {
  if (!config || typeof config !== "object") {
    return emptyConfig();
  }
  if (!Array.isArray(config.streams)) {
    config.streams = [];
  }
  if (!Array.isArray(config.emitters)) {
    config.emitters = [];
  }
  return config;
}

export function serializeStream(stream) {
  const entry = { name: stream.name };

  if (stream.description) {
    entry.description = stream.description;
  }

  if (stream.sessionInjector.lifespan === LIFESPAN.PERSISTENT || stream.sessionInjector.enabled) {
    entry.sessionInjector = {
      enabled: stream.sessionInjector.enabled,
      delivery: stream.sessionInjector.delivery,
      ownership: stream.sessionInjector.ownership
    };
  }

  return entry;
}

export function serializeEmitter(emitter) {
  const entry = {
    name: emitter.name,
    stream: emitter.channel,
    autoStart: emitter.autoStart,
    includeStderr: emitter.includeStderr,
    ownership: emitter.managedBy
  };

  if (emitter.command) {
    entry.command = emitter.command;
  }
  if (emitter.prompt) {
    entry.prompt = emitter.prompt;
  }
  if (emitter.every) {
    entry.every = emitter.every;
  }
  if (emitter.description) {
    entry.description = emitter.description;
  }
  if (emitter.requestedCwd) {
    entry.cwd = emitter.requestedCwd;
  }

  entry.eventFilter = {};
  if (emitter.classifier.includePattern) {
    entry.eventFilter.includePattern = emitter.classifier.includePattern;
  }
  if (emitter.classifier.excludePattern) {
    entry.eventFilter.excludePattern = emitter.classifier.excludePattern;
  }
  if (emitter.classifier.notifyPattern) {
    entry.eventFilter.notifyPattern = emitter.classifier.notifyPattern;
  }
  if (emitter.classifier.managedBy !== emitter.managedBy) {
    entry.eventFilter.ownership = emitter.classifier.managedBy;
  }
  if (Object.keys(entry.eventFilter).length === 0) {
    delete entry.eventFilter;
  }

  return entry;
}

export function createConfigStore(options = {}) {
  const fs = options.fs ?? { existsSync, readFileSync, writeFileSync };
  const state = {
    cwd: options.cwd ?? process.cwd(),
    filePath: null,
    config: emptyConfig()
  };

  function defaultPath(baseCwd) {
    return path.join(baseCwd, CONFIG_FILENAME);
  }

  function load(baseCwd) {
    state.cwd = baseCwd;
    state.filePath = defaultPath(baseCwd);
    state.config = emptyConfig();

    for (const relativePath of CONFIG_LOCATIONS) {
      const filePath = path.join(baseCwd, relativePath);
      if (!fs.existsSync(filePath)) {
        continue;
      }

      state.filePath = filePath;
      state.config = ensureShape(JSON.parse(fs.readFileSync(filePath, "utf8")));
      return { found: true, filePath };
    }

    ensureShape(state.config);
    return { found: false, filePath: state.filePath };
  }

  function save() {
    ensureShape(state.config);
    if (!state.filePath) {
      state.filePath = defaultPath(state.cwd);
    }

    const payload = {
      streams: [...state.config.streams].sort((left, right) =>
        normalizeName(left.name).localeCompare(normalizeName(right.name))
      ),
      emitters: [...state.config.emitters].sort((left, right) =>
        normalizeName(left.name).localeCompare(normalizeName(right.name))
      )
    };

    fs.writeFileSync(state.filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  function findStreamIndex(name) {
    return state.config.streams.findIndex((stream) => normalizeName(stream.name) === name);
  }

  function findEmitterIndex(name) {
    return state.config.emitters.findIndex((emitter) => normalizeName(emitter.name) === name);
  }

  function upsertStream(stream) {
    ensureShape(state.config);
    const entry = serializeStream(stream);
    const index = findStreamIndex(stream.name);

    if (index === -1) {
      state.config.streams.push(entry);
    } else {
      state.config.streams[index] = entry;
    }
  }

  function upsertEmitter(emitter) {
    ensureShape(state.config);
    const entry = serializeEmitter(emitter);
    const index = findEmitterIndex(emitter.name);

    if (index === -1) {
      state.config.emitters.push(entry);
    } else {
      state.config.emitters[index] = entry;
    }
  }

  function removeEmitter(name, force = false) {
    const normalized = normalizeName(name);
    const index = findEmitterIndex(normalized);
    if (index === -1) {
      return false;
    }

    const entry = state.config.emitters[index];
    assertMutable(normalizeOwnership(entry.ownership, OWNERSHIP.USER_OWNED), force, `Emitter '${normalized}'`);
    state.config.emitters.splice(index, 1);
    return true;
  }

  function getStreams() {
    ensureShape(state.config);
    return state.config.streams;
  }

  function getEmitters() {
    ensureShape(state.config);
    return state.config.emitters;
  }

  function findEmitter(name) {
    const index = findEmitterIndex(normalizeName(name));
    return index === -1 ? null : state.config.emitters[index];
  }

  function getPath() {
    return state.filePath;
  }

  function getCwd() {
    return state.cwd;
  }

  return {
    load,
    save,
    upsertStream,
    upsertEmitter,
    removeEmitter,
    getStreams,
    getEmitters,
    findEmitter,
    getPath,
    getCwd
  };
}
