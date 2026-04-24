import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";

import { joinSession } from "@github/copilot-sdk/extension";

const CONFIG_FILENAME = "copilot-channels.config.json";
const CONFIG_LOCATIONS = [
  CONFIG_FILENAME,
  `.github${path.sep}${CONFIG_FILENAME}`
];
const MAX_CHANNEL_ENTRIES = 200;
const DEFAULT_CHANNEL = "main";
const DEFAULT_NOTIFY_PATTERN = /\b(error|warn|warning|fail|failed|healthy|ready|success|changed)\b/i;

const channels = new Map();
const monitors = new Map();
const notificationQueue = [];

const runtimeState = {
  cwd: process.cwd(),
  configPath: null,
  config: { channels: [], monitors: [] }
};

let notificationInFlight = false;
let session;

function nowIso() {
  return new Date().toISOString();
}

function normalizeName(value, fallback = "") {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || fallback;
}

function normalizeScope(value, fallback = "temporary") {
  return String(value ?? fallback).trim().toLowerCase() === "persistent" ? "persistent" : "temporary";
}

function normalizeManagedBy(value, fallback = "model") {
  return String(value ?? fallback).trim().toLowerCase() === "user" ? "user" : "model";
}

function normalizeDelivery(value, fallback = "important") {
  return String(value ?? fallback).trim().toLowerCase() === "all" ? "all" : "important";
}

function clampLimit(value, fallback = 20) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, 1), 100);
}

function toText(value) {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toText(item)).filter(Boolean).join("\n");
  }
  if (value && typeof value === "object") {
    if (typeof value.text === "string") {
      return value.text;
    }
    if (typeof value.content === "string") {
      return value.content;
    }
    return JSON.stringify(value, null, 2);
  }

  return String(value ?? "");
}

function compileRegex(pattern, label) {
  if (pattern === undefined || pattern === null || pattern === "") {
    return null;
  }

  try {
    return new RegExp(String(pattern), "i");
  } catch (error) {
    throw new Error(`Invalid ${label} regex '${pattern}': ${error.message}`);
  }
}

function createSubscription(overrides = {}) {
  return {
    enabled: Boolean(overrides.enabled),
    delivery: normalizeDelivery(overrides.delivery, "important"),
    scope: normalizeScope(overrides.scope, "temporary"),
    managedBy: normalizeManagedBy(overrides.managedBy, "model")
  };
}

function createClassifier(source = {}, fallbackManagedBy = "model", fallbackScope = "temporary") {
  const includePattern = source.includePattern ? String(source.includePattern) : null;
  const excludePattern = source.excludePattern ? String(source.excludePattern) : null;
  const notifyPattern = source.notifyPattern ? String(source.notifyPattern) : null;

  return {
    includePattern,
    includeRegex: compileRegex(includePattern, "includePattern"),
    excludePattern,
    excludeRegex: compileRegex(excludePattern, "excludePattern"),
    notifyPattern,
    notifyRegex: compileRegex(notifyPattern, "notifyPattern"),
    managedBy: normalizeManagedBy(source.managedBy, fallbackManagedBy),
    scope: normalizeScope(source.scope, fallbackScope)
  };
}

function getClassifierInput(source = {}) {
  if (source.classifier && typeof source.classifier === "object") {
    return source.classifier;
  }

  return {
    includePattern: source.includePattern,
    excludePattern: source.excludePattern,
    notifyPattern: source.notifyPattern,
    managedBy: source.classifierManagedBy ?? source.managedBy,
    scope: source.scope
  };
}

function ensureChannel(rawName, description = "") {
  const name = normalizeName(rawName, DEFAULT_CHANNEL);
  let channel = channels.get(name);

  if (!channel) {
    channel = {
      name,
      description: String(description ?? "").trim(),
      createdAt: nowIso(),
      entries: [],
      subscription: createSubscription()
    };
    channels.set(name, channel);
  } else if (description && !channel.description) {
    channel.description = String(description).trim();
  }

  return channel;
}

function appendChannelMessage(rawChannel, entry) {
  const channel = ensureChannel(rawChannel);
  const normalizedEntry = {
    timestamp: entry.timestamp ?? nowIso(),
    source: entry.source ?? "system",
    text: toText(entry.text).trim(),
    monitorName: entry.monitorName ?? null,
    stream: entry.stream ?? null
  };

  if (!normalizedEntry.text) {
    return null;
  }

  channel.entries.push(normalizedEntry);
  if (channel.entries.length > MAX_CHANNEL_ENTRIES) {
    channel.entries.splice(0, channel.entries.length - MAX_CHANNEL_ENTRIES);
  }

  return normalizedEntry;
}

