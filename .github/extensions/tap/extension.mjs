import { joinSession } from "@github/copilot-sdk/extension";

import { createCopilotChannelsRuntime } from "../../../src/tap-runtime.mjs";

const runtime = createCopilotChannelsRuntime({
  cwd: process.cwd()
});

const session = await joinSession({
  tools: runtime.tools,
  hooks: runtime.hooks
});

runtime.attachSession(session);
runtime.appendStreamMessage(runtime.DEFAULT_STREAM, {
  source: "system",
  text: "※ tap loaded."
});

session.on("session.shutdown", () => {
  void runtime.stopAllEmitters();
});
