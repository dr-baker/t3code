import type {
  UsageCategoryCost,
  UsageCostSource,
  UsageModelPriceOverride,
  UsageTokenTotals,
  OrchestrationV2ThreadProjection,
  ThreadCost,
  RunId,
} from "@t3tools/contracts";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@t3tools/shared/model";

import type { UsageRecord, UsageSpeed } from "@t3tools/provider-core/server/usage";

import fallbackPrices from "./usagePriceFallbacks.json" with { type: "json" };

export interface TokenRates {
  readonly inputCostPerToken: number;
  readonly outputCostPerToken: number;
  readonly cacheReadCostPerToken: number;
  readonly cacheCreationCostPerToken: number;
  /** Cache writes with a 1-hour TTL; the 5-minute rate when unpublished. */
  readonly cacheCreation1hCostPerToken: number;
}

interface SpeedRates extends TokenRates {
  readonly fast: TokenRates | null;
  readonly ultrafast: TokenRates | null;
}

/** A request whose prompt exceeds `thresholdTokens` bills every token at this tier. */
interface ContextTier {
  readonly thresholdTokens: number;
  readonly rate: SpeedRates;
}

/** Omits LiteLLM's flex and batches variants, which transcripts do not record. */
export interface ModelRate extends SpeedRates {
  /** Sorted by descending threshold. */
  readonly contextTiers: readonly ContextTier[];
}

export type RateTable = ReadonlyMap<string, ModelRate>;

export function createOverrideRateTable(
  overrides: Readonly<Record<string, UsageModelPriceOverride>>,
): RateTable {
  return new Map(
    Object.entries(overrides).map(([model, prices]) => {
      const cacheCreationCostPerToken =
        (prices.cacheWriteCostPerMillionTokens ?? prices.inputCostPerMillionTokens) / 1_000_000;
      return [
        model.trim(),
        {
          inputCostPerToken: prices.inputCostPerMillionTokens / 1_000_000,
          outputCostPerToken: prices.outputCostPerMillionTokens / 1_000_000,
          cacheReadCostPerToken:
            (prices.cacheReadCostPerMillionTokens ?? prices.inputCostPerMillionTokens) / 1_000_000,
          cacheCreationCostPerToken,
          cacheCreation1hCostPerToken: cacheCreationCostPerToken,
          fast: null,
          ultrafast: null,
          contextTiers: [],
        },
      ];
    }),
  );
}

type LiteLlmEntry = Readonly<Record<string, unknown>>;

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Missing cache rates fall back to input pricing, and a missing 1-hour write rate to the 5-minute one.
function readTokenRates(
  entry: LiteLlmEntry,
  suffix: string,
  standard?: TokenRates,
  outputFallback?: number,
): TokenRates | null {
  const input = finiteNumber(entry[`input_cost_per_token${suffix}`]);
  const output = finiteNumber(entry[`output_cost_per_token${suffix}`]) ?? outputFallback ?? null;
  if (input === null || output === null) return null;
  const cacheRate = (
    name: string,
    field: "cacheReadCostPerToken" | "cacheCreationCostPerToken" | "cacheCreation1hCostPerToken",
    fallback = input,
  ) =>
    finiteNumber(entry[`${name}${suffix}`]) ??
    (standard !== undefined && standard.inputCostPerToken > 0
      ? (standard[field] / standard.inputCostPerToken) * input
      : fallback);
  const cacheCreationCostPerToken = cacheRate(
    "cache_creation_input_token_cost",
    "cacheCreationCostPerToken",
  );
  return {
    inputCostPerToken: input,
    outputCostPerToken: output,
    cacheReadCostPerToken: cacheRate("cache_read_input_token_cost", "cacheReadCostPerToken"),
    cacheCreationCostPerToken,
    cacheCreation1hCostPerToken: cacheRate(
      "cache_creation_input_token_cost_above_1hr",
      "cacheCreation1hCostPerToken",
      cacheCreationCostPerToken,
    ),
  };
}

function scaleTokenRates(rates: TokenRates, multiple: number): TokenRates {
  return {
    inputCostPerToken: rates.inputCostPerToken * multiple,
    outputCostPerToken: rates.outputCostPerToken * multiple,
    cacheReadCostPerToken: rates.cacheReadCostPerToken * multiple,
    cacheCreationCostPerToken: rates.cacheCreationCostPerToken * multiple,
    cacheCreation1hCostPerToken: rates.cacheCreation1hCostPerToken * multiple,
  };
}

