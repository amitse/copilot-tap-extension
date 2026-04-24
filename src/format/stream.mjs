export function formatSessionInjector(stream) {
  const sessionInjector = stream.sessionInjector;
  const state = sessionInjector.enabled ? "on" : "off";
  return `sessionInjector=${state} delivery=${sessionInjector.delivery} lifespan=${sessionInjector.lifespan} ownership=${sessionInjector.ownership}`;
}

export function formatStream(stream) {
  const latest = stream.entries[stream.entries.length - 1];
  const latestSummary = latest ? ` latest=${JSON.stringify(latest.text.slice(0, 80))}` : "";
  const description = stream.description ? ` description=${JSON.stringify(stream.description)}` : "";
  return `- ${stream.name}: messages=${stream.entries.length}${description} ${formatSessionInjector(stream)}${latestSummary}`;
}

export function formatStreamHistory(stream, limit) {
  const entries = stream.entries.slice(-limit);
  if (entries.length === 0) {
    return `Stream '${stream.name}' is empty.`;
  }

  return [
    `Stream '${stream.name}' (${entries.length} of ${stream.entries.length} entries):`,
    ...entries.map((entry) => {
      const emitterLabel = entry.monitorName ? ` emitter=${entry.monitorName}` : "";
      const streamLabel = entry.stream ? ` stream=${entry.stream}` : "";
      return `[${entry.timestamp}] source=${entry.source}${emitterLabel}${streamLabel} ${entry.text}`;
    })
  ].join("\n");
}
