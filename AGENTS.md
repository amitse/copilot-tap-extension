# Contributor instructions for ※ tap

## Build, validate, and test

```bash
npm run check          # Syntax check (fast, run after every change)
npm run build          # Bundle extension.mjs + copy artifacts to dist/
npm run evals:smoke    # Smoke test — verifies the extension loads and tools are visible
npm run evals:run      # Full eval suite
```

After making code changes, always rebuild and reinstall locally for the changes to take effect in your Copilot session:

```bash
npm run build && node bin/install.mjs
```

The installed extension at `~/.copilot/extensions/tap/` is a built artifact — editing source files alone does not update it.

## Publishing

**"Publish" means `git push` to main.** Do not run `npm publish` manually.

The GitHub Actions workflow (`.github/workflows/publish.yml`) automatically publishes to npm when the package.json version differs from the published version. The workflow is:

1. Bump version: `npm version patch -m "v%s"` (or `minor`/`major`)
2. Push: `git push && git push --tags`
3. GitHub Actions builds, checks, and publishes to npm automatically

## Project structure

Source code lives in `src/`, not `.github/`. The `.github/` directory is only for GitHub workflows.

- `src/extension.mjs` — Extension entry point (bundled by esbuild into `dist/extension.mjs`)
- `src/tap-runtime.mjs` — Runtime factory that wires all subsystems together
- `src/copilot-instructions.md` — User-facing agent instructions (installed to `~/.copilot/`)
- `src/skills/loop/SKILL.md` — The `/loop` skill definition
- `bin/install.mjs` — CLI installer (smart: detects fresh install vs update automatically)

## Key conventions

### COPILOT_HOME

The Copilot CLI config directory is not hardcoded to `~/.copilot`. It is determined by the `COPILOT_HOME` environment variable, falling back to `~/.copilot`. All code that references the config directory must use this pattern:

```js
const copilotHome = process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
```

### PromptEmitters use `session.send()`, not `session.sendAndWait()`

Prompt emitters dispatch prompts fire-and-forget via `session.send()`. The model responds directly to the user — one event, no duplication. Using `sendAndWait()` would cause the response to appear twice (once from the model, once from the notification re-injection).

### Installer behavior

`bin/install.mjs` auto-detects whether this is a fresh install or an update:

- **Fresh install** — copies all artifacts (extension, version.json, skills, copilot-instructions)
- **Already installed** — updates only core files (extension.mjs + version.json), preserves user-customizable artifacts
- **Same version** — exits with "already up to date"
- `--full` forces a complete install even if already installed
