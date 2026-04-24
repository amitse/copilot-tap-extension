import { DEFAULT_STREAM } from "./consts.mjs";
import { createSessionPort } from "./session/port.mjs";
import { createStreamStore } from "./streams/store.mjs";
import { createNotificationDispatcher } from "./streams/notifications.mjs";
import { createConfigStore } from "./config/store.mjs";
import { createEmitterSupervisor } from "./emitter/supervisor.mjs";
import { createTools } from "./tools/index.mjs";
import { createHooks } from "./hooks.mjs";

export function createCopilotChannelsRuntime(options = {}) {
  let baseCwd = options.cwd ?? process.cwd();
  const getBaseCwd = () => baseCwd;
  const setBaseCwd = (next) => {
    baseCwd = next;
  };

  const sessionPort = createSessionPort(options.session ?? null);
  const streams = createStreamStore();
  const configStore = createConfigStore({ cwd: baseCwd });
  const notifications = createNotificationDispatcher({ sessionPort });
  const persist = () => configStore.save();
  const supervisor = createEmitterSupervisor({
    streams,
    configStore,
    notifications,
    sessionPort,
    getBaseCwd,
    persist
  });

  const tools = createTools({ streams, configStore, supervisor, sessionPort, getBaseCwd, persist });
  const hooks = createHooks({ streams, configStore, supervisor, sessionPort, setBaseCwd });

  return {
    attachSession: (nextSession) => sessionPort.attach(nextSession),
    tools,
    hooks,
    stopAllEmitters: () => supervisor.stopAll(),
    appendStreamMessage: (name, entry) => streams.append(name, entry),
    DEFAULT_STREAM
  };
}
