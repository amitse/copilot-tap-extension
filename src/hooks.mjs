import { BRAND, COPILOT_INSTRUCTIONS_PATH, DEFAULT_STREAM, DEFAULT_STREAM_DESCRIPTION, OWNERSHIP, LIFESPAN } from "./consts.mjs";
import { checkForUpdate } from "./update/checker.mjs";

function sessionInjectorSummary(streams) {
  const subscribed = streams.list().filter((stream) => stream.sessionInjector.enabled);

  if (subscribed.length === 0) {
    return "";
  }

  return [
    "Session injectors:",
    ...subscribed.map(
      (stream) =>
        `- ${stream.name} delivery=${stream.sessionInjector.delivery} lifespan=${stream.sessionInjector.lifespan} ownership=${stream.sessionInjector.ownership}`
    )
  ].join("\n");
}

async function applyPersistentConfig({ baseCwd, streams, configStore, supervisor, sessionPort, setBaseCwd }) {
  setBaseCwd(baseCwd);
  const configLoad = configStore.load(baseCwd);

  for (const entry of configStore.getStreams()) {
    streams.applyPersistentStream(entry);
  }

  let started = 0;
  for (const entry of configStore.getEmitters()) {
    if (entry.autoStart === false) {
      continue;
    }

    try {
      await supervisor.start(
        {
          ...entry,
          scope: LIFESPAN.PERSISTENT,
          managedBy: entry.ownership ?? OWNERSHIP.USER_OWNED
        },
        {
          baseCwd,
          scope: LIFESPAN.PERSISTENT,
          managedBy: entry.ownership ?? OWNERSHIP.USER_OWNED,
          subscribe: false,
          force: true
        }
      );
      started += 1;
    } catch (error) {
      await sessionPort.log(`Failed to auto-start emitter '${entry.name}': ${error.message}`, {
        level: "warning"
      });
    }
  }

  return configLoad.found
    ? `Loaded ${configStore.getStreams().length} event streams and ${configStore.getEmitters().length} persistent emitter definitions from ${configLoad.filePath}. Auto-started ${started}.`
    : "No copilot-channels config file found.";
}

export function createHooks({ streams, configStore, supervisor, sessionPort, setBaseCwd }) {
  return {
    onSessionStart: async (input) => {
      streams.ensure(DEFAULT_STREAM, DEFAULT_STREAM_DESCRIPTION);

      // Fire-and-forget update check — never blocks session start.
      checkForUpdate(sessionPort).catch(() => {});

      let configSummary = "No config loaded.";
      try {
        configSummary = await applyPersistentConfig({
          baseCwd: input.cwd,
          streams,
          configStore,
          supervisor,
          sessionPort,
          setBaseCwd
        });
        await sessionPort.log(configSummary);
      } catch (error) {
        configSummary = `Config load failed: ${error.message}`;
        await sessionPort.log(configSummary, { level: "warning" });
      }

      return {
        additionalContext: [
          `${BRAND} is active.`,
          "Use event emitters to run background commands or prompts; use event filters to control which events are kept, surfaced, or injected; use session injectors when you want events surfaced or injected into the session.",
          "Session injector updates are sent immediately from emitter output and do not wait for transcript events.",
          `Repo guidance is available at ${COPILOT_INSTRUCTIONS_PATH} if you want to read the project-specific instructions.`,
          configSummary,
          sessionInjectorSummary(streams)
        ]
          .filter(Boolean)
          .join("\n")
      };
    },

    onUserPromptSubmitted: async () => {
      const summary = sessionInjectorSummary(streams);
      if (!summary) {
        return undefined;
      }
      return { additionalContext: summary };
    },

    onSessionEnd: async () => {
      await supervisor.stopAll();
      return {
        sessionSummary: `${BRAND} tracked ${streams.size()} event streams and ${configStore.getEmitters().length} persistent emitter definitions.`,
        cleanupActions: [`Stopped session emitters managed by ${BRAND}.`]
      };
    }
  };
}
