import { EVENT_OUTCOME, SOURCE, STREAM } from "../consts.mjs";
import { evaluateEventFilter } from "../format/event-filter.mjs";
import { splitTextLines } from "../util/text.mjs";

export function createLineRouter({ streams, notifications, sessionPort }) {
  function appendSystemMessage(emitter, text, notify = false) {
    streams.append(emitter.stream, {
      source: SOURCE.SYSTEM,
      text,
      monitorName: emitter.name
    });

    if (notify && streams.ensure(emitter.stream).sessionInjector.enabled) {
      notifications.enqueue({
        channel: emitter.stream,
        monitorName: emitter.name,
        stream: STREAM.SYSTEM,
        text
      });
    }
  }

  function handleLine(emitter, rawText, stream, source) {
    const text = String(rawText ?? "").trim();
    if (!text) {
      return;
    }

    const outcome = evaluateEventFilter(emitter.eventFilter, text);

    if (outcome === EVENT_OUTCOME.DROP) {
      emitter.droppedLineCount += 1;
      return;
    }

    emitter.lineCount += 1;
    streams.append(emitter.stream, {
      source,
      text,
      monitorName: emitter.name,
      stream
    });

    if (outcome === EVENT_OUTCOME.SURFACE) {
      if (sessionPort && sessionPort.log) {
        sessionPort.log(`[${emitter.name}] ${text}`);
      }
    } else if (outcome === EVENT_OUTCOME.INJECT) {
      notifications.enqueue({
        channel: emitter.stream,
        monitorName: emitter.name,
        stream,
        text
      });
    }
  }

  function handleTextBlock(emitter, value, stream, source) {
    for (const line of splitTextLines(value)) {
      handleLine(emitter, line, stream, source);
    }
  }

  return { handleLine, handleTextBlock, appendSystemMessage };
}
