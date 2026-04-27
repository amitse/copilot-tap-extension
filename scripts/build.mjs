#!/usr/bin/env node
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");

// 1. Bundle extension.mjs
const result = await build({
  entryPoints: [path.join(root, "src", "extension.mjs")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile: path.join(dist, "extension.mjs"),
  external: ["@github/copilot-sdk", "@github/copilot-sdk/*"],
  banner: {
    js: [
      "// ※ tap — copilot-tap-extension (bundled)",
      "// https://github.com/amitse/copilot-tap-extension",
      "import { createRequire as __tap_createRequire } from 'node:module';",
      "const require = __tap_createRequire(import.meta.url);"
    ].join("\n")
  },
  logLevel: "info"
});

if (result.errors.length === 0) {
  console.log("✓ dist/extension.mjs built successfully");
}

// 2. Copy loop skill
mkdirSync(path.join(dist, "skills", "loop"), { recursive: true });
copyFileSync(
  path.join(root, "src", "skills", "loop", "SKILL.md"),
  path.join(dist, "skills", "loop", "SKILL.md")
);
console.log("✓ dist/skills/loop/SKILL.md copied");

// 3. Copy create-provider skill
mkdirSync(path.join(dist, "skills", "create-provider"), { recursive: true });
copyFileSync(
  path.join(root, "src", "skills", "create-provider", "SKILL.md"),
  path.join(dist, "skills", "create-provider", "SKILL.md")
);
console.log("✓ dist/skills/create-provider/SKILL.md copied");

// 3. Copy copilot-instructions.md
copyFileSync(
  path.join(root, "src", "copilot-instructions.md"),
  path.join(dist, "copilot-instructions.md")
);
console.log("✓ dist/copilot-instructions.md copied");

// 4. Write version.json
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
writeFileSync(
  path.join(dist, "version.json"),
  JSON.stringify({ version: pkg.version }, null, 2) + "\n"
);
console.log(`✓ dist/version.json written (v${pkg.version})`);
