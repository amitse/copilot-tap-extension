#!/usr/bin/env node
import { existsSync, mkdirSync, copyFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..");
const distDir = path.join(pkgRoot, "dist");

const BRAND = "※ tap";
const EXT_DIR_NAME = "tap";

function getPackageVersion() {
  try {
    return JSON.parse(readFileSync(path.join(distDir, "version.json"), "utf8")).version;
  } catch {
    return JSON.parse(readFileSync(path.join(pkgRoot, "package.json"), "utf8")).version;
  }
}

function usage() {
  console.log(`
${BRAND} — Copilot CLI extension installer

Usage:
  npx copilot-tap-extension [options]

If ※ tap is already installed, updates core files (extension + version)
and preserves customizable artifacts. If fresh, does a full install.

Options:
  --global, -g     Install to ~/.copilot/  (default)
  --local,  -l     Install to .github/  (project-scoped)
  --full           Force a full install even if already installed
  --help,  -h      Show this help message

Installs:
  extensions/tap/extension.mjs    The bundled ※ tap extension
  extensions/tap/version.json     Installed version metadata
  skills/loop/SKILL.md            The /loop skill for prompt-based loops
  skills/provider/SKILL.md        The /provider skill for scaffolding providers
  copilot-instructions.md         Agent instructions for using ※ tap
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = { scope: "global", full: false, help: false };
  for (const arg of args) {
    switch (arg) {
      case "--global":
      case "-g":
        flags.scope = "global";
        break;
      case "--local":
      case "-l":
        flags.scope = "local";
        break;
      case "--full":
        flags.full = true;
        break;
      // Keep legacy flags working
      case "--force":
      case "-f":
      case "--update":
      case "-u":
        break;
      case "--help":
      case "-h":
        flags.help = true;
        break;
      default:
        console.error(`Unknown option: ${arg}`);
        usage();
        process.exit(1);
    }
  }
  return flags;
}

function getCopilotHome() {
  return process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
}

function getTargetRoot(scope) {
  if (scope === "global") {
    return getCopilotHome();
  }
  return path.join(process.cwd(), ".github");
}

function copyArtifact(src, dest, label) {
  if (!existsSync(src)) {
    console.error(`  ✗ ${label}: source not found (${src})`);
    return false;
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log(`  ✓ ${label}`);
  return true;
}

function getInstalledVersion(targetRoot) {
  try {
    const versionFile = path.join(targetRoot, "extensions", EXT_DIR_NAME, "version.json");
    return JSON.parse(readFileSync(versionFile, "utf8")).version;
  } catch {
    return null;
  }
}

function isAlreadyInstalled(targetRoot) {
  return existsSync(path.join(targetRoot, "extensions", EXT_DIR_NAME, "extension.mjs"));
}

function isCopilotCliInstalled() {
  if (existsSync(getCopilotHome())) {
    return true;
  }
  try {
    execFileSync("copilot", ["--version"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function install(flags) {
  const targetRoot = getTargetRoot(flags.scope);
  const scopeLabel = flags.scope === "global" ? "global (~/.copilot)" : "local (.github)";
  const packageVersion = getPackageVersion();

  if (flags.scope === "global" && !isCopilotCliInstalled()) {
    console.log(`\n⚠  Copilot CLI does not appear to be installed.`);
    console.log(`   Install it first: https://docs.github.com/en/copilot/github-copilot-in-the-cli`);
    console.log(`   Then re-run: npx copilot-tap-extension\n`);
    process.exit(1);
  }

  const installed = isAlreadyInstalled(targetRoot);
  const isUpdate = installed && !flags.full;

  if (isUpdate) {
    const installedVersion = getInstalledVersion(targetRoot);
    if (installedVersion && installedVersion === packageVersion) {
      console.log(`\n${BRAND} — already up to date (v${installedVersion})\n`);
      process.exit(0);
    }
    const fromLabel = installedVersion ? `v${installedVersion}` : "unknown";
    console.log(`\n${BRAND} — updating ${fromLabel} → v${packageVersion} (${scopeLabel})\n`);
  } else {
    console.log(`\n${BRAND} — installing v${packageVersion} (${scopeLabel})\n`);
  }

  const coreArtifacts = [
    {
      src: path.join(distDir, "extension.mjs"),
      dest: path.join(targetRoot, "extensions", EXT_DIR_NAME, "extension.mjs"),
      label: "extensions/tap/extension.mjs"
    },
    {
      src: path.join(distDir, "version.json"),
      dest: path.join(targetRoot, "extensions", EXT_DIR_NAME, "version.json"),
      label: "extensions/tap/version.json"
    }
  ];

  const ancillaryArtifacts = [
    {
      src: path.join(distDir, "skills", "loop", "SKILL.md"),
      dest: path.join(targetRoot, "skills", "loop", "SKILL.md"),
      label: "skills/loop/SKILL.md"
    },
    {
      src: path.join(distDir, "skills", "provider", "SKILL.md"),
      dest: path.join(targetRoot, "skills", "provider", "SKILL.md"),
      label: "skills/provider/SKILL.md"
    },
    {
      src: path.join(distDir, "copilot-instructions.md"),
      dest: path.join(targetRoot, "copilot-instructions.md"),
      label: "copilot-instructions.md"
    }
  ];

  const artifacts = isUpdate ? coreArtifacts : [...coreArtifacts, ...ancillaryArtifacts];

  let allOk = true;
  for (const { src, dest, label } of artifacts) {
    if (!copyArtifact(src, dest, label)) {
      allOk = false;
    }
  }

  console.log();
  if (allOk) {
    const verb = isUpdate ? "updated" : "installed";
    console.log(`✓ ${BRAND} ${verb} to ${targetRoot}`);
  } else {
    console.error(`⚠  Some artifacts could not be ${isUpdate ? "updated" : "installed"}.`);
    process.exit(1);
  }
}

const flags = parseArgs(process.argv);

if (flags.help) {
  usage();
  process.exit(0);
}

install(flags);