function fastMultiplier(entry: LiteLlmEntry): number | null {
  const specific = entry["provider_specific_entry"];
  if (typeof specific !== "object" || specific === null) return null;
  const fast = finiteNumber((specific as Record<string, unknown>)["fast"]);
  return fast !== null && fast > 0 ? fast : null;
}

function readSpeedRates(entry: LiteLlmEntry, standard: TokenRates, suffix = ""): SpeedRates {
  const multiple = fastMultiplier(entry);
  return {
    ...standard,
    fast:
      multiple === null
        ? readTokenRates(entry, `${suffix}_priority`, standard)
        : scaleTokenRates(standard, multiple),
    ultrafast: readTokenRates(entry, `${suffix}_ultrafast`, standard),
  };
}

const CONTEXT_TIER_INPUT_KEY =
  /^input_cost_per_token_above_(\d{1,7})k_tokens(?:_priority|_ultrafast)?$/;

// Fields a tier omits fall back to base rates, so a priority-only tier still prices standard requests at base.
function readContextTiers(entry: LiteLlmEntry, base: TokenRates): ContextTier[] {
  const thresholds = new Set<string>();
  for (const key of Object.keys(entry)) {
    const match = CONTEXT_TIER_INPUT_KEY.exec(key);
    if (match !== null) thresholds.add(match[1]!);
  }
  return [...thresholds]
    .map((threshold) => {
      const suffix = `_above_${threshold}k_tokens`;
      const standard = readTokenRates(entry, suffix, base, base.outputCostPerToken) ?? base;
      return {
        thresholdTokens: Number(threshold) * 1_000,
        rate: readSpeedRates(entry, standard, suffix),
      };
    })
    .toSorted((a, b) => b.thresholdTokens - a.thresholdTokens);
}

// LiteLLM prefixes for the model makers' own APIs; their price beats a cloud's or reseller's for a bare name.
const FIRST_PARTY_PROVIDERS = new Set([
  "anthropic",
  "deepseek",
  "gemini",
  "meta",
  "mistral",
  "openai",
  "xai",
]);

/** Drops models missing input or output rates to avoid understating cost. */
export function parseRateTable(document: unknown): RateTable {
  const table = new Map<string, ModelRate>();
  if (typeof document !== "object" || document === null) return table;

  for (const [name, raw] of Object.entries(document as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as LiteLlmEntry;
    const standard = readTokenRates(entry, "");
    if (standard === null) continue;

    const key = normalizeRateKey(name);
    if (key.length === 0) continue;
    table.set(key, {
      ...readSpeedRates(entry, standard),
      contextTiers: readContextTiers(entry, standard),
    });
  }

  const aliasCandidates = new Map<string, { rate: ModelRate | null; firstParty: boolean }>();
  for (const [key, rate] of table) {
    const slash = key.indexOf("/");
    const alias = slash === -1 ? bedrockBaseModelName(key) : bareModelName(key);
    if (alias.length === 0 || alias === key || table.has(alias)) continue;
    const firstParty = slash !== -1 && FIRST_PARTY_PROVIDERS.has(key.slice(0, slash));
    const held = aliasCandidates.get(alias);
    if (held === undefined || (firstParty && !held.firstParty)) {
      aliasCandidates.set(alias, { rate, firstParty });
    } else if (held.rate !== null && firstParty === held.firstParty) {
      aliasCandidates.set(alias, { rate: mergeAliasRate(held.rate, rate), firstParty });
    }
  }
  for (const [alias, { rate }] of aliasCandidates) {
    if (rate !== null) table.set(alias, rate);
  }

  return table;
}

function sameTokenRates(a: TokenRates | null, b: TokenRates | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.inputCostPerToken === b.inputCostPerToken &&
    a.outputCostPerToken === b.outputCostPerToken &&
    a.cacheReadCostPerToken === b.cacheReadCostPerToken &&
    a.cacheCreationCostPerToken === b.cacheCreationCostPerToken &&
    a.cacheCreation1hCostPerToken === b.cacheCreation1hCostPerToken
  );
}

