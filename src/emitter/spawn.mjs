import { spawn } from "node:child_process";
import readline from "node:readline";

export function spawnEmitterProcess(command, cwd) {
  if (process.platform === "win32") {
    return spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", command], {
      cwd,
      env: process.env,
      windowsHide: true
    });
  }

  return spawn("bash", ["-lc", command], {
    cwd,
    env: process.env
  });
}

export function readLines(input, onLine) {
  const reader = readline.createInterface({ input });
  reader.on("line", onLine);
  return reader;
}
