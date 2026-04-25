#!/usr/bin/env node
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..");
const distDir = path.join(pkgRoot, "dist");

const BRAND = "※ tap";
const EXT_DIR_NAME = "tap";

function usage() {
  console.log(`
${BRAND} — Copilot CLI extension installer

Usage:
  npx copilot-tap-extension [options]

Options:
  --global, -g     Install to ~/.copilot/  (default)
  --local,  -l     Install to .github/  (project-scoped)
  --force,  -f     Overwrite existing files without prompting
  --help,   -h     Show this help message

Installs:
  extensions/tap/extension.mjs    The bundled ※ tap extension
  skills/loop/SKILL.md            The /loop skill for prompt-based loops
  copilot-instructions.md         Agent instructions for using ※ tap
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = { scope: "global", force: false, help: false };
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
      case "--force":
      case "-f":
        flags.force = true;
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

function copyArtifact(src, dest, label, flags) {
  if (!existsSync(src)) {
    console.error(`  ✗ ${label}: source not found (${src})`);
    return false;
  }
  if (existsSync(dest) && !flags.force) {
    console.log(`  ⊘ ${label}: already exists, skipping (use --force to overwrite)`);
    return true;
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log(`  ✓ ${label}`);
  return true;
}

function install(flags) {
  const targetRoot = getTargetRoot(flags.scope);
  const scopeLabel = flags.scope === "global" ? "global (~/.copilot)" : "local (.github)";

  console.log(`\n${BRAND} — installing (${scopeLabel})\n`);

  const artifacts = [
    {
      src: path.join(distDir, "extension.mjs"),
      dest: path.join(targetRoot, "extensions", EXT_DIR_NAME, "extension.mjs"),
      label: "extensions/tap/extension.mjs"
    },
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

  let allOk = true;
  for (const { src, dest, label } of artifacts) {
    if (!copyArtifact(src, dest, label, flags)) {
      allOk = false;
    }
  }

  console.log();
  if (allOk) {
    console.log(`✓ ${BRAND} installed to ${targetRoot}`);
  } else {
    console.error(`⚠  Some artifacts could not be installed.`);
    process.exit(1);
  }
}

const flags = parseArgs(process.argv);

if (flags.help) {
  usage();
  process.exit(0);
}

install(flags);