// Resellers often omit speed and context tiers, so a missing tier fills from the other entry instead of conflicting.
function mergeSpeedRates(a: SpeedRates, b: SpeedRates): SpeedRates | null {
  const fast = a.fast ?? b.fast;
  const ultrafast = a.ultrafast ?? b.ultrafast;
  if (
    !sameTokenRates(a, b) ||
    !sameTokenRates(fast, b.fast ?? fast) ||
    !sameTokenRates(ultrafast, b.ultrafast ?? ultrafast)
  ) {
    return null;
  }
  return { ...a, fast, ultrafast };
}

function mergeContextTiers(
  a: readonly ContextTier[],
  b: readonly ContextTier[],
): readonly ContextTier[] | null {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  if (a.length !== b.length) return null;
  const merged: ContextTier[] = [];
  for (const [index, tier] of a.entries()) {
    const other = b[index]!;
    const rate = mergeSpeedRates(tier.rate, other.rate);
    if (tier.thresholdTokens !== other.thresholdTokens || rate === null) return null;
    merged.push({ thresholdTokens: tier.thresholdTokens, rate });
  }
  return merged;
}

function mergeAliasRate(a: ModelRate, b: ModelRate): ModelRate | null {
  const speeds = mergeSpeedRates(a, b);
  const contextTiers = mergeContextTiers(a.contextTiers, b.contextTiers);
  return speeds === null || contextTiers === null ? null : { ...speeds, contextTiers };
}

function promptTokens(totals: UsageTokenTotals): number {
  return totals.uncachedInputTokens + totals.cachedInputTokens + totals.cacheCreationTokens;
}

// A tier without the requested speed keeps the base tier's rate for that speed.
function ratesAt(rate: ModelRate, speed: UsageSpeed, totals: UsageTokenTotals): TokenRates {
  const prompt = promptTokens(totals);
  const tier = rate.contextTiers.find((tier) => prompt > tier.thresholdTokens)?.rate;
  if (speed === "standard") return tier ?? rate;
  return tier?.[speed] ?? rate[speed] ?? tier ?? rate;
}

function normalizeRateKey(model: string): string {
  return model.trim().toLowerCase();
}

function bareModelName(key: string): string {
  const slash = key.lastIndexOf("/");
  return slash === -1 ? key : key.slice(slash + 1);
}

// Only Bedrock's base ID gives a bare alias; its regional (us., eu.) and GovCloud IDs carry markups.
function bedrockBaseModelName(key: string): string {
  return key.startsWith("anthropic.") ? key.slice("anthropic.".length) : key;
}

// Price Claude's bracketed context variants at the base tier, the only name the rate table knows.
function stripVariantSuffix(key: string): string {
  const bracket = key.indexOf("[");
  return bracket === -1 ? key : key.slice(0, bracket);
}

// Synthetic messages are unbilled; bare family names are generation-ambiguous and remain unpriced.
const UNPRICEABLE_MODELS = new Set([
  "<synthetic>",
  "synthetic",
  "opus",
  "sonnet",
  "haiku",
  "fable",
]);

// Immutable tables permit caching rates across twice-per-record pricing lookups.
const resolvedRates = new WeakMap<RateTable, Map<string, ModelRate | null>>();

export function lookupRate(table: RateTable, model: string): ModelRate | null {
  let resolved = resolvedRates.get(table);
  if (resolved === undefined) {
    resolved = new Map();
    resolvedRates.set(table, resolved);
  }
  let rate = resolved.get(model);
  if (rate === undefined) {
    rate = resolveRate(table, model);
    resolved.set(model, rate);
  }
  return rate ?? lookupFallbackRate(model);
}

/** A priceable model the table has no rate for; a newer table may list it. */
export function isUnlistedModel(table: RateTable, model: string): boolean {
  const bareName = bareModelName(stripVariantSuffix(normalizeRateKey(model)));
  return (
    bareName.length > 0 && !UNPRICEABLE_MODELS.has(bareName) && lookupRate(table, model) === null
  );
}

function resolveRate(table: RateTable, model: string): ModelRate | null {
  const key = stripVariantSuffix(normalizeRateKey(model));
  const bareName = bareModelName(key);
  if (bareName.length === 0 || UNPRICEABLE_MODELS.has(bareName)) return null;
  return table.get(key) ?? (fallbackRates.has(key) ? table.get(bareName) : null) ?? null;
}

