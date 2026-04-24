import {
  EMITTER_STATUS,
  EMITTER_TYPE,
  RUN_SCHEDULE,
  RUN_STATUS,
  SOURCE,
  STREAM
} from "../consts.mjs";
import { nowIso } from "../util/time.mjs";
import { toText } from "../util/text.mjs";
import { isTerminalEmitterStatus } from "../util/policy.mjs";
import { describeEmitterWork } from "../format/emitter.mjs";
import { readLines, spawnEmitterProcess } from "./spawn.mjs";

export function createLifecycle({ lineRouter, sessionPort }) {
  function wireStreams(emitter) {
    const child = emitter.process;
    emitter.stdoutReader = readLines(child.stdout, (line) => {
      lineRouter.handleLine(emitter, line, STREAM.STDOUT, SOURCE.EMITTER);
    });
    emitter.stderrReader = readLines(child.stderr, (line) => {
      lineRouter.handleLine(emitter, line, STREAM.STDERR, SOURCE.EMITTER_STDERR);
    });
  }

  function closeStreams(emitter) {
    if (emitter.stdoutReader) {
      emitter.stdoutReader.close();
      emitter.stdoutReader = null;
    }
    if (emitter.stderrReader) {
      emitter.stderrReader.close();
      emitter.stderrReader = null;
    }
  }

  function startContinuousProcess(emitter) {
    let child;
    try {
      child = spawnEmitterProcess(emitter.command, emitter.cwd);
    } catch (error) {
      throw new Error(`Failed to start emitter '${emitter.name}': ${error.message}`);
    }

    emitter.process = child;
    emitter.status = EMITTER_STATUS.RUNNING;
    wireStreams(emitter);

    child.on("error", (error) => {
      emitter.status = EMITTER_STATUS.ERROR;
      emitter.process = null;
      lineRouter.appendSystemMessage(emitter, `Emitter '${emitter.name}' failed: ${error.message}`, true);
      void sessionPort.log(`Emitter '${emitter.name}' failed: ${error.message}`, { level: "warning" });
    });

    child.on("exit", (code, signal) => {
      emitter.status = emitter.stopRequested ? EMITTER_STATUS.STOPPED : EMITTER_STATUS.EXITED;
      emitter.exitCode = code;
      emitter.stoppedAt = nowIso();
      emitter.process = null;
      emitter.stdoutReader = null;
      emitter.stderrReader = null;

      const exitMessage = emitter.stopRequested
        ? `Emitter '${emitter.name}' stopped.`
        : `Emitter '${emitter.name}' exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}.`;
      lineRouter.appendSystemMessage(emitter, exitMessage, !emitter.stopRequested);
      void sessionPort.log(exitMessage);
    });

    lineRouter.appendSystemMessage(
      emitter,
      `Emitter '${emitter.name}' started with ${describeEmitterWork(emitter)}.`
    );
  }

  async function runCommandLoopIteration(emitter) {
    let child;
    try {
      child = spawnEmitterProcess(emitter.command, emitter.cwd);
    } catch (error) {
      return { ok: false, error: error.message };
    }

    emitter.process = child;
    wireStreams(emitter);

    return await new Promise((resolve) => {
      let settled = false;

      const finish = (result) => {
        if (settled) {
          return;
        }
        settled = true;

        closeStreams(emitter);
        emitter.process = null;
        emitter.exitCode = result.code ?? emitter.exitCode;
        resolve(result);
      };

      child.on("error", (error) => {
        finish({ ok: false, error: error.message });
      });

      child.on("exit", (code, signal) => {
        finish({
          ok: (code ?? 0) === 0 || emitter.stopRequested,
          code,
          signal,
          error: (code ?? 0) === 0 || emitter.stopRequested
            ? null
            : `Command iteration exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`
        });
      });
    });
  }

  async function runPromptIteration(emitter) {
    try {
      const response = await sessionPort.sendAndWait(emitter.prompt);
      const responseText = toText(response?.data?.content ?? response?.data ?? response);

      if (responseText.trim()) {
        lineRouter.handlePromptResult(emitter, responseText);
      } else {
        lineRouter.appendSystemMessage(
          emitter,
          `Emitter '${emitter.name}' received an empty response from prompt work.`
        );
      }

      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error.message,
        deferred:
          emitter.runSchedule === RUN_SCHEDULE.TIMED &&
          /\bsession\.idle\b/i.test(String(error?.message ?? ""))
      };
    }
  }

  function scheduleIteration(emitter, delayMs = 0) {
    if (emitter.stopRequested) {
      return;
    }

    if (emitter.timer) {
      clearTimeout(emitter.timer);
    }

    emitter.status = delayMs > 0 ? EMITTER_STATUS.WAITING : EMITTER_STATUS.QUEUED;
    emitter.timer = setTimeout(() => {
      emitter.timer = null;
      void runScheduledIteration(emitter);
    }, delayMs);
  }

  async function runScheduledIteration(emitter) {
    if (emitter.stopRequested || emitter.inFlight) {
      return;
    }

    emitter.inFlight = true;
    emitter.status = EMITTER_STATUS.RUNNING;
    emitter.runCount += 1;
    emitter.lastRunAt = nowIso();

    const result = emitter.emitterType === EMITTER_TYPE.PROMPT
      ? await runPromptIteration(emitter)
      : await runCommandLoopIteration(emitter);

    emitter.inFlight = false;

    if (emitter.stopRequested) {
      emitter.status = EMITTER_STATUS.STOPPED;
      emitter.stoppedAt = nowIso();
      lineRouter.appendSystemMessage(emitter, `Emitter '${emitter.name}' stopped.`);
      return;
    }

    if (result.ok) {
      emitter.lastRunStatus = RUN_STATUS.SUCCESS;

      if (emitter.runSchedule === RUN_SCHEDULE.ONE_TIME) {
        emitter.status = EMITTER_STATUS.COMPLETED;
        emitter.stoppedAt = nowIso();
        lineRouter.appendSystemMessage(
          emitter,
          `Emitter '${emitter.name}' completed one run of ${emitter.emitterType} work.`
        );
        return;
      }

      emitter.status = EMITTER_STATUS.WAITING;
      scheduleIteration(emitter, emitter.everyMs);
      return;
    }

    if (result.deferred) {
      emitter.status = EMITTER_STATUS.WAITING;
      lineRouter.appendSystemMessage(
        emitter,
        `Emitter '${emitter.name}' deferred this prompt run because the session was still busy. Next attempt in ${emitter.every}.`
      );
      scheduleIteration(emitter, emitter.everyMs);
      return;
    }

    emitter.lastRunStatus = RUN_STATUS.FAILURE;
    lineRouter.appendSystemMessage(
      emitter,
      `Emitter '${emitter.name}' iteration failed: ${result.error ?? "unknown error"}.`,
      true
    );
    void sessionPort.log(
      `Emitter '${emitter.name}' iteration failed: ${result.error ?? "unknown error"}.`,
      { level: "warning" }
    );

    if (emitter.runSchedule === RUN_SCHEDULE.ONE_TIME) {
      emitter.status = EMITTER_STATUS.ERROR;
      emitter.stoppedAt = nowIso();
      return;
    }

    emitter.status = EMITTER_STATUS.WAITING;
    scheduleIteration(emitter, emitter.everyMs);
  }

  function startScheduled(emitter) {
    const scheduleLabel = emitter.runSchedule === RUN_SCHEDULE.TIMED
      ? `every ${emitter.every}`
      : RUN_SCHEDULE.ONE_TIME;
    const initialDelayMs =
      emitter.runSchedule === RUN_SCHEDULE.TIMED && emitter.emitterType === EMITTER_TYPE.PROMPT
        ? emitter.everyMs
        : 0;
    const firstRunLabel =
      emitter.runSchedule === RUN_SCHEDULE.TIMED && emitter.emitterType === EMITTER_TYPE.PROMPT
        ? ` First run in ${emitter.every}.`
        : "";
    lineRouter.appendSystemMessage(
      emitter,
      `Emitter '${emitter.name}' queued ${emitter.emitterType} work (${scheduleLabel}) with ${describeEmitterWork(emitter)}.${firstRunLabel}`
    );
    scheduleIteration(emitter, initialDelayMs);
  }

  function start(emitter) {
    if (emitter.runSchedule === RUN_SCHEDULE.CONTINUOUS) {
      startContinuousProcess(emitter);
    } else {
      startScheduled(emitter);
    }
  }

  async function stop(emitter) {
    if (isTerminalEmitterStatus(emitter.status)) {
      return;
    }

    emitter.stopRequested = true;
    void sessionPort.log(`Stop requested for emitter '${emitter.name}'.`);

    if (emitter.timer) {
      clearTimeout(emitter.timer);
      emitter.timer = null;
    }

    if (!emitter.process && !emitter.inFlight) {
      emitter.status = EMITTER_STATUS.STOPPED;
      emitter.stoppedAt = nowIso();
      lineRouter.appendSystemMessage(emitter, `Emitter '${emitter.name}' stopped.`);
      void sessionPort.log(`Emitter '${emitter.name}' stopped.`);
      return;
    }

    emitter.status = EMITTER_STATUS.STOPPING;
    closeStreams(emitter);

    if (emitter.process) {
      emitter.process.kill();
    }
  }

  return { start, stop };
}