function resolveRequestedCwd(baseCwd, requestedCwd) {
  if (!requestedCwd) {
    return baseCwd;
  }

  return path.resolve(baseCwd, requestedCwd);
}

function findConfigChannelIndex(name) {
  return runtimeState.config.channels.findIndex((channel) => normalizeName(channel.name) === name);
}

function findConfigMonitorIndex(name) {
  return runtimeState.config.monitors.findIndex((monitor) => normalizeName(monitor.name) === name);
}

function defaultConfigPath(baseCwd) {
  return path.join(baseCwd, CONFIG_FILENAME);
}

function ensureConfigShape() {
  if (!runtimeState.config || typeof runtimeState.config !== "object") {
    runtimeState.config = { channels: [], monitors: [] };
  }

  if (!Array.isArray(runtimeState.config.channels)) {
    runtimeState.config.channels = [];
  }

  if (!Array.isArray(runtimeState.config.monitors)) {
    runtimeState.config.monitors = [];
  }
}

function loadConfig(baseCwd) {
  runtimeState.cwd = baseCwd;
  runtimeState.configPath = defaultConfigPath(baseCwd);
  runtimeState.config = { channels: [], monitors: [] };

  for (const relativePath of CONFIG_LOCATIONS) {
    const filePath = path.join(baseCwd, relativePath);
    if (!existsSync(filePath)) {
      continue;
    }

    runtimeState.configPath = filePath;
    runtimeState.config = JSON.parse(readFileSync(filePath, "utf8"));
    ensureConfigShape();
    return { found: true, filePath };
  }

  ensureConfigShape();
  return { found: false, filePath: runtimeState.configPath };
}

