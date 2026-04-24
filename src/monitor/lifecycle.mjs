import {
  EXECUTION_MODE,
  MONITOR_STATUS,
  RUN_STATUS,
  SOURCE,
  STREAM,
  WORK_TYPE
} from "../consts.mjs";
import { nowIso } from "../util/time.mjs";
import { toText } from "../util/text.mjs";
import { isTerminalMonitorStatus } from "../util/policy.mjs";
import { describeMonitorWork } from "../format/monitor.mjs";
import { readLines, spawnMonitorProcess } from "./spawn.mjs";

export function createLifecycle({ lineRouter, sessionPort }) {
  function wireStreams(monitor) {
    const child = monitor.process;
    monitor.stdoutReader = readLines(child.stdout, (line) => {
      lineRouter.handleLine(monitor, line, STREAM.STDOUT, SOURCE.MONITOR);
    });
    monitor.stderrReader = readLines(child.stderr, (line) => {
      lineRouter.handleLine(monitor, line, STREAM.STDERR, SOURCE.MONITOR_STDERR);
    });
  }

  function closeStreams(monitor) {
    if (monitor.stdoutReader) {
      monitor.stdoutReader.close();
      monitor.stdoutReader = null;
    }
    if (monitor.stderrReader) {
      monitor.stderrReader.close();
      monitor.stderrReader = null;
    }
  }

  function startContinuousProcess(monitor) {
    let child;
    try {
      child = spawnMonitorProcess(monitor.command, monitor.cwd);
    } catch (error) {
      throw new Error(`Failed to start monitor '${monitor.name}': ${error.message}`);
    }

    monitor.process = child;
    monitor.status = MONITOR_STATUS.RUNNING;
    wireStreams(monitor);

    child.on("error", (error) => {
      monitor.status = MONITOR_STATUS.ERROR;
      monitor.process = null;
      lineRouter.appendSystemMessage(monitor, `Monitor '${monitor.name}' failed: ${error.message}`, true);
      void sessionPort.log(`Monitor '${monitor.name}' failed: ${error.message}`, { level: "warning" });
    });

    child.on("exit", (code, signal) => {
      monitor.status = monitor.stopRequested ? MONITOR_STATUS.STOPPED : MONITOR_STATUS.EXITED;
      monitor.exitCode = code;
      monitor.stoppedAt = nowIso();
      monitor.process = null;
      monitor.stdoutReader = null;
      monitor.stderrReader = null;

      const exitMessage = monitor.stopRequested
        ? `Monitor '${monitor.name}' stopped.`
        : `Monitor '${monitor.name}' exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}.`;
      lineRouter.appendSystemMessage(monitor, exitMessage, !monitor.stopRequested);
      void sessionPort.log(exitMessage);
    });

    lineRouter.appendSystemMessage(
      monitor,
      `Monitor '${monitor.name}' started with ${describeMonitorWork(monitor)}.`
    );
  }

  async function runCommandLoopIteration(monitor) {
    let child;
    try {
      child = spawnMonitorProcess(monitor.command, monitor.cwd);
    } catch (error) {
      return { ok: false, error: error.message };
    }

    monitor.process = child;
    wireStreams(monitor);

    return await new Promise((resolve) => {
      let settled = false;

      const finish = (result) => {
        if (settled) {
          return;
        }
        settled = true;

        closeStreams(monitor);
        monitor.process = null;
        monitor.exitCode = result.code ?? monitor.exitCode;
        resolve(result);
      };

      child.on("error", (error) => {
        finish({ ok: false, error: error.message });
      });

      child.on("exit", (code, signal) => {
        finish({
          ok: (code ?? 0) === 0 || monitor.stopRequested,
          code,
          signal,
          error: (code ?? 0) === 0 || monitor.stopRequested
            ? null
            : `Command iteration exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`
        });
      });
    });
  }

  async function runPromptIteration(monitor) {
    try {
      const response = await sessionPort.sendAndWait(monitor.prompt);
      const responseText = toText(response?.data?.content ?? response?.data ?? response);

      if (responseText.trim()) {
        lineRouter.handleTextBlock(monitor, responseText, STREAM.PROMPT, SOURCE.MONITOR_PROMPT);
      } else {
        lineRouter.appendSystemMessage(
          monitor,
          `Monitor '${monitor.name}' received an empty response from prompt work.`
        );
      }

      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error.message,
        deferred:
          monitor.executionMode === EXECUTION_MODE.LOOP &&
          /\bsession\.idle\b/i.test(String(error?.message ?? ""))
      };
    }
  }

  function scheduleIteration(monitor, delayMs = 0) {
    if (monitor.stopRequested) {
      return;
    }

    if (monitor.timer) {
      clearTimeout(monitor.timer);
    }

    monitor.status = delayMs > 0 ? MONITOR_STATUS.WAITING : MONITOR_STATUS.QUEUED;
    monitor.timer = setTimeout(() => {
      monitor.timer = null;
      void runScheduledIteration(monitor);
    }, delayMs);
  }

  async function runScheduledIteration(monitor) {
    if (monitor.stopRequested || monitor.inFlight) {
      return;
    }

    monitor.inFlight = true;
    monitor.status = MONITOR_STATUS.RUNNING;
    monitor.runCount += 1;
    monitor.lastRunAt = nowIso();

    const result = monitor.workType === WORK_TYPE.PROMPT
      ? await runPromptIteration(monitor)
      : await runCommandLoopIteration(monitor);

    monitor.inFlight = false;

    if (monitor.stopRequested) {
      monitor.status = MONITOR_STATUS.STOPPED;
      monitor.stoppedAt = nowIso();
      lineRouter.appendSystemMessage(monitor, `Monitor '${monitor.name}' stopped.`);
      return;
    }

    if (result.ok) {
      monitor.lastRunStatus = RUN_STATUS.SUCCESS;

      if (monitor.executionMode === EXECUTION_MODE.ONCE) {
        monitor.status = MONITOR_STATUS.COMPLETED;
        monitor.stoppedAt = nowIso();
        lineRouter.appendSystemMessage(
          monitor,
          `Monitor '${monitor.name}' completed one run of ${monitor.workType} work.`
        );
        return;
      }

      monitor.status = MONITOR_STATUS.WAITING;
      scheduleIteration(monitor, monitor.everyMs);
      return;
    }

    if (result.deferred) {
      monitor.status = MONITOR_STATUS.WAITING;
      lineRouter.appendSystemMessage(
        monitor,
        `Monitor '${monitor.name}' deferred this prompt run because the session was still busy. Next attempt in ${monitor.every}.`
      );
      scheduleIteration(monitor, monitor.everyMs);
      return;
    }

    monitor.lastRunStatus = RUN_STATUS.FAILURE;
    lineRouter.appendSystemMessage(
      monitor,
      `Monitor '${monitor.name}' iteration failed: ${result.error ?? "unknown error"}.`,
      true
    );
    void sessionPort.log(
      `Monitor '${monitor.name}' iteration failed: ${result.error ?? "unknown error"}.`,
      { level: "warning" }
    );

    if (monitor.executionMode === EXECUTION_MODE.ONCE) {
      monitor.status = MONITOR_STATUS.ERROR;
      monitor.stoppedAt = nowIso();
      return;
    }

    monitor.status = MONITOR_STATUS.WAITING;
    scheduleIteration(monitor, monitor.everyMs);
  }

  function startScheduled(monitor) {
    const scheduleLabel = monitor.executionMode === EXECUTION_MODE.LOOP
      ? `every ${monitor.every}`
      : EXECUTION_MODE.ONCE;
    const initialDelayMs =
      monitor.executionMode === EXECUTION_MODE.LOOP && monitor.workType === WORK_TYPE.PROMPT
        ? monitor.everyMs
        : 0;
    const firstRunLabel =
      monitor.executionMode === EXECUTION_MODE.LOOP && monitor.workType === WORK_TYPE.PROMPT
        ? ` First run in ${monitor.every}.`
        : "";
    lineRouter.appendSystemMessage(
      monitor,
      `Monitor '${monitor.name}' queued ${monitor.workType} work (${scheduleLabel}) with ${describeMonitorWork(monitor)}.${firstRunLabel}`
    );
    scheduleIteration(monitor, initialDelayMs);
  }

  function start(monitor) {
    if (monitor.executionMode === EXECUTION_MODE.PROCESS) {
      startContinuousProcess(monitor);
    } else {
      startScheduled(monitor);
    }
  }

  async function stop(monitor) {
    if (isTerminalMonitorStatus(monitor.status)) {
      return;
    }

    monitor.stopRequested = true;
    void sessionPort.log(`Stop requested for monitor '${monitor.name}'.`);

    if (monitor.timer) {
      clearTimeout(monitor.timer);
      monitor.timer = null;
    }

    if (!monitor.process && !monitor.inFlight) {
      monitor.status = MONITOR_STATUS.STOPPED;
      monitor.stoppedAt = nowIso();
      lineRouter.appendSystemMessage(monitor, `Monitor '${monitor.name}' stopped.`);
      void sessionPort.log(`Monitor '${monitor.name}' stopped.`);
      return;
    }

    monitor.status = MONITOR_STATUS.STOPPING;
    closeStreams(monitor);

    if (monitor.process) {
      monitor.process.kill();
    }
  }

  return { start, stop };
}
