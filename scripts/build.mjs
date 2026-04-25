#!/usr/bin/env node
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");

// 1. Bundle extension.mjs
const result = await build({
  entryPoints: [path.join(root, ".github", "extensions", "tap", "extension.mjs")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile: path.join(dist, "extension.mjs"),
  external: ["@github/copilot-sdk", "@github/copilot-sdk/*"],
  banner: {
    js: "// ※ tap — copilot-tap-extension (bundled)\n// https://github.com/amitse/copilot-tap-extension\n"
  },
  logLevel: "info"
});

if (result.errors.length === 0) {
  console.log("✓ dist/extension.mjs built successfully");
}

// 2. Copy loop skill
mkdirSync(path.join(dist, "skills", "loop"), { recursive: true });
copyFileSync(
  path.join(root, ".github", "skills", "loop", "SKILL.md"),
  path.join(dist, "skills", "loop", "SKILL.md")
);
console.log("✓ dist/skills/loop/SKILL.md copied");

// 3. Copy copilot-instructions.md
copyFileSync(
  path.join(root, ".github", "copilot-instructions.md"),
  path.join(dist, "copilot-instructions.md")
);
console.log("✓ dist/copilot-instructions.md copied");