function saveConfig() {
  ensureConfigShape();
  if (!runtimeState.configPath) {
    runtimeState.configPath = defaultConfigPath(runtimeState.cwd);
  }

  const payload = {
    channels: [...runtimeState.config.channels].sort((left, right) =>
      normalizeName(left.name).localeCompare(normalizeName(right.name))
    ),
    monitors: [...runtimeState.config.monitors].sort((left, right) =>
      normalizeName(left.name).localeCompare(normalizeName(right.name))
    )
  };

  writeFileSync(runtimeState.configPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function serializeChannel(channel) {
  const entry = {
    name: channel.name
  };

  if (channel.description) {
    entry.description = channel.description;
  }

  if (channel.subscription.scope === "persistent" || channel.subscription.enabled) {
    entry.subscription = {
      enabled: channel.subscription.enabled,
      delivery: channel.subscription.delivery,
      managedBy: channel.subscription.managedBy
    };
  }

  return entry;
}

function serializeMonitor(monitor) {
  const entry = {
    name: monitor.name,
    command: monitor.command,
    channel: monitor.channel,
    autoStart: monitor.autoStart,
    includeStderr: monitor.includeStderr,
    managedBy: monitor.managedBy
  };

  if (monitor.description) {
    entry.description = monitor.description;
  }

  if (monitor.requestedCwd) {
    entry.cwd = monitor.requestedCwd;
  }

  entry.classifier = {};

  if (monitor.classifier.includePattern) {
    entry.classifier.includePattern = monitor.classifier.includePattern;
  }
  if (monitor.classifier.excludePattern) {
    entry.classifier.excludePattern = monitor.classifier.excludePattern;
  }
  if (monitor.classifier.notifyPattern) {
    entry.classifier.notifyPattern = monitor.classifier.notifyPattern;
  }
  if (monitor.classifier.managedBy !== monitor.managedBy) {
    entry.classifier.managedBy = monitor.classifier.managedBy;
  }

  if (Object.keys(entry.classifier).length === 0) {
    delete entry.classifier;
  }

  return entry;
}

function upsertConfigChannel(channel) {
  ensureConfigShape();
  const entry = serializeChannel(channel);
  const index = findConfigChannelIndex(channel.name);

  if (index === -1) {
    runtimeState.config.channels.push(entry);
  } else {
    runtimeState.config.channels[index] = entry;
  }
}

function upsertConfigMonitor(monitor) {
  ensureConfigShape();
  const entry = serializeMonitor(monitor);
  const index = findConfigMonitorIndex(monitor.name);

  if (index === -1) {
    runtimeState.config.monitors.push(entry);
  } else {
    runtimeState.config.monitors[index] = entry;
  }
}

function removeConfigMonitor(name, force = false) {
  const normalized = normalizeName(name);
  const index = findConfigMonitorIndex(normalized);
  if (index === -1) {
    return false;
  }

  const entry = runtimeState.config.monitors[index];
  assertMutable(normalizeManagedBy(entry.managedBy, "user"), force, `Monitor '${normalized}'`);
  runtimeState.config.monitors.splice(index, 1);
  return true;
}

function applyPersistentChannel(entry) {
  const channel = ensureChannel(entry.name, entry.description ?? "");
  const configSubscription = entry.subscription ?? {};
  channel.subscription = createSubscription({
    enabled: configSubscription.enabled === true,
    delivery: configSubscription.delivery ?? "important",
    scope: "persistent",
    managedBy: configSubscription.managedBy ?? "user"
  });
}

// User-managed entries are treated as protected unless the caller explicitly forces the change.
function assertMutable(managedBy, force, label) {
  if (normalizeManagedBy(managedBy, "model") === "user" && !force) {
    throw new Error(`${label} is user-controlled. Pass force=true only when the user explicitly wants to override it.`);
  }
}

function configureChannelSubscription(rawName, options = {}) {
  const channel = ensureChannel(rawName, options.description ?? "");

  assertMutable(channel.subscription.managedBy, options.force, `Subscription for channel '${channel.name}'`);

  channel.subscription = createSubscription({
    enabled: options.enabled,
    delivery: options.delivery ?? channel.subscription.delivery,
    scope: options.scope ?? channel.subscription.scope,
    managedBy: options.managedBy ?? channel.subscription.managedBy
  });

  if (channel.subscription.scope === "persistent") {
    upsertConfigChannel(channel);
    saveConfig();
  }

  return channel;
}

function formatSubscription(channel) {
  const subscription = channel.subscription;
  const state = subscription.enabled ? "on" : "off";
  return `subscription=${state} delivery=${subscription.delivery} scope=${subscription.scope} managedBy=${subscription.managedBy}`;
}

function formatChannel(channel) {
  const latest = channel.entries[channel.entries.length - 1];
  const latestSummary = latest ? ` latest=${JSON.stringify(latest.text.slice(0, 80))}` : "";
  const description = channel.description ? ` description=${JSON.stringify(channel.description)}` : "";
  return `- ${channel.name}: messages=${channel.entries.length}${description} ${formatSubscription(channel)}${latestSummary}`;
}

function formatChannelHistory(channel, limit) {
  const entries = channel.entries.slice(-limit);
  if (entries.length === 0) {
    return `Channel '${channel.name}' is empty.`;
  }

  return [
    `Channel '${channel.name}' (${entries.length} of ${channel.entries.length} entries):`,
    ...entries.map((entry) => {
      const monitorLabel = entry.monitorName ? ` monitor=${entry.monitorName}` : "";
      const streamLabel = entry.stream ? ` stream=${entry.stream}` : "";
      return `[${entry.timestamp}] source=${entry.source}${monitorLabel}${streamLabel} ${entry.text}`;
    })
  ].join("\n");
}

function formatClassifier(classifier) {
  const include = classifier.includePattern ?? "*";
  const exclude = classifier.excludePattern ?? "<none>";
  const notify = classifier.notifyPattern ?? DEFAULT_NOTIFY_PATTERN.source;
  return `include=${JSON.stringify(include)} exclude=${JSON.stringify(exclude)} notify=${JSON.stringify(notify)} scope=${classifier.scope} managedBy=${classifier.managedBy}`;
}

function formatRunningMonitor(monitor) {
  return [
    `- ${monitor.name}:`,
    `  status=${monitor.status}`,
    `  scope=${monitor.scope}`,
    `  managedBy=${monitor.managedBy}`,
    `  channel=${monitor.channel}`,
    `  subscription=${ensureChannel(monitor.channel).subscription.enabled ? "on" : "off"}`,
    `  cwd=${monitor.cwd}`,
    `  command=${monitor.command}`,
    `  autoStart=${monitor.autoStart}`,
    `  includeStderr=${monitor.includeStderr}`,
    `  acceptedLines=${monitor.lineCount}`,
    `  droppedLines=${monitor.droppedLineCount}`,
    `  classifier=${formatClassifier(monitor.classifier)}`,
    monitor.description ? `  description=${monitor.description}` : null,
    monitor.exitCode !== null && monitor.exitCode !== undefined ? `  exitCode=${monitor.exitCode}` : null
  ]
    .filter(Boolean)
    .join("\n");
}

function formatConfiguredMonitor(entry) {
  const classifier = createClassifier(getClassifierInput(entry), entry.classifier?.managedBy ?? entry.managedBy ?? "user", "persistent");
  return [
    `- ${normalizeName(entry.name)}:`,
    "  status=configured",
    "  scope=persistent",
    `  managedBy=${normalizeManagedBy(entry.managedBy, "user")}`,
    `  channel=${normalizeName(entry.channel, normalizeName(entry.name))}`,
    `  autoStart=${entry.autoStart !== false}`,
    `  includeStderr=${entry.includeStderr !== false}`,
    entry.cwd ? `  cwd=${entry.cwd}` : null,
    `  command=${entry.command}`,
    `  classifier=${formatClassifier(classifier)}`,
    entry.description ? `  description=${entry.description}` : null
  ]
    .filter(Boolean)
    .join("\n");
}

function buildNotificationPrompt(batch) {
  return [
    "Background channel update from copilot-channels-extension:",
    ...batch.map((item) => {
      const streamLabel = item.stream ? `/${item.stream}` : "";
      return `- channel=${item.channel} monitor=${item.monitorName}${streamLabel}: ${item.text}`;
    }),
    "Only react if the update matters to the current task."
  ].join("\n");
}

async function safeLog(message, options) {
  if (!session) {
    return;
  }

  try {
    await session.log(message, options);
  } catch {
    // Logging should never interrupt the extension.
  }
}

function queueNotification(notification) {
  notificationQueue.push(notification);
  void flushNotifications();
}

async function flushNotifications() {
  if (notificationInFlight || notificationQueue.length === 0) {
    return;
  }

  notificationInFlight = true;
  const batch = notificationQueue.splice(0, 4);

  try {
    await session.send({ prompt: buildNotificationPrompt(batch) });
  } catch (error) {
    await safeLog(`Failed to dispatch monitor update: ${error.message}`, { level: "warning" });
  } finally {
    notificationInFlight = false;
    if (notificationQueue.length > 0) {
      void flushNotifications();
    }
  }
}

function classifierAllowsLine(monitor, line) {
  if (monitor.classifier.excludeRegex && monitor.classifier.excludeRegex.test(line)) {
    return false;
  }
  if (monitor.classifier.includeRegex) {
    return monitor.classifier.includeRegex.test(line);
  }

  return true;
}

function shouldNotifySubscribers(monitor, line, stream) {
  if (stream === "stderr" && monitor.includeStderr === false) {
    return false;
  }

  const channel = ensureChannel(monitor.channel);
  if (!channel.subscription.enabled) {
    return false;
  }

  if (channel.subscription.delivery === "all") {
    return true;
  }

  if (monitor.classifier.notifyRegex) {
    return monitor.classifier.notifyRegex.test(line);
  }

  return DEFAULT_NOTIFY_PATTERN.test(line);
}

function wireMonitorStream(monitor, input, stream) {
  const lineReader = readline.createInterface({ input });

  lineReader.on("line", (line) => {
    const text = String(line).trim();
    if (!text) {
      return;
    }

    if (!classifierAllowsLine(monitor, text)) {
      monitor.droppedLineCount += 1;
      return;
    }

    monitor.lineCount += 1;
    appendChannelMessage(monitor.channel, {
      source: stream === "stderr" ? "monitor:stderr" : "monitor",
      text,
      monitorName: monitor.name,
      stream
    });

    if (shouldNotifySubscribers(monitor, text, stream)) {
      queueNotification({
        channel: monitor.channel,
        monitorName: monitor.name,
        stream,
        text
      });
    }
  });

  return lineReader;
}

function spawnMonitorProcess(command, cwd) {
  if (process.platform === "win32") {
    return spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", command], {
      cwd,
      env: process.env,
      windowsHide: true
    });
  }

  return spawn("bash", ["-lc", command], {
    cwd,
    env: process.env
  });
}

