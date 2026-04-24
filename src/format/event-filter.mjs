import { EVENT_OUTCOME, OWNERSHIP, LIFESPAN } from "../consts.mjs";
import { normalizeOwnership, normalizeLifespan } from "../util/normalize.mjs";
import { compileRegex } from "../util/regex.mjs";

/**
 * Convert legacy classifier fields (includePattern/excludePattern/notifyPattern)
 * into an ordered rule list.
 */
function legacyToRules(source) {
  const rules = [];
  if (source.excludePattern) {
    rules.push({ match: String(source.excludePattern), outcome: EVENT_OUTCOME.DROP });
  }
  if (source.notifyPattern) {
    rules.push({ match: String(source.notifyPattern), outcome: EVENT_OUTCOME.INJECT });
  }
  if (source.includePattern) {
    rules.push({ match: String(source.includePattern), outcome: EVENT_OUTCOME.KEEP });
    rules.push({ match: ".*", outcome: EVENT_OUTCOME.DROP });
  }
  return rules;
}

function compileRules(rules) {
  return rules.map(r => ({
    match: r.match,
    regex: compileRegex(r.match, "rule.match"),
    outcome: r.outcome
  }));
}

export function createEventFilter(source = {}, fallbackOwnership = OWNERSHIP.MODEL_OWNED, fallbackLifespan = LIFESPAN.TEMPORARY) {
  // Support ordered rules array directly, or convert from legacy format
  const rawRules = Array.isArray(source.rules) ? source.rules : legacyToRules(source);

  return {
    rules: compileRules(rawRules),
    ownership: normalizeOwnership(source.ownership ?? source.managedBy, fallbackOwnership),
    lifespan: normalizeLifespan(source.lifespan ?? source.scope, fallbackLifespan)
  };
}

export function evaluateEventFilter(filter, text) {
  if (!filter || !filter.rules) {
    return EVENT_OUTCOME.KEEP;
  }
  for (const rule of filter.rules) {
    if (rule.regex && rule.regex.test(text)) {
      return rule.outcome;
    }
  }
  return EVENT_OUTCOME.KEEP;
}

export function getEventFilterInput(source = {}) {
  if (source.eventFilter && typeof source.eventFilter === "object") {
    return source.eventFilter;
  }
  // Legacy: look for classifier object
  if (source.classifier && typeof source.classifier === "object") {
    return source.classifier;
  }

  return {
    rules: source.rules,
    includePattern: source.includePattern,
    excludePattern: source.excludePattern,
    notifyPattern: source.notifyPattern,
    ownership: source.filterOwnership ?? source.classifierManagedBy ?? source.ownership ?? source.managedBy,
    lifespan: source.lifespan ?? source.scope
  };
}

export function formatEventFilter(filter) {
  if (!filter || !filter.rules || filter.rules.length === 0) {
    return `rules=<none> lifespan=${filter?.lifespan ?? "?"} ownership=${filter?.ownership ?? "?"}`;
  }
  const rulesSummary = filter.rules
    .map(r => `${r.outcome}:${JSON.stringify(r.match)}`)
    .join(", ");
  return `rules=[${rulesSummary}] lifespan=${filter.lifespan} ownership=${filter.ownership}`;
}
