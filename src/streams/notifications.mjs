import { NOTIFICATION_BATCH_SIZE } from "../consts.mjs";

export function buildNotificationPrompt(batch) {
  return [
    "※ tap — background event stream update:",
    ...batch.map((item) => {
      const streamLabel = item.stream ? `/${item.stream}` : "";
      return `- stream=${item.channel} emitter=${item.monitorName}${streamLabel}: ${item.text}`;
    }),
    "Only react if the update matters to the current task."
  ].join("\n");
}

export function createNotificationDispatcher({ sessionPort }) {
  const queue = [];
  let inFlight = false;

  async function flush() {
    if (inFlight || queue.length === 0) {
      return;
    }

    inFlight = true;
    const batch = queue.splice(0, NOTIFICATION_BATCH_SIZE);

    try {
      await sessionPort.send(buildNotificationPrompt(batch));
    } catch (error) {
      await sessionPort.log(`Failed to dispatch monitor update: ${error.message}`, { level: "warning" });
    } finally {
      inFlight = false;
      if (queue.length > 0) {
        void flush();
      }
    }
  }

  function enqueue(notification) {
    queue.push(notification);
    void flush();
  }

  return { enqueue };
}