function buildMonitorState(spec, baseCwd, defaults = {}) {
  const name = normalizeName(spec.name);
  if (!name) {
    throw new Error("Monitor name is required.");
  }
  if (!String(spec.command ?? "").trim()) {
    throw new Error(`Monitor '${name}' is missing a command.`);
  }

  const scope = normalizeScope(spec.scope, defaults.scope ?? "temporary");
  const managedBy = normalizeManagedBy(spec.managedBy, defaults.managedBy ?? "model");
  const classifier = createClassifier(
    getClassifierInput(spec),
    spec.classifier?.managedBy ?? managedBy,
    scope
  );

  return {
    name,
    description: String(spec.description ?? "").trim(),
    command: String(spec.command),
    requestedCwd: spec.cwd ?? null,
    cwd: resolveRequestedCwd(baseCwd, spec.cwd),
    channel: normalizeName(spec.channel, name),
    autoStart: spec.autoStart !== false,
    includeStderr: spec.includeStderr !== false,
    scope,
    managedBy,
    classifier,
    startedAt: nowIso(),
    stoppedAt: null,
    lineCount: 0,
    droppedLineCount: 0,
    status: "running",
    stopRequested: false,
    process: null,
    stdoutReader: null,
    stderrReader: null,
    exitCode: null
  };
}