const fallbackRates = parseRateTable(fallbackPrices.models);
const fallbackPromotionEndsAt = Date.parse(fallbackPrices.ultrafastPromotion.endsAt);
const withoutUltrafastPromotion = (rate: SpeedRates): SpeedRates => ({
  ...rate,
  ultrafast:
    rate.ultrafast === null
      ? null
      : scaleTokenRates(rate.ultrafast, fallbackPrices.ultrafastPromotion.listPriceMultiplier),
});
const fallbackListRates: RateTable = new Map(
  [...fallbackRates].map(([model, rate]) => [
    model,
    {
      ...withoutUltrafastPromotion(rate),
      contextTiers: rate.contextTiers.map((tier) => ({
        ...tier,
        rate: withoutUltrafastPromotion(tier.rate),
      })),
    },
  ]),
);

function lookupFallbackRate(model: string): ModelRate | null {
  const key = stripVariantSuffix(normalizeRateKey(model));
  if (!fallbackRates.has(key)) return null;
  // @effect-diagnostics-next-line globalDate:off
  const rates = Date.now() < fallbackPromotionEndsAt ? fallbackRates : fallbackListRates;
  return rates.get(key) ?? null;
}

export type PricedRecord = Pick<
  UsageRecord,
  "model" | "rateModel" | "totals" | "cacheCreation1hTokens" | "speed" | "reportedCostUsd"
>;

function recordRate(table: RateTable, record: PricedRecord): ModelRate | null {
  const rate = record.rateModel === undefined ? null : lookupRate(table, record.rateModel);
  return rate ?? lookupRate(table, record.model);
}

export interface PricedUsage {
  readonly costUsd: number;
  readonly costSource: UsageCostSource;
  readonly categoryCostUsd: UsageCategoryCost | null;
  readonly speedPremiumUsd: number;
}

function costByCategory(record: PricedRecord, rates: TokenRates): UsageCategoryCost {
  const { totals } = record;
  const oneHour = Math.min(record.cacheCreation1hTokens ?? 0, totals.cacheCreationTokens);
  return {
    input: totals.uncachedInputTokens * rates.inputCostPerToken,
    cacheRead: totals.cachedInputTokens * rates.cacheReadCostPerToken,
    cacheWrite:
      (totals.cacheCreationTokens - oneHour) * rates.cacheCreationCostPerToken +
      oneHour * rates.cacheCreation1hCostPerToken,
    output: totals.outputTokens * rates.outputCostPerToken,
  };
}

function sumCategories(cost: UsageCategoryCost): number {
  return cost.input + cost.cacheRead + cost.cacheWrite + cost.output;
}

/** Reasoning tokens are already included in outputTokens; do not charge twice. */
export function priceUsage(
  table: RateTable,
  record: PricedRecord,
  overrides?: RateTable,
): PricedUsage {
  const { model, totals, reportedCostUsd } = record;
  const override = overrides?.get(model.trim());
  const reported =
    override === undefined && reportedCostUsd !== null && Number.isFinite(reportedCostUsd)
      ? reportedCostUsd
      : null;
  const unsplit = (costUsd: number, costSource: UsageCostSource): PricedUsage => ({
    costUsd,
    costSource,
    categoryCostUsd: null,
    speedPremiumUsd: 0,
  });
  const rate = override ?? recordRate(table, record);
  if (rate === null) {
    return reported === null ? unsplit(0, "unpriced") : unsplit(reported, "providerReported");
  }

  const listCost = costByCategory(record, ratesAt(rate, record.speed, totals));
  const listCostUsd = sumCategories(listCost);
  if (reported !== null && listCostUsd <= 0) return unsplit(reported, "providerReported");
  const premiumUsd =
    record.speed === "standard"
      ? 0
      : listCostUsd - sumCategories(costByCategory(record, ratesAt(rate, "standard", totals)));
  const scale = reported === null ? 1 : reported / listCostUsd;
  return {
    costUsd: reported ?? listCostUsd,
    costSource: reported === null ? "modelPriced" : "providerReported",
    categoryCostUsd: {
      input: listCost.input * scale,
      cacheRead: listCost.cacheRead * scale,
      cacheWrite: listCost.cacheWrite * scale,
      output: listCost.output * scale,
    },
    speedPremiumUsd: premiumUsd * scale,
  };
}

