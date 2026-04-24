const states = [
  "booting",
  "ready",
  "healthy",
  "warning: sample drift detected",
  "healthy",
  "error: sample exception observed"
];

let index = 0;

const timer = setInterval(() => {
  const state = states[index % states.length];
  const timestamp = new Date().toISOString();
  console.log(`[heartbeat] ${timestamp} ${state}`);
  if (state.startsWith("error")) {
    console.error(`[heartbeat] ${timestamp} stderr mirror for ${state}`);
  }
  index += 1;
}, 2500);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    clearInterval(timer);
    process.exit(0);
  });
}
