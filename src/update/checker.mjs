import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const PKG_NAME = "copilot-tap-extension";
const REGISTRY_URL = `https://registry.npmjs.org/${PKG_NAME}/latest`;

const UPDATE_STATE_DIR = path.join(os.homedir(), ".copilot");
const UPDATE_STATE_FILE = path.join(UPDATE_STATE_DIR, ".tap-update-state.json");
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function getInstalledVersion() {
  try {
    const extensionDir = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.join(extensionDir, "version.json"),
      path.join(extensionDir, "..", "version.json"),
      path.join(extensionDir, "..", "..", "dist", "version.json")
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return JSON.parse(readFileSync(candidate, "utf8")).version;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function readUpdateState() {
  try {
    return JSON.parse(readFileSync(UPDATE_STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeUpdateState(state) {
  try {
    mkdirSync(UPDATE_STATE_DIR, { recursive: true });
    writeFileSync(UPDATE_STATE_FILE, JSON.stringify(state, null, 2) + "\n");
  } catch {
    // Best-effort — never interrupt the session for state persistence.
  }
}

function shouldCheck() {
  const state = readUpdateState();
  if (!state.lastCheckAt) {
    return true;
  }
  return Date.now() - state.lastCheckAt > CHECK_INTERVAL_MS;
}

function recordCheck(latest) {
  const state = readUpdateState();
  state.lastCheckAt = Date.now();
  if (latest) {
    state.latestVersion = latest;
  }
  writeUpdateState(state);
}

async function fetchLatestVersion() {
  const res = await fetch(REGISTRY_URL);
  if (!res.ok) {
    return null;
  }
  const data = await res.json();
  return data.version ?? null;
}

function isNewer(installed, latest) {
  if (!installed || !latest) {
    return !!latest;
  }
  const pa = installed.split(".").map(Number);
  const pb = latest.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pb[i] || 0) > (pa[i] || 0)) {
      return true;
    }
    if ((pb[i] || 0) < (pa[i] || 0)) {
      return false;
    }
  }
  return false;
}

export async function checkForUpdate(sessionPort) {
  try {
    if (!shouldCheck()) {
      return;
    }

    const installed = getInstalledVersion();
    if (!installed) {
      return;
    }

    const latest = await fetchLatestVersion();
    if (!latest) {
      return;
    }

    recordCheck(latest);

    if (!isNewer(installed, latest)) {
      return;
    }

    await sessionPort.log(
      `Update available: v${installed} → v${latest}. Run \`npx ${PKG_NAME}\` to update.`
    );
  } catch {
    // Update check must never break session startup.
  }
}