export function cacheSavingsUsd(
  table: RateTable,
  record: PricedRecord,
  overrides?: RateTable,
): number {
  const rate = overrides?.get(record.model.trim()) ?? recordRate(table, record);
  if (rate === null) return 0;
  const rates = ratesAt(rate, record.speed, record.totals);
  return record.totals.cachedInputTokens * (rates.inputCostPerToken - rates.cacheReadCostPerToken);
}

export function priceThreadUsage(
  projection: {
    readonly runs: ReadonlyArray<
      Pick<OrchestrationV2ThreadProjection["runs"][number], "id" | "modelSelection">
    >;
    readonly attempts: ReadonlyArray<
      Pick<OrchestrationV2ThreadProjection["attempts"][number], "id" | "runId">
    >;
    readonly providerTurns: ReadonlyArray<
      Pick<
        OrchestrationV2ThreadProjection["providerTurns"][number],
        "status" | "runAttemptId" | "turnTokenUsage"
      >
    >;
  },
  rates: RateTable,
  overrides: RateTable,
  aliases: ReadonlyMap<string, string>,
): ThreadCost {
  const runs = new Map(projection.runs.map((run) => [run.id, run]));
  const attempts = new Map(projection.attempts.map((attempt) => [attempt.id, attempt]));
  const costsByRun = new Map<
    RunId,
    { runId: RunId; costUsd: number; pricedTurns: number; unpricedTurns: number; partial: boolean }
  >();
  let unattributedTurns = 0;
  for (const turn of projection.providerTurns) {
    if (turn.status === "pending" || turn.status === "running") continue;
    const attempt = turn.runAttemptId === null ? undefined : attempts.get(turn.runAttemptId);
    const run = attempt === undefined ? undefined : runs.get(attempt.runId);
    if (run === undefined) {
      unattributedTurns += 1;
      continue;
    }
    const cost = costsByRun.get(run.id) ?? {
      runId: run.id,
      costUsd: 0,
      pricedTurns: 0,
      unpricedTurns: 0,
      partial: false,
    };
    costsByRun.set(run.id, cost);
    const selection = run.modelSelection;
    const usage = turn.turnTokenUsage;
    if (
      usage === undefined ||
      usage.usageStatus === "unavailable" ||
      usage.inputTokens === undefined ||
      usage.outputTokens === undefined
    ) {
      cost.unpricedTurns += 1;
      continue;
    }
    const tier =
      getModelSelectionStringOptionValue(selection, "serviceTier") ??
      (getModelSelectionBooleanOptionValue(selection, "fastMode") === true ? "fast" : "standard");
    const speed =
      tier === "ultrafast"
        ? "ultrafast"
        : tier === "priority" || tier === "fast"
          ? "fast"
          : "standard";
    const cachedInputTokens = usage.cachedInputTokens ?? 0;
    const cacheCreationTokens = usage.cacheCreationTokens ?? 0;
    const priced = priceUsage(
      rates,
      {
        model: aliases.get(selection.model) ?? selection.model,
        speed,
        reportedCostUsd: null,
        totals: {
          uncachedInputTokens: Math.max(
            0,
            usage.inputTokens - cachedInputTokens - cacheCreationTokens,
          ),
          cachedInputTokens,
          cacheCreationTokens,
          outputTokens: usage.outputTokens,
          reasoningTokens: usage.reasoningTokens ?? 0,
        },
      },
      overrides,
    );
    if (priced.costSource === "unpriced") {
      cost.unpricedTurns += 1;
    } else {
      cost.pricedTurns += 1;
      cost.costUsd += priced.costUsd;
      cost.partial ||= usage.usageStatus !== "complete" || usage.hasSubagents;
    }
  }
  const runCosts = [...costsByRun.values()].map((cost) => ({
    ...cost,
    costUsd: cost.pricedTurns === 0 ? null : cost.costUsd,
    partial: cost.partial || cost.unpricedTurns > 0,
  }));
  let costUsd = 0;
  let pricedTurns = 0;
  let unpricedTurns = unattributedTurns;
  let partial = unattributedTurns > 0;
  for (const cost of runCosts) {
    costUsd += cost.costUsd ?? 0;
    pricedTurns += cost.pricedTurns;
    unpricedTurns += cost.unpricedTurns;
    partial ||= cost.partial;
  }
  return {
    costUsd: pricedTurns === 0 ? null : costUsd,
    pricedTurns,
    unpricedTurns,
    partial,
    runs: runCosts,
  };
}
