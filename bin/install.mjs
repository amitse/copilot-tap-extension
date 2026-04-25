#!/usr/bin/env node
import { existsSync, mkdirSync, copyFileSync, readFileSync } from "node:fs";
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

function getTargetRoot(scope) {
  if (scope === "global") {
    return path.join(os.homedir(), ".copilot");
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

function install(flags) {
  const targetRoot = getTargetRoot(flags.scope);
  const scopeLabel = flags.scope === "global" ? "global (~/.copilot)" : "local (.github)";
  const packageVersion = getPackageVersion();
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