async function startMonitor(spec, options = {}) {
  const baseCwd = options.baseCwd ?? runtimeState.cwd;
  const monitor = buildMonitorState(spec, baseCwd, options);
  const existing = monitors.get(monitor.name);

  if (existing && existing.status === "running") {
    throw new Error(`Monitor '${monitor.name}' is already running.`);
  }
  if (existing) {
    assertMutable(existing.managedBy, options.force, `Monitor '${monitor.name}'`);
  }

  ensureChannel(monitor.channel, monitor.description || `Events for ${monitor.name}`);

  let child;
  try {
    child = spawnMonitorProcess(monitor.command, monitor.cwd);
  } catch (error) {
    throw new Error(`Failed to start monitor '${monitor.name}': ${error.message}`);
  }

  monitor.process = child;
  monitor.stdoutReader = wireMonitorStream(monitor, child.stdout, "stdout");
  monitor.stderrReader = wireMonitorStream(monitor, child.stderr, "stderr");

  child.on("error", (error) => {
    monitor.status = "error";
    appendChannelMessage(monitor.channel, {
      source: "system",
      text: `Monitor '${monitor.name}' failed: ${error.message}`,
      monitorName: monitor.name
    });

    if (ensureChannel(monitor.channel).subscription.enabled) {
      queueNotification({
        channel: monitor.channel,
        monitorName: monitor.name,
        stream: "system",
        text: `Monitor failed to stay alive: ${error.message}`
      });
    }
  });

  child.on("exit", (code, signal) => {
    monitor.status = monitor.stopRequested ? "stopped" : "exited";
    monitor.exitCode = code;
    monitor.stoppedAt = nowIso();

    appendChannelMessage(monitor.channel, {
      source: "system",
      text: monitor.stopRequested
        ? `Monitor '${monitor.name}' stopped.`
        : `Monitor '${monitor.name}' exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}.`,
      monitorName: monitor.name
    });

    if (!monitor.stopRequested && ensureChannel(monitor.channel).subscription.enabled) {
      queueNotification({
        channel: monitor.channel,
        monitorName: monitor.name,
        stream: "system",
        text: `Monitor exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}.`
      });
    }
  });

  monitors.set(monitor.name, monitor);

  appendChannelMessage(monitor.channel, {
    source: "system",
    text: `Monitor '${monitor.name}' started with command: ${monitor.command}`,
    monitorName: monitor.name
  });

  if (options.subscribe === true) {
    configureChannelSubscription(monitor.channel, {
      enabled: true,
      delivery: options.delivery ?? "important",
      scope: options.scope ?? monitor.scope,
      managedBy: options.managedBy ?? monitor.managedBy,
      description: spec.channelDescription ?? monitor.description,
      force: options.force
    });
  }

  if (monitor.scope === "persistent") {
    upsertConfigMonitor(monitor);
    if (options.subscribe === true) {
      upsertConfigChannel(ensureChannel(monitor.channel));
    }
    saveConfig();
  }

  await safeLog(`Started monitor '${monitor.name}' in ${monitor.cwd}`, { ephemeral: true });
  return monitor;
}

async function stopRunningMonitor(monitor) {
  if (monitor.status !== "running") {
    return monitor;
  }

  monitor.stopRequested = true;
  monitor.status = "stopping";

  if (monitor.stdoutReader) {
    monitor.stdoutReader.close();
  }
  if (monitor.stderrReader) {
    monitor.stderrReader.close();
  }

  monitor.process.kill();
  return monitor;
}

async function stopMonitor(name, options = {}) {
  const normalized = normalizeName(name);
  const scope = normalizeScope(options.scope, "temporary");
  const monitor = monitors.get(normalized);

  if (monitor) {
    assertMutable(monitor.managedBy, options.force, `Monitor '${normalized}'`);
    await stopRunningMonitor(monitor);
  }

  if (scope === "persistent") {
    const removed = removeConfigMonitor(normalized, options.force);
    if (removed) {
      saveConfig();
    }

    if (!monitor && !removed) {
      throw new Error(`Monitor '${normalized}' was not found in the session or persistent config.`);
    }

    return {
      name: normalized,
      status: removed ? "removed-from-config" : monitor?.status ?? "stopped"
    };
  }

  if (!monitor) {
    throw new Error(`Monitor '${normalized}' is not running in this session.`);
  }

  return monitor;
}

