import { DELIVERY, SOURCE, STREAM } from "../consts.mjs";
import { splitTextLines } from "../util/text.mjs";

export function createLineRouter({ channels, notifications }) {
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
    if (stream === STREAM.STDERR && monitor.includeStderr === false) {
      return false;
    }

    const channel = channels.ensure(monitor.channel);
    if (!channel.subscription.enabled) {
      return false;
    }

    if (channel.subscription.delivery === DELIVERY.ALL) {
      return true;
    }

    if (monitor.classifier.notifyRegex) {
      return monitor.classifier.notifyRegex.test(line);
    }

    return false;
  }

  function appendSystemMessage(monitor, text, notify = false) {
    channels.append(monitor.channel, {
      source: SOURCE.SYSTEM,
      text,
      monitorName: monitor.name
    });

    if (notify && channels.ensure(monitor.channel).subscription.enabled) {
      notifications.enqueue({
        channel: monitor.channel,
        monitorName: monitor.name,
        stream: STREAM.SYSTEM,
        text
      });
    }
  }

  function handleLine(monitor, rawText, stream, source) {
    const text = String(rawText ?? "").trim();
    if (!text) {
      return;
    }

    if (!classifierAllowsLine(monitor, text)) {
      monitor.droppedLineCount += 1;
      return;
    }

    monitor.lineCount += 1;
    channels.append(monitor.channel, {
      source,
      text,
      monitorName: monitor.name,
      stream
    });

    if (shouldNotifySubscribers(monitor, text, stream)) {
      notifications.enqueue({
        channel: monitor.channel,
        monitorName: monitor.name,
        stream,
        text
      });
    }
  }

  function handleTextBlock(monitor, value, stream, source) {
    for (const line of splitTextLines(value)) {
      handleLine(monitor, line, stream, source);
    }
  }

  return { handleLine, handleTextBlock, appendSystemMessage };
}
