import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";

import { CopilotClient, approveAll } from "@github/copilot-sdk";
import { parse } from "yaml";

import { createCopilotChannelsRuntime } from "../src/tap-runtime.mjs";
import { CONFIG_LOCATIONS } from "../src/consts.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const extensionsRoot = path.join(repoRoot, ".github", "extensions");
const repoSkillRoot = path.join(repoRoot, ".github", "skills");
const casesPath = path.join(__dirname, "cases.yaml");
const defaultResultsRoot = path.join(__dirname, "results");
const configCandidatePaths = CONFIG_LOCATIONS.map((relativePath) => path.join(repoRoot, relativePath));
const defaultExecModel = "gpt-5.4-mini";
const defaultJudgeModel = "gpt-5.4-mini";
const acpSessionClientName = "copilot-channels-evals";
const acpCliArgs = ["--acp"];

function usage() {
  return [
    "Usage:",
    "  node evals/run.mjs list",
    "  node evals/run.mjs smoke",
    "  node evals/run.mjs run --case E001",
    "  node evals/run.mjs run --all",
    "  node evals/run.mjs prepare-interactive --case E001",
    "  node evals/run.mjs judge-interactive --run-dir <path>",
    "  node evals/run.mjs validate-modes",
    "  node evals/run.mjs validate-modes-inspect --run-dir <path>",
    "",
    "Options:",
    "  --case <id>           Run one case by ID",
    "  --all                 Run all cases sequentially",
    "  --run-dir <path>      Existing validate-modes or interactive run directory",
    "  --exec-model <model>  Model for the execution Copilot session",
    "  --judge-model <model> Model for the validation Copilot session",
    "  --results-dir <path>  Override the results directory",
    "  --acp-port <n>        Bind the ACP server to a specific TCP port",
    "  --exec-timeout-ms <n> Timeout for the executor Copilot session",
    "  --judge-timeout-ms <n> Timeout for the judge Copilot session",
    "  --concurrency <n>     Max simultaneous eval cases (default 1). Cases that touch persistent config still run serially.",
    "  --dry-run             Print prompts without invoking Copilot"
  ].join("\n");
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {
    command: command ?? "list",
    caseId: null,
    runAll: false,
    runDir: null,
    execModel: null,
    judgeModel: null,
    resultsDir: defaultResultsRoot,
    acpPort: 0,
    dryRun: false,
    execTimeoutMs: 300000,
    judgeTimeoutMs: 120000,
    concurrency: 1
  };

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];

    if (token === "--case") {
      options.caseId = rest[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (token === "--all") {
      options.runAll = true;
      continue;
    }
    if (token === "--exec-model") {
      options.execModel = rest[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (token === "--judge-model") {
      options.judgeModel = rest[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (token === "--run-dir") {
      options.runDir = path.resolve(rest[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (token === "--results-dir") {
      options.resultsDir = path.resolve(rest[index + 1] ?? defaultResultsRoot);
      index += 1;
      continue;
    }
    if (token === "--acp-port") {
      options.acpPort = Number.parseInt(rest[index + 1] ?? "0", 10);
      index += 1;
      continue;
    }
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (token === "--exec-timeout-ms") {
      options.execTimeoutMs = Number.parseInt(rest[index + 1] ?? "300000", 10);
      index += 1;
      continue;
    }
    if (token === "--judge-timeout-ms") {
      options.judgeTimeoutMs = Number.parseInt(rest[index + 1] ?? "120000", 10);
      index += 1;
      continue;
    }
    if (token === "--concurrency") {
      options.concurrency = Number.parseInt(rest[index + 1] ?? "1", 10);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  if (Number.isNaN(options.acpPort) || options.acpPort < 0) {
    throw new Error("Use a non-negative integer with --acp-port.");
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error("Use a positive integer with --concurrency.");
  }
  if (options.command === "run" && !options.runAll && !options.caseId) {
    throw new Error("Use --case <id> or --all with the run command.");
  }
  if (options.command === "prepare-interactive" && !options.caseId) {
    throw new Error("Use --case <id> with the prepare-interactive command.");
  }
  if (options.command === "judge-interactive" && !options.runDir) {
    throw new Error("Use --run-dir <path> with the judge-interactive command.");
  }
  if (options.command === "validate-modes-inspect" && !options.runDir) {
    throw new Error("Use --run-dir <path> with the validate-modes-inspect command.");
  }

  return options;
}

async function loadCaseCatalog() {
  const raw = await readFile(casesPath, "utf8");
  const parsed = parse(raw);
  return parsed?.cases ?? [];
}

async function loadCaseById(caseId) {
  const cases = await loadCaseCatalog();
  return cases.find((caseDef) => caseDef.id.toLowerCase() === String(caseId).toLowerCase()) ?? null;
}

function formatCaseSummary(caseDef) {
  return `${caseDef.id}  ${caseDef.category}  ${caseDef.title}`;
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function truncateText(value, maxLength = 12000) {
  const text = String(value ?? "");
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}\n\n[truncated]`;
}

function buildExecutorPrompt(caseDef) {
  const passConditions = ensureArray(caseDef.pass_conditions)
    .map((condition) => `- ${condition}`)
    .join("\n");

  const setupLines = [];
  if (caseDef.setup?.fixture?.command) {
    setupLines.push(`- Suggested fixture command: ${caseDef.setup.fixture.command}`);
  }
  for (const prerequisite of ensureArray(caseDef.setup?.prerequisites)) {
    setupLines.push(`- Prerequisite: ${prerequisite}`);
  }

  return [
    `You are running automated eval case ${caseDef.id}: ${caseDef.title}.`,
    "Work only inside the current repository.",
    "Execute the user request below as the real Copilot agent.",
    "Work efficiently. Minimize tool calls and do not over-explore the repository - the tap_* tools are the only interface you need for this extension.",
    "Do not write test scripts, spawn subagents, reload the extension, or restart sessions. If a case requires behavior that is only observable across sessions, describe what would happen instead of trying to simulate it.",
    "If you need to change a monitor's cadence, command, or prompt, stop it with tap_stop_emitter and then call tap_start_emitter again with the same name and the new values.",
    "When practical inside a single run, inspect monitor state and channel history before finishing.",
    "If you create temporary monitors, loops, or prompt work items, stop them before finishing unless the case explicitly tests persistence.",
    "Do not leave background work running at the end of the run. The eval harness will time out if you do.",
    "Do not edit eval result files.",
    "If the repo-scoped tap_* tools are unavailable in this session, say that clearly instead of pretending the action succeeded.",
    setupLines.length > 0 ? `Setup notes:\n${setupLines.join("\n")}` : null,
    `User request:\n${caseDef.user_prompt}`,
    `Pass conditions:\n${passConditions}`,
    "End your response with a short section titled EVAL_EXECUTION_SUMMARY that explains what you did and any limitations."
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildJudgePrompt(caseDef, artifacts) {
  const passConditions = ensureArray(caseDef.pass_conditions)
    .map((condition) => `- ${condition}`)
    .join("\n");

  return [
    `You are the validation Copilot for eval case ${caseDef.id}: ${caseDef.title}.`,
    "Do not use tools. Do not inspect the repository. Judge only from the observed facts below.",
    "Return exactly one JSON object on a single line, with no markdown fences and no extra commentary.",
    'Schema: {"caseId":"E001","verdict":"pass|partial|fail","summary":"short explanation","checks":[{"condition":"text","status":"pass|partial|fail","evidence":"text"}],"notes":["optional note"]}',
    "Inside every string value, do not emit unescaped double-quote characters. Do not paste raw JSON or code snippets into evidence strings; paraphrase instead (for example, write: the monitors array is empty). If you must quote something, use single quotes or escape each inner double quote as \\\".",
    `Executor status: ${artifacts.executorStatus}`,
    `Executor timed out: ${artifacts.executorTimedOut ? "yes" : "no"}`,
    `Executor error: ${truncateText(artifacts.executorError || "[none]", 600)}`,
    `Executor requested tools: ${artifacts.executorRequestedTools.length > 0 ? artifacts.executorRequestedTools.join(", ") : "[none]"}`,
    `Executor assistant transcript:\n${truncateText(artifacts.executorTranscript, 4000) || "[empty]"}`,
    `Executor event transcript excerpt:\n${truncateText(artifacts.executorEventTranscript, 5000) || "[empty]"}`,
    `Config before:\n${truncateText(artifacts.configBefore, 3000) || "[empty]"}`,
    `Config after:\n${truncateText(artifacts.configAfter, 3000) || "[empty]"}`,
    `Pass conditions:\n${passConditions}`
  ].join("\n");
}

function buildPreflightPrompt() {
  return [
    "Attempt to use the tool tap_list_streams in this session.",
    "If the tool is unavailable, respond exactly as: UNAVAILABLE: <short reason>.",
    "If the tool is available, respond exactly as: AVAILABLE: <short result>."
  ].join(" ");
}

function buildSmokeReadyPrompt() {
  return "Reply exactly READY.";
}

function buildModeValidationPrompt(probeChannel) {
  return [
    "Use exactly one tool call: tap_enable_injector.",
    `Set channel='${probeChannel}', description='Mode validation probe', delivery='all', scope='persistent', managedBy='model'.`,
    "Do not use any other tools.",
    "Do not read files, search the repository, or inspect the codebase.",
    "After the tool call, reply exactly SUBSCRIBED.",
    "If the tool is unavailable, reply exactly UNAVAILABLE."
  ].join(" ");
}

function buildInteractiveExecutorPrompt(caseDef, executorSummaryRelativePath) {
  return [
    buildExecutorPrompt(caseDef),
    "This eval must run in an interactive Copilot session so the repo-scoped extension can attach to the foreground session.",
    `If practical, write a plain-text execution report to ${executorSummaryRelativePath}.`,
    "If you write that report, it should include:",
    "- whether tap_* tools were visible",
    "- which extension tools you used",
    "- what channel, monitor, subscription, or config changes you made",
    "- the final EVAL_EXECUTION_SUMMARY"
  ].join("\n\n");
}

function buildInteractiveJudgePrompt(manifest, artifacts) {
  const passConditions = ensureArray(manifest.case.passConditions)
    .map((condition) => `- ${condition}`)
    .join("\n");

  return [
    `You are the validation Copilot for interactive eval case ${manifest.case.id}: ${manifest.case.title}.`,
    "Do not use tools. Do not inspect the repository. Judge only from the artifacts below.",
    "Return exactly one JSON object on a single line, with no markdown fences and no extra commentary.",
    'Schema: {"caseId":"E001","verdict":"pass|partial|fail","summary":"short explanation","checks":[{"condition":"text","status":"pass|partial|fail","evidence":"text"}],"notes":["optional note"]}',
    "Inside every string value, do not emit unescaped double-quote characters. Do not paste raw JSON or code snippets into evidence strings; paraphrase instead (for example, write: the monitors array is empty). If you must quote something, use single quotes or escape each inner double quote as \\\".",
    `Shared transcript:\n${truncateText(artifacts.shareTranscript, 5000) || "[missing]"}`,
    `Executor summary:\n${truncateText(artifacts.executorSummary, 3000) || "[missing]"}`,
    `Config before:\n${truncateText(artifacts.configBefore, 3000) || "[empty]"}`,
    `Config after:\n${truncateText(artifacts.configAfter, 3000) || "[empty]"}`,
    `Pass conditions:\n${passConditions}`
  ].join("\n");
}

async function ensureRepoScopedExtensionExists() {
  let extensionEntries;

  try {
    extensionEntries = await readdir(extensionsRoot, { withFileTypes: true });
  } catch {
    throw new Error(`Expected a repo-scoped extension before invoking Copilot automation. Missing directory: ${extensionsRoot}`);
  }

  for (const entry of extensionEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      await access(path.join(extensionsRoot, entry.name, "extension.mjs"));
      return;
    } catch {
      // Keep looking for a valid extension entrypoint.
    }
  }

  throw new Error(`Expected .github\\extensions\\*\\extension.mjs before invoking Copilot automation. Checked: ${extensionsRoot}`);
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveActiveConfigPath() {
  for (const filePath of configCandidatePaths) {
    if (await pathExists(filePath)) {
      return { filePath, existedBefore: true };
    }
  }

  return { filePath: configCandidatePaths[0], existedBefore: false };
}

function ensureConfigShape(doc) {
  const config = doc && typeof doc === "object" ? doc : {};
  return {
    channels: Array.isArray(config.channels) ? config.channels : [],
    monitors: Array.isArray(config.monitors) ? config.monitors : []
  };
}

async function readConfigDocument(filePath) {
  if (!await pathExists(filePath)) {
    return ensureConfigShape(null);
  }

  return ensureConfigShape(JSON.parse(await readFile(filePath, "utf8")));
}

async function writeConfigDocument(filePath, doc) {
  await writeFile(filePath, `${JSON.stringify(ensureConfigShape(doc), null, 2)}\n`, "utf8");
}

async function writeJsonFile(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function configHasProbeChannel(doc, probeChannel) {
  const normalizedProbe = sanitizeName(probeChannel);
  return ensureConfigShape(doc).channels.some((channel) => sanitizeName(channel?.name) === normalizedProbe);
}

async function cleanupProbeChannel(activeConfig, probeChannel) {
  if (!await pathExists(activeConfig.filePath)) {
    return { removed: false, deletedFile: false };
  }

  const config = await readConfigDocument(activeConfig.filePath);
  const normalizedProbe = sanitizeName(probeChannel);
  const beforeCount = config.channels.length;
  config.channels = config.channels.filter((channel) => sanitizeName(channel?.name) !== normalizedProbe);

  if (config.channels.length === beforeCount) {
    return { removed: false, deletedFile: false };
  }

  if (!activeConfig.existedBefore && config.channels.length === 0 && config.monitors.length === 0) {
    await rm(activeConfig.filePath, { force: true });
    return { removed: true, deletedFile: true };
  }

  await writeConfigDocument(activeConfig.filePath, config);
  return { removed: true, deletedFile: false };
}

function sanitizeName(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function timestampToken() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function quoteForPowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function resolveCopilotLaunch() {
  if (process.platform !== "win32") {
    return { command: "copilot", prefixArgs: [], useShell: false, copilotCommand: "copilot" };
  }

  let copilotCommand = "copilot.cmd";
  try {
    const resolved = execFileSync("where.exe", ["copilot.cmd"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);

    if (resolved) {
      copilotCommand = resolved;
    }
  } catch {
    // Fall back to PATH resolution.
  }

  return {
    command: "powershell.exe",
    prefixArgs: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File"],
    useShell: false,
    usePowerShellFile: true,
    copilotCommand
  };
}

function extractJsonObject(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Validator returned empty output.");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        // Fall through to best-effort verdict salvage below.
      }
    }

    const salvage = salvageVerdictFromText(trimmed);
    if (salvage) {
      return salvage;
    }

    throw new Error("Validator output did not contain a JSON object.");
  }
}

function salvageVerdictFromText(text) {
  const verdictMatch = text.match(/"verdict"\s*:\s*"(pass|partial|fail)"/i);
  if (!verdictMatch) {
    return null;
  }

  const caseIdMatch = text.match(/"caseId"\s*:\s*"([^"]+)"/);
  const summaryMatch = text.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);

  return {
    caseId: caseIdMatch?.[1] ?? null,
    verdict: verdictMatch[1].toLowerCase(),
    summary: summaryMatch?.[1] ?? "Judge emitted malformed JSON; summary could not be parsed.",
    checks: [],
    notes: ["Judge response was not valid JSON; verdict was salvaged from raw text."]
  };
}

function terminateChildProcess(child) {
  if (!child?.pid) {
    return;
  }

  if (process.platform === "win32") {
    try {
      execFileSync("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-Command",
        `Stop-Process -Id ${child.pid} -Force`
      ], {
        stdio: ["ignore", "ignore", "ignore"]
      });
      return;
    } catch {
      // Fall through to best-effort child.kill().
    }
  }

  try {
    child.kill("SIGKILL");
  } catch {
    // Ignore best-effort shutdown errors.
  }
}

function normalizeEventContent(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return "";
  }
  return JSON.stringify(value, null, 2);
}

function extractAssistantText(events) {
  return ensureArray(events)
    .filter((event) => event?.type === "assistant.message")
    .map((event) => normalizeEventContent(event?.data?.content).trim())
    .filter(Boolean)
    .join("\n\n");
}

function extractRequestedTools(events) {
  const requestedTools = new Set();

  for (const event of ensureArray(events)) {
    if (event?.type !== "assistant.message") {
      continue;
    }

    for (const toolRequest of ensureArray(event?.data?.toolRequests)) {
      const toolName = toolRequest?.toolName ?? toolRequest?.name ?? null;
      if (toolName) {
        requestedTools.add(toolName);
      }
    }
  }

  return [...requestedTools];
}

function renderEventTranscript(events) {
  return ensureArray(events)
    .map((event) => {
      if (!event || typeof event !== "object") {
        return normalizeEventContent(event);
      }

      if (event.type === "user.message") {
        return `USER\n${normalizeEventContent(event.data?.content ?? event.data)}`;
      }

      if (event.type === "assistant.message") {
        const requestedTools = ensureArray(event.data?.toolRequests)
          .map((toolRequest) => toolRequest?.toolName ?? toolRequest?.name ?? null)
          .filter(Boolean);
        const header = requestedTools.length > 0
          ? `ASSISTANT | toolRequests=${requestedTools.join(", ")}`
          : "ASSISTANT";
        return `${header}\n${normalizeEventContent(event.data?.content ?? event.data)}`;
      }

      return `${event.type ?? "unknown"}\n${normalizeEventContent(event.data ?? event)}`;
    })
    .join("\n\n---\n\n");
}

function buildAcpServerInfo(client, status) {
  const serverInfo = {
    transport: "acp-tcp",
    cliArgs: [...acpCliArgs],
    version: status?.version ?? null,
    protocolVersion: status?.protocolVersion ?? null
  };

  if (typeof client?.actualHost === "string" && client.actualHost) {
    serverInfo.host = client.actualHost;
  }
  if (typeof client?.actualPort === "number" && Number.isFinite(client.actualPort)) {
    serverInfo.port = client.actualPort;
  }

  return serverInfo;
}

function classifyRunStatus(result) {
  if (result.timedOut) {
    return "timed_out";
  }
  if (result.errorMessage) {
    return "error";
  }
  return "completed";
}

function fallbackVerdict(caseId, passConditions, summary, evidence, notes = []) {
  return {
    caseId,
    verdict: "fail",
    summary,
    checks: ensureArray(passConditions).map((condition) => ({
      condition,
      status: "fail",
      evidence
    })),
    notes
  };
}

async function writeSessionArtifacts(baseDir, label, result) {
  const prefix = sanitizeName(label);
  const promptPath = path.join(baseDir, `${prefix}-prompt.txt`);
  const responsePath = path.join(baseDir, `${prefix}-response.txt`);
  const errorPath = path.join(baseDir, `${prefix}-error.txt`);
  const eventsPath = path.join(baseDir, `${prefix}-events.json`);
  const transcriptPath = path.join(baseDir, `${prefix}-transcript.txt`);

  await writeFile(promptPath, `${result.prompt ?? ""}\n`, "utf8");
  await writeFile(responsePath, `${result.responseContent ?? result.assistantText ?? ""}\n`, "utf8");
  await writeFile(errorPath, `${result.errorMessage ?? ""}\n`, "utf8");
  await writeJsonFile(eventsPath, result.events ?? []);
  await writeFile(transcriptPath, `${result.eventTranscript ?? ""}\n`, "utf8");

  return {
    promptPath,
    responsePath,
    errorPath,
    eventsPath,
    transcriptPath
  };
}

async function runCopilotPrompt(prompt, options) {
  const launcher = resolveCopilotLaunch();
  const resolvedModel = options.model ?? defaultExecModel;
  const baseArgs = [
    "--model", resolvedModel,
    "--allow-all",
    "--no-ask-user",
    "--no-remote",
    "--stream",
    "off",
    "--silent",
    "--name",
    options.sessionName
  ];
  if (options.noCustomInstructions) {
    baseArgs.push("--no-custom-instructions");
  }
  if (options.noTools) {
    baseArgs.push("--available-tools=");
    baseArgs.push("--excluded-tools=*");
  }
  if (options.effort) {
    baseArgs.push("--effort", options.effort);
  }
  let args;

  if (launcher.usePowerShellFile) {
    const powerShellScriptPath = `${options.promptFilePath}.launcher.ps1`;
    const scriptLines = [
      "$ErrorActionPreference = 'Stop'",
      `$promptText = Get-Content -Raw -LiteralPath ${quoteForPowerShell(options.promptFilePath)}`,
      "$copilotArgs = @(",
      "  '-p',",
      "  $promptText,",
      "  '--model',",
      `  ${quoteForPowerShell(resolvedModel)},`,
      "  '--allow-all',",
      "  '--no-ask-user',",
      "  '--no-remote',",
      "  '--stream',",
      "  'off',",
      "  '--silent',",
      "  '--name',",
      `  ${quoteForPowerShell(options.sessionName)}`,
      ")"
    ];

    if (options.autopilot) {
      scriptLines.push("$copilotArgs += '--autopilot'");
    }
    if (options.noCustomInstructions) {
      scriptLines.push("$copilotArgs += '--no-custom-instructions'");
    }
    if (options.noTools) {
      scriptLines.push("$copilotArgs += '--available-tools='");
      scriptLines.push("$copilotArgs += '--excluded-tools=*'");
    }
    if (options.effort) {
      scriptLines.push(`$copilotArgs += @('--effort', ${quoteForPowerShell(options.effort)})`);
    }

    scriptLines.push(`& ${quoteForPowerShell(launcher.copilotCommand)} @copilotArgs`);
    scriptLines.push("exit $LASTEXITCODE");

    if (!options.dryRun) {
      await writeFile(powerShellScriptPath, `${scriptLines.join("\r\n")}\r\n`, "utf8");
    }

    args = [...launcher.prefixArgs, powerShellScriptPath];
  } else {
    args = [
      ...launcher.prefixArgs,
      "-p",
      prompt,
      ...baseArgs
    ];
    if (options.autopilot) {
      args.push("--autopilot");
    }
  }

  if (options.dryRun) {
    return {
      stdout: "",
      stderr: "",
      exitCode: 0,
      command: launcher.command,
      args,
      timedOut: false
    };
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(launcher.command, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: launcher.useShell ?? false
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      stderr += `\nRunner timeout after ${options.timeoutMs}ms.\n`;
      terminateChildProcess(child);
    }, options.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timeoutHandle);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timeoutHandle);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 0,
        command: launcher.command,
        args,
        timedOut
      });
    });
  });
}

async function startAcpClient(options) {
  const client = new CopilotClient({
    cwd: repoRoot,
    useStdio: false,
    port: options.acpPort,
    cliArgs: [...acpCliArgs],
    logLevel: "error",
    autoRestart: false
  });

  await client.start();
  const status = await client.getStatus();
  return {
    client,
    serverInfo: buildAcpServerInfo(client, status)
  };
}

async function runAcpPrompt(client, prompt, options) {
  const sessionName = options.sessionName ?? `eval-session-${timestampToken()}`;
  const runtime = options.withChannelsRuntime
    ? createCopilotChannelsRuntime({ cwd: repoRoot })
    : null;

  if (options.dryRun) {
    return {
      sessionName,
      prompt,
      responseContent: "",
      assistantText: "",
      errorMessage: "",
      timedOut: false,
      events: [],
      eventTranscript: "",
      requestedTools: []
    };
  }

  const sessionOptions = {
    sessionId: sessionName,
    clientName: acpSessionClientName,
    onPermissionRequest: approveAll,
    workingDirectory: repoRoot,
    streaming: false,
    skillDirectories: [repoSkillRoot]
  };

  if (options.model) {
    sessionOptions.model = options.model;
  }
  if (runtime) {
    sessionOptions.tools = runtime.tools;
    sessionOptions.hooks = runtime.hooks;
  }
  if (options.noTools) {
    sessionOptions.availableTools = [];
    sessionOptions.excludedTools = ["*"];
  }

  const session = await client.createSession(sessionOptions);
  runtime?.attachSession(session);
  let responseContent = "";
  let errorMessage = "";
  let timedOut = false;
  let events = [];

  try {
    const response = await session.sendAndWait({
      prompt,
      mode: "immediate"
    }, options.timeoutMs);
    responseContent = normalizeEventContent(response?.data?.content).trim();
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
    timedOut = /timed out|timeout/i.test(errorMessage);
  }

  try {
    events = await session.getMessages();
  } catch {
    events = [];
  }

  try {
    await session.disconnect();
  } catch {
    // Best-effort session cleanup.
  }
  try {
    await runtime?.stopAllMonitors();
  } catch {
    // Best-effort runtime cleanup.
  }
  runtime?.attachSession(null);

  const assistantText = extractAssistantText(events).trim();
  const finalResponse = assistantText || responseContent;

  return {
    sessionName,
    prompt,
    responseContent: finalResponse,
    assistantText,
    errorMessage,
    timedOut,
    events,
    eventTranscript: renderEventTranscript(events),
    requestedTools: extractRequestedTools(events)
  };
}

async function runPreflight(client, options, sessionRoot, serverInfo) {
  const preflightDir = path.join(sessionRoot, "preflight");
  await mkdir(preflightDir, { recursive: true });

  const prompt = buildPreflightPrompt();
  const result = await runAcpPrompt(client, prompt, {
    sessionName: `eval-preflight-${timestampToken()}`,
    model: options.execModel ?? defaultExecModel,
    withChannelsRuntime: true,
    timeoutMs: 30000,
    dryRun: options.dryRun
  });
  const artifacts = await writeSessionArtifacts(preflightDir, "tool-visibility", result);
  const combinedOutput = [
    result.responseContent,
    result.assistantText,
    result.errorMessage
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
  const unavailableMatch = combinedOutput.match(/UNAVAILABLE:\s*(.+)/i);
  const availableMatch = combinedOutput.match(/AVAILABLE:\s*(.+)/i);
  const summary = {
    server: serverInfo,
    toolSource: "sdk-runtime",
    sessionId: result.sessionName,
    extensionToolAvailable: Boolean(availableMatch && !unavailableMatch),
    detail: unavailableMatch?.[1]?.trim() || availableMatch?.[1]?.trim() || (result.timedOut
      ? "Preflight timed out before the tool visibility check completed."
      : result.errorMessage || "Preflight did not produce a structured availability marker."),
    timedOut: result.timedOut,
    error: result.errorMessage,
    requestedTools: result.requestedTools,
    artifacts
  };

  await writeJsonFile(path.join(preflightDir, "summary.json"), summary);
  return summary;
}

async function runModeValidation(options) {
  await ensureRepoScopedExtensionExists();

  const runDir = path.join(options.resultsDir, `mode-validation-${timestampToken()}`);
  await mkdir(runDir, { recursive: true });

  const activeConfig = await resolveActiveConfigPath();
  const probeChannel = `mode-validate-${timestampToken()}`;
  const promptText = buildModeValidationPrompt(probeChannel);
  const promptPath = path.join(runDir, "prompt.txt");
  const promptStdoutPath = path.join(runDir, "prompt-stdout.txt");
  const promptStderrPath = path.join(runDir, "prompt-stderr.txt");
  const instructionsPath = path.join(runDir, "instructions.txt");
  const summaryPath = path.join(runDir, "summary.json");

  await writeFile(promptPath, `${promptText}\n`, "utf8");

  const promptResult = await runCopilotPrompt(promptText, {
    promptFilePath: promptPath,
    sessionName: `mode-validate-p-${timestampToken()}`,
    model: options.execModel ?? defaultExecModel,
    autopilot: false,
    noCustomInstructions: true,
    effort: "low",
    dryRun: options.dryRun,
    timeoutMs: 30000
  });

  await writeFile(promptStdoutPath, promptResult.stdout, "utf8");
  await writeFile(promptStderrPath, promptResult.stderr, "utf8");

  const promptConfig = await readConfigDocument(activeConfig.filePath);
  const promptPersisted = configHasProbeChannel(promptConfig, probeChannel);
  const promptCleanup = options.dryRun
    ? { removed: false, deletedFile: false, skipped: true }
    : await cleanupProbeChannel(activeConfig, probeChannel);

  const interactiveCommand = "copilot --no-custom-instructions";
  const inspectCommand = `node .\\evals\\run.mjs validate-modes-inspect --run-dir "${runDir}"`;
  const instructions = [
    `Run this from the repo root: ${interactiveCommand}`,
    "Inside Copilot, run /clear.",
    `Then paste the contents of ${promptPath}.`,
    "Wait for Copilot to finish.",
    `Then run: ${inspectCommand}`
  ].join("\n");

  await writeFile(instructionsPath, `${instructions}\n`, "utf8");

  const summary = {
    probeChannel,
    promptFilePath: promptPath,
    instructionsPath,
    activeConfigPath: activeConfig.filePath,
    activeConfigExistedBefore: activeConfig.existedBefore,
    promptMode: {
      exitCode: promptResult.exitCode,
      timedOut: promptResult.timedOut,
      persistedProbe: promptPersisted,
      stdoutPath: promptStdoutPath,
      stderrPath: promptStderrPath,
      cleanup: promptCleanup
    },
    interactive: {
      command: interactiveCommand,
      inspectCommand
    }
  };

  await writeJsonFile(summaryPath, summary);

  console.log(`Mode validation run: ${runDir}`);
  console.log(`Prompt mode persisted probe: ${promptPersisted ? "yes" : "no"}`);
  console.log(`Prompt mode stdout: ${promptStdoutPath}`);
  console.log(`Prompt mode stderr: ${promptStderrPath}`);
  console.log(`Interactive prompt file: ${promptPath}`);
  console.log(`Interactive inspect command: ${inspectCommand}`);
}

async function inspectModeValidation(options) {
  const summaryPath = path.join(options.runDir, "summary.json");
  if (!await pathExists(summaryPath)) {
    throw new Error(`Mode validation summary not found at ${summaryPath}`);
  }

  const summary = JSON.parse(await readFile(summaryPath, "utf8"));
  const activeConfig = {
    filePath: summary.activeConfigPath,
    existedBefore: summary.activeConfigExistedBefore === true
  };

  const config = await readConfigDocument(activeConfig.filePath);
  const interactivePersisted = configHasProbeChannel(config, summary.probeChannel);
  const cleanup = await cleanupProbeChannel(activeConfig, summary.probeChannel);
  const inspectPath = path.join(options.runDir, "interactive-inspect.json");
  const inspectSummary = {
    probeChannel: summary.probeChannel,
    activeConfigPath: activeConfig.filePath,
    interactivePersisted,
    cleanup
  };

  await writeJsonFile(inspectPath, inspectSummary);

  console.log(`Interactive mode persisted probe: ${interactivePersisted ? "yes" : "no"}`);
  console.log(`Inspect summary: ${inspectPath}`);

  if (!interactivePersisted) {
    process.exitCode = 1;
  }
}

async function prepareInteractiveRun(options) {
  await ensureRepoScopedExtensionExists();

  const caseDef = await loadCaseById(options.caseId);
  if (!caseDef) {
    throw new Error(`No eval case found for '${options.caseId}'.`);
  }

  const runDir = path.join(options.resultsDir, `interactive-eval-${sanitizeName(caseDef.id)}-${timestampToken()}`);
  await mkdir(runDir, { recursive: true });

  const activeConfig = await resolveActiveConfigPath();
  const configBefore = await readConfigDocument(activeConfig.filePath);
  const configBeforePath = path.join(runDir, "config-before.json");
  const executorPromptPath = path.join(runDir, "executor-prompt.txt");
  const executorSummaryPath = path.join(runDir, "executor-summary.txt");
  const shareTranscriptPath = path.join(runDir, "session-share.md");
  const shareCommandPath = path.join(runDir, "share-command.txt");
  const instructionsPath = path.join(runDir, "instructions.txt");
  const manifestPath = path.join(runDir, "manifest.json");
  const executorSummaryRelativePath = path.relative(repoRoot, executorSummaryPath);
  const executorPrompt = buildInteractiveExecutorPrompt(caseDef, executorSummaryRelativePath);

  await writeJsonFile(configBeforePath, configBefore);
  await writeFile(executorPromptPath, `${executorPrompt}\n`, "utf8");
  await writeFile(shareCommandPath, `/share ${shareTranscriptPath}\n`, "utf8");

  const instructions = [
    "1. From the repo root, start or reuse an interactive Copilot session with: copilot",
    "2. Run /clear so the repo extension reloads into the foreground session before this case.",
    `3. Paste the contents of ${executorPromptPath}.`,
    "4. Wait for Copilot to finish the case.",
    `5. Run the share command from ${shareCommandPath}.`,
    "6. If you plan to run another case in the same interactive session, run /clear before the next one.",
    `7. Then run: node .\\evals\\run.mjs judge-interactive --run-dir "${runDir}"`
  ].join("\n");

  await writeFile(instructionsPath, `${instructions}\n`, "utf8");

  const manifest = {
    mode: "interactive-eval",
    runDir,
    case: {
      id: caseDef.id,
      title: caseDef.title,
      passConditions: ensureArray(caseDef.pass_conditions),
      userPrompt: caseDef.user_prompt
    },
    activeConfigPath: activeConfig.filePath,
    configBeforePath,
    executorPromptPath,
    executorSummaryPath,
    shareTranscriptPath,
    shareCommandPath,
    instructionsPath
  };

  await writeJsonFile(manifestPath, manifest);

  console.log(`Interactive eval prepared: ${runDir}`);
  console.log(`Executor prompt: ${executorPromptPath}`);
  console.log(`Instructions: ${instructionsPath}`);
  console.log(`Judge command: node .\\evals\\run.mjs judge-interactive --run-dir "${runDir}"`);
}

async function judgeInteractiveRun(options) {
  const manifestPath = path.join(options.runDir, "manifest.json");
  if (!await pathExists(manifestPath)) {
    throw new Error(`Interactive eval manifest not found at ${manifestPath}`);
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const executorSummary = await readFile(manifest.executorSummaryPath, "utf8").catch(() => "");
  const shareTranscript = await readFile(manifest.shareTranscriptPath, "utf8").catch(() => "");
  const configBefore = await readFile(manifest.configBeforePath, "utf8").catch(() => "{\n  \"channels\": [],\n  \"monitors\": []\n}\n");
  const configAfterDoc = await readConfigDocument(manifest.activeConfigPath);
  const configAfterPath = path.join(options.runDir, "config-after.json");
  const summaryPath = path.join(options.runDir, "judge-summary.json");
  const serverInfoPath = path.join(options.runDir, "judge-server.json");
  const configAfter = `${JSON.stringify(configAfterDoc, null, 2)}\n`;

  await writeFile(configAfterPath, configAfter, "utf8");

  const judgePrompt = buildInteractiveJudgePrompt(manifest, {
    shareTranscript,
    executorSummary,
    configBefore,
    configAfter
  });

  if (options.dryRun) {
    const drySummary = {
      caseId: manifest.case.id,
      mode: "dry-run",
      judgePrompt
    };
    await writeJsonFile(summaryPath, drySummary);
    console.log(`Interactive judge dry-run summary: ${summaryPath}`);
    return;
  }

  const { client, serverInfo } = await startAcpClient(options);
  try {
    await writeJsonFile(serverInfoPath, serverInfo);
    const validation = await runAcpPrompt(client, judgePrompt, {
      sessionName: `interactive-judge-${manifest.case.id}-${timestampToken()}`,
      model: options.judgeModel ?? defaultJudgeModel,
      timeoutMs: options.judgeTimeoutMs,
      noTools: true,
      dryRun: false
    });
    const artifacts = await writeSessionArtifacts(options.runDir, "judge", validation);

    let verdict;
    try {
      verdict = extractJsonObject(validation.responseContent || validation.assistantText);
    } catch (error) {
      verdict = fallbackVerdict(
        manifest.case.id,
        manifest.case.passConditions,
        error.message,
        validation.errorMessage.trim() || "Judge did not return structured output.",
        [
          validation.timedOut ? "Judge timed out." : "Judge did not return parseable JSON."
        ]
      );
    }

    const summary = {
      caseId: manifest.case.id,
      title: manifest.case.title,
      server: serverInfo,
      configBeforePath: manifest.configBeforePath,
      configAfterPath,
      judgeSessionId: validation.sessionName,
      requestedTools: validation.requestedTools,
      artifacts,
      verdict
    };

    await writeJsonFile(summaryPath, summary);
    console.log(`Interactive eval verdict: ${verdict.verdict} - ${verdict.summary}`);
    console.log(`Judge summary: ${summaryPath}`);

    if (verdict.verdict !== "pass") {
      process.exitCode = 1;
    }
  } finally {
    await client.stop();
  }
}

async function runCase(client, serverInfo, caseDef, options, sessionRoot, preflightSummary) {
  const caseDir = path.join(sessionRoot, sanitizeName(caseDef.id));
  await mkdir(caseDir, { recursive: true });

  const activeConfig = await resolveActiveConfigPath();
  const configBeforeDoc = await readConfigDocument(activeConfig.filePath);
  const configBeforePath = path.join(caseDir, "config-before.json");
  const configAfterPath = path.join(caseDir, "config-after.json");
  const summaryPath = path.join(caseDir, "summary.json");
  const executorPrompt = buildExecutorPrompt(caseDef);

  await writeJsonFile(configBeforePath, configBeforeDoc);

  if (options.dryRun) {
    const drySummary = {
      caseId: caseDef.id,
      title: caseDef.title,
      mode: "dry-run",
      server: serverInfo,
      preflight: preflightSummary,
      executorPrompt
    };
    await writeJsonFile(summaryPath, drySummary);
    return drySummary;
  }

  const execution = await runAcpPrompt(client, executorPrompt, {
    sessionName: `eval-exec-${caseDef.id}-${timestampToken()}`,
    model: options.execModel ?? defaultExecModel,
    withChannelsRuntime: true,
    timeoutMs: options.execTimeoutMs,
    dryRun: false
  });
  const executorArtifacts = await writeSessionArtifacts(caseDir, "executor", execution);

  const configAfterDoc = await readConfigDocument(activeConfig.filePath);
  await writeJsonFile(configAfterPath, configAfterDoc);

  const judgePrompt = buildJudgePrompt(caseDef, {
    executorStatus: classifyRunStatus(execution),
    executorTimedOut: execution.timedOut,
    executorError: execution.errorMessage,
    executorRequestedTools: execution.requestedTools,
    executorTranscript: execution.responseContent || execution.assistantText,
    executorEventTranscript: execution.eventTranscript,
    configBefore: JSON.stringify(configBeforeDoc, null, 2),
    configAfter: JSON.stringify(configAfterDoc, null, 2)
  });

  const validation = await runAcpPrompt(client, judgePrompt, {
    sessionName: `eval-judge-${caseDef.id}-${timestampToken()}`,
    model: options.judgeModel ?? defaultJudgeModel,
    timeoutMs: options.judgeTimeoutMs,
    noTools: true,
    dryRun: false
  });
  const judgeArtifacts = await writeSessionArtifacts(caseDir, "judge", validation);

  let verdict;
  try {
    verdict = extractJsonObject(validation.responseContent || validation.assistantText);
  } catch (error) {
    verdict = fallbackVerdict(
      caseDef.id,
      caseDef.pass_conditions,
      error.message,
      validation.errorMessage.trim() || "Judge did not return structured output.",
      [
        validation.timedOut ? "Judge timed out." : "Judge did not return parseable JSON."
      ]
    );
  }

  const summary = {
    caseId: caseDef.id,
    title: caseDef.title,
    server: serverInfo,
    preflight: preflightSummary,
    configBeforePath,
    configAfterPath,
    executor: {
      sessionId: execution.sessionName,
      status: classifyRunStatus(execution),
      timedOut: execution.timedOut,
      error: execution.errorMessage,
      requestedTools: execution.requestedTools,
      artifacts: executorArtifacts
    },
    judge: {
      sessionId: validation.sessionName,
      status: classifyRunStatus(validation),
      timedOut: validation.timedOut,
      error: validation.errorMessage,
      requestedTools: validation.requestedTools,
      artifacts: judgeArtifacts
    },
    verdict
  };

  await writeJsonFile(summaryPath, summary);
  return summary;
}

async function listCases() {
  const cases = await loadCaseCatalog();
  for (const caseDef of cases) {
    console.log(formatCaseSummary(caseDef));
  }
}

async function runSmokeTest(options) {
  await ensureRepoScopedExtensionExists();

  const runDir = path.join(options.resultsDir, `smoke-${timestampToken()}`);
  await mkdir(runDir, { recursive: true });

  if (options.dryRun) {
    const summary = {
      mode: "dry-run",
      readyPrompt: buildSmokeReadyPrompt(),
      preflightPrompt: buildPreflightPrompt()
    };
    await writeJsonFile(path.join(runDir, "summary.json"), summary);
    console.log(`ACP smoke dry-run: ${runDir}`);
    return;
  }

  const { client, serverInfo } = await startAcpClient(options);
  try {
    await writeJsonFile(path.join(runDir, "acp-server.json"), serverInfo);

    const readyResult = await runAcpPrompt(client, buildSmokeReadyPrompt(), {
      sessionName: `smoke-ready-${timestampToken()}`,
      model: options.execModel ?? defaultExecModel,
      timeoutMs: 30000,
      dryRun: false
    });
    const readyArtifacts = await writeSessionArtifacts(runDir, "ready", readyResult);
    const readyOk = readyResult.responseContent.trim() === "READY";

    const preflightSummary = await runPreflight(client, options, runDir, serverInfo);
    const summary = {
      server: serverInfo,
      ready: {
        sessionId: readyResult.sessionName,
        response: readyResult.responseContent,
        timedOut: readyResult.timedOut,
        error: readyResult.errorMessage,
        ok: readyOk,
        artifacts: readyArtifacts
      },
      preflight: preflightSummary
    };

    await writeJsonFile(path.join(runDir, "summary.json"), summary);

    console.log(`ACP smoke run: ${runDir}`);
    console.log(`READY probe: ${readyOk ? "ok" : "unexpected response"}`);
    console.log(`copilot-channels tool visible: ${preflightSummary.extensionToolAvailable ? "yes" : "no"}`);

    if (!readyOk || !preflightSummary.extensionToolAvailable) {
      process.exitCode = 1;
    }
  } finally {
    await client.stop();
  }
}

const CONFIG_ISOLATED_CATEGORIES = new Set(["persistence", "ownership", "startup"]);

function requiresConfigIsolation(caseDef) {
  const category = String(caseDef.category ?? "").toLowerCase();
  if (CONFIG_ISOLATED_CATEGORIES.has(category)) {
    return true;
  }
  const title = String(caseDef.title ?? "").toLowerCase();
  const prompt = String(caseDef.user_prompt ?? "").toLowerCase();
  if (title.includes("persistent") || prompt.includes("persistent")) {
    return true;
  }
  const conditions = ensureArray(caseDef.pass_conditions).join(" ").toLowerCase();
  return conditions.includes("from config");
}

async function runCasesWithConcurrency(cases, concurrency, runner) {
  const results = new Array(cases.length);
  let nextIndex = 0;

  async function worker() {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= cases.length) {
        return;
      }
      results[index] = await runner(cases[index], index);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, cases.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

async function runCases(options) {
  await ensureRepoScopedExtensionExists();
  const cases = await loadCaseCatalog();
  const selectedCases = options.runAll
    ? cases
    : cases.filter((caseDef) => caseDef.id.toLowerCase() === String(options.caseId).toLowerCase());

  if (selectedCases.length === 0) {
    throw new Error(`No eval case found for '${options.caseId}'.`);
  }

  const sessionRoot = path.join(options.resultsDir, timestampToken());
  await mkdir(sessionRoot, { recursive: true });

  if (options.dryRun) {
    const serverInfo = {
      transport: "acp-tcp",
      cliArgs: [...acpCliArgs],
      dryRun: true
    };
    const preflightSummary = {
      server: serverInfo,
      extensionToolAvailable: null,
      detail: "Dry run did not start the ACP server.",
      timedOut: false,
      error: "",
      requestedTools: [],
      artifacts: null
    };
    const summaries = [];

    for (const caseDef of selectedCases) {
      console.log(`Dry-run ${caseDef.id}: ${caseDef.title}`);
      const summary = await runCase(null, serverInfo, caseDef, options, sessionRoot, preflightSummary);
      summaries.push(summary);
    }

    await writeJsonFile(path.join(sessionRoot, "summary.json"), summaries);
    return;
  }

  const { client, serverInfo } = await startAcpClient(options);
  try {
    await writeJsonFile(path.join(sessionRoot, "acp-server.json"), serverInfo);
    const preflightSummary = await runPreflight(client, options, sessionRoot, serverInfo);

    if (!preflightSummary.extensionToolAvailable) {
      console.log(`ACP preflight: copilot-channels tools unavailable (${preflightSummary.detail})`);
    }

    const parallelCases = selectedCases.filter((caseDef) => !requiresConfigIsolation(caseDef));
    const isolatedCases = selectedCases.filter(requiresConfigIsolation);
    const effectiveConcurrency = Math.min(options.concurrency, parallelCases.length || 1);

    console.log(
      `Running ${parallelCases.length} case(s) with concurrency=${effectiveConcurrency}` +
      (isolatedCases.length > 0 ? `, then ${isolatedCases.length} config-touching case(s) serially.` : ".")
    );

    const parallelSummaries = await runCasesWithConcurrency(parallelCases, options.concurrency, async (caseDef) => {
      console.log(`[start] ${caseDef.id}: ${caseDef.title}`);
      const summary = await runCase(client, serverInfo, caseDef, options, sessionRoot, preflightSummary);
      console.log(`[${summary.verdict.verdict}] ${caseDef.id}: ${summary.verdict.summary}`);
      return summary;
    });

    const isolatedSummaries = [];
    for (const caseDef of isolatedCases) {
      console.log(`Running ${caseDef.id}: ${caseDef.title} (serial, touches persistent config)`);
      const summary = await runCase(client, serverInfo, caseDef, options, sessionRoot, preflightSummary);
      isolatedSummaries.push(summary);
      console.log(`  verdict: ${summary.verdict.verdict} - ${summary.verdict.summary}`);
    }

    const summaries = [...parallelSummaries, ...isolatedSummaries];

    await writeJsonFile(path.join(sessionRoot, "summary.json"), summaries);

    const failed = summaries.some((summary) => summary.verdict?.verdict !== "pass");
    if (failed) {
      process.exitCode = 1;
    }
  } finally {
    await client.stop();
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));

    if (options.command === "list") {
      await listCases();
      return;
    }

    if (options.command === "smoke") {
      await runSmokeTest(options);
      return;
    }

    if (options.command === "run") {
      await runCases(options);
      return;
    }

    if (options.command === "prepare-interactive") {
      await prepareInteractiveRun(options);
      return;
    }

    if (options.command === "judge-interactive") {
      await judgeInteractiveRun(options);
      return;
    }

    if (options.command === "validate-modes") {
      await runModeValidation(options);
      return;
    }

    if (options.command === "validate-modes-inspect") {
      await inspectModeValidation(options);
      return;
    }

    throw new Error(`Unknown command: ${options.command}`);
  } catch (error) {
    console.error(error.message);
    console.error("");
    console.error(usage());
    process.exitCode = 1;
  }
}

await main();

// The SDK can leave transport handles open after client/session shutdown on Windows.
// This runner is strictly one-shot, so exit explicitly once all awaited cleanup is done.
await new Promise((resolve) => setImmediate(resolve));
process.exit(process.exitCode ?? 0);