function updateMonitorClassifier(name, input, options = {}) {
  const normalized = normalizeName(name);
  const scope = normalizeScope(options.scope, "temporary");
  const managedBy = normalizeManagedBy(options.managedBy, "model");
  const monitor = monitors.get(normalized);
  const configIndex = findConfigMonitorIndex(normalized);
  const configEntry = configIndex === -1 ? null : runtimeState.config.monitors[configIndex];

  if (monitor) {
    assertMutable(monitor.classifier.managedBy, options.force, `Classifier for monitor '${normalized}'`);
    monitor.classifier = createClassifier(
      {
        includePattern: input.includePattern ?? monitor.classifier.includePattern,
        excludePattern: input.excludePattern ?? monitor.classifier.excludePattern,
        notifyPattern: input.notifyPattern ?? monitor.classifier.notifyPattern,
        managedBy: options.managedBy ?? monitor.classifier.managedBy,
        scope
      },
      managedBy,
      scope
    );

    if (scope === "persistent") {
      monitor.scope = "persistent";
      upsertConfigMonitor(monitor);
      saveConfig();
    }

    return monitor;
  }

  if (scope !== "persistent" || !configEntry) {
    throw new Error(`Monitor '${normalized}' is not running, so only a persistent classifier update is possible when it exists in config.`);
  }

  assertMutable(normalizeManagedBy(configEntry.classifier?.managedBy ?? configEntry.managedBy, "user"), options.force, `Classifier for monitor '${normalized}'`);

  configEntry.classifier = {
    includePattern: input.includePattern ?? configEntry.classifier?.includePattern,
    excludePattern: input.excludePattern ?? configEntry.classifier?.excludePattern,
    notifyPattern: input.notifyPattern ?? configEntry.classifier?.notifyPattern,
    managedBy
  };

  saveConfig();
  return {
    name: normalized,
    status: "configured",
    classifier: createClassifier(configEntry.classifier, managedBy, "persistent")
  };
}

async function stopAllMonitors() {
  const runningMonitors = [...monitors.values()].filter((monitor) => monitor.status === "running");
  await Promise.allSettled(runningMonitors.map((monitor) => stopRunningMonitor(monitor)));
}

function listChannelsResult() {
  ensureChannel(DEFAULT_CHANNEL, "Extension events");

  const values = [...channels.values()].sort((left, right) => left.name.localeCompare(right.name));
  return [
    `Channels (${values.length}):`,
    ...values.map((channel) => formatChannel(channel))
  ].join("\n");
}

function listMonitorsResult() {
  ensureConfigShape();

  const running = [...monitors.values()].sort((left, right) => left.name.localeCompare(right.name));
  const configuredOnly = runtimeState.config.monitors
    .filter((entry) => !monitors.has(normalizeName(entry.name)))
    .sort((left, right) => normalizeName(left.name).localeCompare(normalizeName(right.name)));

  if (running.length === 0 && configuredOnly.length === 0) {
    return "No monitors have been defined for this session.";
  }

  return [
    `Running monitors (${running.length}):`,
    ...(running.length > 0 ? running.map((monitor) => formatRunningMonitor(monitor)) : ["- <none>"]),
    "",
    `Persistent monitor definitions (${configuredOnly.length}):`,
    ...(configuredOnly.length > 0 ? configuredOnly.map((entry) => formatConfiguredMonitor(entry)) : ["- <none>"])
  ].join("\n");
}

function subscriptionSummary() {
  const subscribed = [...channels.values()]
    .filter((channel) => channel.subscription.enabled)
    .sort((left, right) => left.name.localeCompare(right.name));

  if (subscribed.length === 0) {
    return "";
  }

  return [
    "Subscribed channels:",
    ...subscribed.map(
      (channel) =>
        `- ${channel.name} delivery=${channel.subscription.delivery} scope=${channel.subscription.scope} managedBy=${channel.subscription.managedBy}`
    )
  ].join("\n");
}

async function applyPersistentConfig(baseCwd) {
  const configLoad = loadConfig(baseCwd);

  for (const entry of runtimeState.config.channels) {
    applyPersistentChannel(entry);
  }

  let started = 0;
  for (const entry of runtimeState.config.monitors) {
    if (entry.autoStart === false) {
      continue;
    }

    try {
      await startMonitor(
        {
          ...entry,
          scope: "persistent",
          managedBy: entry.managedBy ?? "user"
        },
        {
          baseCwd,
          scope: "persistent",
          managedBy: entry.managedBy ?? "user",
          subscribe: false,
          force: true
        }
      );
      started += 1;
    } catch (error) {
      await safeLog(`Failed to auto-start monitor '${entry.name}': ${error.message}`, {
        level: "warning"
      });
    }
  }

  return configLoad.found
    ? `Loaded ${runtimeState.config.channels.length} channels and ${runtimeState.config.monitors.length} persistent monitor definitions from ${configLoad.filePath}. Auto-started ${started}.`
    : "No copilot-channels config file found.";
}

