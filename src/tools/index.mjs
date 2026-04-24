import { createStreamTools } from "./channels.mjs";
import { createEmitterTools } from "./monitors.mjs";

export function createTools(deps) {
  return [
    ...createStreamTools(deps),
    ...createEmitterTools(deps)
  ];
}