session = await joinSession({
  tools: [
    {
      name: "copilot_channels_list_channels",
      description: "Lists channels, subscription state, and recent metadata managed by copilot-channels-extension.",
      handler: async () => listChannelsResult()
    },
    {
      name: "copilot_channels_post",
      description: "Posts a note into a named channel for later retrieval.",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Channel name." },
          message: { type: "string", description: "Text to append." },
          source: { type: "string", description: "Optional source label." },
          description: { type: "string", description: "Optional channel description when creating it." }
        },
        required: ["channel", "message"]
      },
      handler: async (args) => {
        const channel = ensureChannel(args.channel, args.description ?? "");
        appendChannelMessage(channel.name, {
          source: args.source || "tool",
          text: args.message
        });
        return `Posted to channel '${channel.name}'.`;
      }
    },
    {
      name: "copilot_channels_history",
      description: "Returns recent entries from a named channel.",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Channel name to inspect." },
          limit: { type: "number", description: "How many recent entries to return." }
        },
        required: ["channel"]
      },
      handler: async (args) => {
        const channelName = normalizeName(args.channel);
        const channel = channels.get(channelName);
        if (!channel) {
          throw new Error(`Channel '${channelName}' does not exist.`);
        }
        return formatChannelHistory(channel, clampLimit(args.limit, 20));
      }
    },
    {
      name: "copilot_channels_subscribe",
      description: "Subscribes the agent to a channel either for this session only or persistently via config.",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Channel name." },
          description: { type: "string", description: "Optional channel description." },
          delivery: { type: "string", description: "Notification mode: 'important' or 'all'." },
          scope: { type: "string", description: "Use 'temporary' for session-only or 'persistent' to write config." },
          managedBy: { type: "string", description: "Controller label: 'user' or 'model'." },
          force: { type: "boolean", description: "Required only when overriding a user-controlled subscription." }
        },
        required: ["channel"]
      },
      handler: async (args) => {
        const channel = configureChannelSubscription(args.channel, {
          enabled: true,
          delivery: args.delivery ?? "important",
          scope: args.scope ?? "temporary",
          managedBy: args.managedBy ?? "model",
          description: args.description ?? "",
          force: args.force === true
        });

        return `Subscribed to channel '${channel.name}' with delivery=${channel.subscription.delivery} scope=${channel.subscription.scope} managedBy=${channel.subscription.managedBy}.`;
      }
    },
    {
      name: "copilot_channels_unsubscribe",
      description: "Disables subscription delivery for a channel, temporarily or persistently.",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Channel name." },
          scope: { type: "string", description: "Use 'temporary' or 'persistent'." },
          managedBy: { type: "string", description: "Controller label after the update: 'user' or 'model'." },
          force: { type: "boolean", description: "Required only when overriding a user-controlled subscription." }
        },
        required: ["channel"]
      },
      handler: async (args) => {
        const channel = configureChannelSubscription(args.channel, {
          enabled: false,
          delivery: args.delivery ?? "important",
          scope: args.scope ?? "temporary",
          managedBy: args.managedBy ?? "model",
          force: args.force === true
        });

        return `Unsubscribed channel '${channel.name}' with scope=${channel.subscription.scope} managedBy=${channel.subscription.managedBy}.`;
      }
    },
    {
      name: "copilot_channels_list_monitors",
      description: "Lists running monitors and persistent monitor definitions.",
      handler: async () => listMonitorsResult()
    },
    {
      name: "copilot_channels_start_monitor",
      description: "Starts a monitor temporarily or persistently, with classifier rules and optional channel subscription.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Unique monitor name." },
          command: { type: "string", description: "Shell command to run." },
          description: { type: "string", description: "Short summary." },
          channel: { type: "string", description: "Channel to receive accepted lines." },
          cwd: { type: "string", description: "Optional working directory relative to the session cwd." },
          scope: { type: "string", description: "Use 'temporary' for session-only or 'persistent' to write config." },
          managedBy: { type: "string", description: "Controller label: 'user' or 'model'." },
          autoStart: { type: "boolean", description: "When persistent, whether the monitor should auto-start next session." },
          includeStderr: { type: "boolean", description: "Whether stderr lines are eligible for notification delivery." },
          includePattern: { type: "string", description: "Only matching lines are admitted into the channel." },
          excludePattern: { type: "string", description: "Matching lines are dropped before they reach the channel." },
          notifyPattern: { type: "string", description: "Matching lines notify subscribed channels when delivery='important'." },
          subscribe: { type: "boolean", description: "Whether to subscribe the channel as part of monitor creation." },
          delivery: { type: "string", description: "Subscription delivery mode: 'important' or 'all'." },
          force: { type: "boolean", description: "Required only when overriding a user-controlled monitor or subscription." }
        },
        required: ["name", "command"]
      },
      handler: async (args) => {
        const scope = args.scope ?? "temporary";
        const managedBy = args.managedBy ?? "model";
        const monitor = await startMonitor(
          {
            ...args,
            scope,
            managedBy
          },
          {
            baseCwd: runtimeState.cwd,
            scope,
            managedBy,
            subscribe: args.subscribe !== false,
            delivery: args.delivery ?? "important",
            force: args.force === true
          }
        );

        return [
          `Started monitor '${monitor.name}'.`,
          `scope=${monitor.scope}`,
          `managedBy=${monitor.managedBy}`,
          `channel=${monitor.channel}`,
          `subscription=${ensureChannel(monitor.channel).subscription.enabled ? "on" : "off"}`,
          `classifier=${formatClassifier(monitor.classifier)}`
        ].join("\n");
      }
    },
    {
      name: "copilot_channels_set_classifier",
      description: "Updates what a monitor admits into its channel and what qualifies for subscribed notifications.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Monitor name." },
          includePattern: { type: "string", description: "Only matching lines are admitted into the stream." },
          excludePattern: { type: "string", description: "Matching lines are removed from the stream." },
          notifyPattern: { type: "string", description: "Matching lines notify the subscribed channel when delivery='important'." },
          scope: { type: "string", description: "Use 'temporary' or 'persistent'." },
          managedBy: { type: "string", description: "Controller label: 'user' or 'model'." },
          force: { type: "boolean", description: "Required only when overriding a user-controlled classifier." }
        },
        required: ["name"]
      },
      handler: async (args) => {
        const result = updateMonitorClassifier(args.name, args, {
          scope: args.scope ?? "temporary",
          managedBy: args.managedBy ?? "model",
          force: args.force === true
        });

        const classifier = result.classifier ?? monitors.get(normalizeName(args.name))?.classifier;
        return `Updated classifier for monitor '${normalizeName(args.name)}': ${formatClassifier(classifier)}`;
      }
    },
    {
      name: "copilot_channels_stop_monitor",
      description: "Stops a running monitor. With scope='persistent', it also removes the stored monitor definition from config.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Monitor name." },
          scope: { type: "string", description: "Use 'temporary' or 'persistent'." },
          force: { type: "boolean", description: "Required only when overriding a user-controlled monitor." }
        },
        required: ["name"]
      },
      handler: async (args) => {
        const result = await stopMonitor(args.name, {
          scope: args.scope ?? "temporary",
          force: args.force === true
        });

        return `Stop requested for monitor '${normalizeName(args.name)}' (status=${result.status}).`;
      }
    }
  ],
  hooks: {
    onSessionStart: async (input) => {
      ensureChannel(DEFAULT_CHANNEL, "Extension events");

      let configSummary = "No config loaded.";
      try {
        configSummary = await applyPersistentConfig(input.cwd);
      } catch (error) {
        configSummary = `Config load failed: ${error.message}`;
        await safeLog(configSummary, { level: "warning" });
      }

      return {
        additionalContext: [
          "copilot-channels-extension is active.",
          "Use channel subscriptions when you want ongoing attention on a stream; use monitors to collect background output; use classifiers to decide what reaches the stream and what triggers delivery.",
          "Subscribed channel updates are sent immediately from monitor output and do not wait for transcript events.",
          configSummary,
          subscriptionSummary()
        ]
          .filter(Boolean)
          .join("\n")
      };
    },
    onUserPromptSubmitted: async () => {
      const summary = subscriptionSummary();
      if (!summary) {
        return undefined;
      }

      return { additionalContext: summary };
    },
    onSessionEnd: async () => {
      await stopAllMonitors();
      return {
        sessionSummary: `copilot-channels-extension tracked ${channels.size} channels and ${runtimeState.config.monitors.length} persistent monitor definitions.`,
        cleanupActions: ["Stopped session monitors managed by copilot-channels-extension."]
      };
    }
  }
});

appendChannelMessage(DEFAULT_CHANNEL, {
  source: "system",
  text: "copilot-channels-extension loaded."
});

session.on("session.shutdown", () => {
  void stopAllMonitors();
});
