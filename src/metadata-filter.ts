/**
 * metadata-filter.ts — the single, pure source of truth for constructing,
 * validating, and capping AWS Bedrock AgentCore Memory `metadataFilters`, and
 * for assembling the metadata attached to written records.
 *
 * This module performs NO AWS SDK calls and NO network I/O. Every function is
 * a pure transformation over its inputs, which makes the whole filter/metadata
 * construction path exhaustively unit- and property-testable.
 *
 * See `.kiro/specs/structured-metadata-filtering/design.md` for the algorithmic
 * pseudocode and the 8 correctness properties this module upholds.
 */

import type {
  IndexedKeyConfig,
  MetadataConfig,
  MetadataFilterInput,
} from "./config.js";

// ---------------------------------------------------------------------------
// Wire types (canonical shapes passed to the AWS SDK)
// ---------------------------------------------------------------------------

/** The set of metadata-filter operators supported by AgentCore Memory. */
export type FilterOperator =
  | "EQUALS_TO"
  | "CONTAINS"
  | "EXISTS"
  | "NOT_EXISTS"
  | "GREATER_THAN"
  | "GREATER_THAN_OR_EQUALS"
  | "LESS_THAN"
  | "LESS_THAN_OR_EQUALS"
  | "BEFORE"
  | "AFTER";

/** The value variants an AgentCore metadata filter can carry. */
export type MetadataValue =
  | { stringValue: string }
  | { numberValue: number }
  | { stringListValue: string[] }
  | { dateTimeValue: string }; // ISO-8601 UTC

/**
 * The canonical wire-shape filter expression. `right` is present iff the
 * operator requires a value (absent for EXISTS / NOT_EXISTS).
 */
export interface MetadataFilter {
  left: { metadataKey: string };
  operator: FilterOperator;
  right?: { metadataValue: MetadataValue };
}

/** Reasons a candidate filter may be excluded from the final list. */
export type DroppedReason =
  | "empty_key"
  | "unsupported_operator"
  | "missing_value"
  | "operator_value_type_mismatch"
  | "key_not_indexed"
  | "exceeds_max_5_filters";

/** A candidate filter that did not make it into the final list, with a reason. */
export interface DroppedFilter {
  input: MetadataFilterInput;
  reason: DroppedReason;
}

/**
 * Options for {@link buildFilters}.
 *
 * `userFilters` / `defaultFilters` / `createdAfter` / `createdBefore` /
 * `indexedKeys` mirror the design's interface. `enabled` and
 * `dropUnindexedFilters` are threaded through from `MetadataConfig` so the
 * module stays pure (no global config access) while still honoring the
 * feature switch (Requirement 14) and filterability policy (Requirement 10).
 */
export interface BuildFiltersOptions {
  /** When explicitly `false`, short-circuits to an empty result (Requirement 14.1). */
  enabled?: boolean;
  /** Explicit user-supplied filters. */
  userFilters?: MetadataFilterInput[];
  /** Config-driven default filters, applied first. */
  defaultFilters?: MetadataFilterInput[];
  /** Convenience bound → `x-amz-agentcore-memory-createdAt` AFTER. */
  createdAfter?: string | Date;
  /** Convenience bound → `x-amz-agentcore-memory-createdAt` BEFORE. */
  createdBefore?: string | Date;
  /** Declared indexed keys, used for filterability validation. */
  indexedKeys?: IndexedKeyConfig[];
  /** true = drop filters on unknown keys; false = pass through (default true). */
  dropUnindexedFilters?: boolean;
}

/** Result of {@link buildFilters}: the capped survivor list plus dropped reasons. */
export interface BuildFiltersResult {
  /** length <= 5, deduped, AND-combined by the API. */
  filters: MetadataFilter[];
  /** Every rejected / over-cap input, each recorded exactly once with a reason. */
  dropped: DroppedFilter[];
}

/** Options for {@link normalizeOne}. */
export interface NormalizeOptions {
  indexedKeys?: IndexedKeyConfig[];
  dropUnindexedFilters?: boolean;
}

/** Outcome of normalizing a single input into a wire filter. */
export type NormalizeResult =
  | { ok: true; filter: MetadataFilter }
  | { ok: false; reason: DroppedReason };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** AWS hard cap: at most 5 metadata filters per query, AND-combined. */
export const MAX_FILTERS = 5;

/** System timestamp keys (type `dateTimeValue`), filterable without indexing. */
export const SYSTEM_TIMESTAMP_KEYS = {
  createdAt: "x-amz-agentcore-memory-createdAt",
  updatedAt: "x-amz-agentcore-memory-updatedAt",
} as const;

/** Keys that are always filterable regardless of the configured indexed keys. */
export const ALWAYS_FILTERABLE_KEYS: readonly string[] = [
  SYSTEM_TIMESTAMP_KEYS.createdAt,
  SYSTEM_TIMESTAMP_KEYS.updatedAt,
  "x-amz-agentcore-memory-recordType",
];

const SUPPORTED_OPERATORS: readonly FilterOperator[] = [
  "EQUALS_TO",
  "CONTAINS",
  "EXISTS",
  "NOT_EXISTS",
  "GREATER_THAN",
  "GREATER_THAN_OR_EQUALS",
  "LESS_THAN",
  "LESS_THAN_OR_EQUALS",
  "BEFORE",
  "AFTER",
];

const NO_VALUE_OPERATORS: ReadonlySet<string> = new Set(["EXISTS", "NOT_EXISTS"]);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function warn(message: string): void {
  // eslint-disable-next-line no-console
  console.warn(`[agentcore] [metadata] ${message}`);
}

function isSupportedOperator(op: string): op is FilterOperator {
  return (SUPPORTED_OPERATORS as readonly string[]).includes(op);
}

function inferOperator(input: MetadataFilterInput): string {
  if (input.operator) return input.operator;
  return input.value === undefined ? "EXISTS" : "EQUALS_TO";
}

function isFilterable(key: string, indexedKeys: IndexedKeyConfig[]): boolean {
  if (ALWAYS_FILTERABLE_KEYS.includes(key)) return true;
  return indexedKeys.some((ik) => ik && ik.key === key);
}

/**
 * Normalize a `Date` or ISO string to a UTC ISO-8601 string.
 * Returns `null` for invalid dates or unsupported value types
 * (numbers / arrays are not accepted for date operators).
 */
function toUtcIso(value: string | number | string[] | Date): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

function serializeValue(right: MetadataFilter["right"]): string {
  return JSON.stringify(right?.metadataValue ?? null);
}

// ---------------------------------------------------------------------------
// coerceValue — operator → value-variant coercion
// ---------------------------------------------------------------------------

/**
 * Coerce a raw value into the correct `MetadataValue` variant for the given
 * operator. Returns `null` when the value type is incompatible with the
 * operator (the caller records this as `operator_value_type_mismatch`).
 *
 * Coercion table (design.md → Operator → value-variant coercion):
 *   EQUALS_TO / CONTAINS                     → { stringValue }
 *   GREATER_THAN[_OR_EQUALS] / LESS_THAN[..] → { numberValue }
 *   BEFORE / AFTER                           → { dateTimeValue } (UTC ISO-8601)
 *   EXISTS / NOT_EXISTS                      → null (no value)
 */
export function coerceValue(
  operator: FilterOperator,
  value: string | number | string[] | Date,
): MetadataValue | null {
  switch (operator) {
    case "EQUALS_TO":
      if (typeof value === "string") return { stringValue: value };
      if (typeof value === "number" && Number.isFinite(value)) {
        return { stringValue: String(value) };
      }
      return null;

    case "CONTAINS":
      if (typeof value === "string") return { stringValue: value };
      return null;

    case "GREATER_THAN":
    case "GREATER_THAN_OR_EQUALS":
    case "LESS_THAN":
    case "LESS_THAN_OR_EQUALS":
      if (typeof value === "number" && Number.isFinite(value)) {
        return { numberValue: value };
      }
      return null;

    case "BEFORE":
    case "AFTER": {
      const iso = toUtcIso(value);
      return iso === null ? null : { dateTimeValue: iso };
    }

    // EXISTS / NOT_EXISTS carry no value.
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// normalizeOne — a single input → wire filter or drop reason
// ---------------------------------------------------------------------------

/**
 * Normalize one loose {@link MetadataFilterInput} into a canonical
 * {@link MetadataFilter}, or return a drop reason.
 *
 * Order of checks mirrors the design pseudocode:
 *   empty key → operator inference → unsupported operator → filterability →
 *   EXISTS/NOT_EXISTS (no right) → missing value → value coercion.
 */
export function normalizeOne(
  input: MetadataFilterInput,
  options: NormalizeOptions = {},
): NormalizeResult {
  const key = typeof input?.key === "string" ? input.key : "";
  if (key === "") return { ok: false, reason: "empty_key" };

  const operator = inferOperator(input);
  if (!isSupportedOperator(operator)) {
    return { ok: false, reason: "unsupported_operator" };
  }

  const indexedKeys = options.indexedKeys ?? [];
  const dropUnindexedFilters = options.dropUnindexedFilters ?? true;

  // Filterability check: key must be a declared indexed key or an
  // always-filterable system key. Only enforced when indexed keys are declared.
  if (indexedKeys.length > 0 && !isFilterable(key, indexedKeys)) {
    if (dropUnindexedFilters) {
      return { ok: false, reason: "key_not_indexed" };
    }
    // else: pass through and let AWS decide (pass-through mode).
  }

  if (NO_VALUE_OPERATORS.has(operator)) {
    return { ok: true, filter: { left: { metadataKey: key }, operator } };
  }

  if (input.value === undefined) {
    return { ok: false, reason: "missing_value" };
  }

  const metadataValue = coerceValue(operator, input.value);
  if (metadataValue === null) {
    return { ok: false, reason: "operator_value_type_mismatch" };
  }

  return {
    ok: true,
    filter: { left: { metadataKey: key }, operator, right: { metadataValue } },
  };
}

// ---------------------------------------------------------------------------
// buildFilters — capped, deduped, ordered AND-list
// ---------------------------------------------------------------------------

function timestampCandidate(
  operator: "AFTER" | "BEFORE",
  value: string | Date,
): MetadataFilterInput {
  // Normalize Date → UTC ISO here so the candidate value stays a plain string
  // (MetadataFilterInput.value cannot hold a Date). An invalid Date becomes an
  // empty string, which coerceValue rejects as operator_value_type_mismatch.
  let normalized: string;
  if (value instanceof Date) {
    normalized = Number.isNaN(value.getTime()) ? "" : value.toISOString();
  } else {
    normalized = value;
  }
  return { key: SYSTEM_TIMESTAMP_KEYS.createdAt, operator, value: normalized };
}

/**
 * Construct a capped (<=5), deduped, deterministically-ordered AND-filter list.
 *
 * Deterministic candidate order: config defaults → user filters → timestamp
 * bounds (createdAfter→AFTER, createdBefore→BEFORE). This order fixes which
 * filters survive the cap. Never mutates caller inputs.
 */
export function buildFilters(options: BuildFiltersOptions): BuildFiltersResult {
  // Short-circuit no-op when the feature is disabled (Property 7 / Requirement 14.1).
  if (!options || options.enabled === false) {
    return { filters: [], dropped: [] };
  }

  const indexedKeys = options.indexedKeys ?? [];
  const dropUnindexedFilters = options.dropUnindexedFilters ?? true;
  const dropped: DroppedFilter[] = [];

  // 1. Assemble candidates in deterministic order.
  const candidates: MetadataFilterInput[] = [];
  for (const f of options.defaultFilters ?? []) candidates.push(f);
  for (const f of options.userFilters ?? []) candidates.push(f);
  if (options.createdAfter !== undefined) {
    candidates.push(timestampCandidate("AFTER", options.createdAfter));
  }
  if (options.createdBefore !== undefined) {
    candidates.push(timestampCandidate("BEFORE", options.createdBefore));
  }

  // 2. Normalize + validate each candidate independently.
  const normalized: { filter: MetadataFilter; input: MetadataFilterInput }[] = [];
  for (const candidate of candidates) {
    const outcome = normalizeOne(candidate, { indexedKeys, dropUnindexedFilters });
    if (outcome.ok) {
      normalized.push({ filter: outcome.filter, input: candidate });
    } else {
      dropped.push({ input: candidate, reason: outcome.reason });
    }
  }

  // 3. Dedup by (metadataKey, operator, serialized value); keep first occurrence.
  const deduped: { filter: MetadataFilter; input: MetadataFilterInput }[] = [];
  const seen = new Set<string>();
  for (const entry of normalized) {
    const dedupKey = `${entry.filter.left.metadataKey}\u0000${entry.filter.operator}\u0000${serializeValue(entry.filter.right)}`;
    if (!seen.has(dedupKey)) {
      seen.add(dedupKey);
      deduped.push(entry);
    }
  }

  // 4. Enforce the hard AWS cap of 5 filters (AND logic).
  if (deduped.length > MAX_FILTERS) {
    for (const extra of deduped.slice(MAX_FILTERS)) {
      dropped.push({ input: extra.input, reason: "exceeds_max_5_filters" });
    }
  }

  const filters = deduped.slice(0, MAX_FILTERS).map((entry) => entry.filter);
  return { filters, dropped };
}

// ---------------------------------------------------------------------------
// buildRecordMetadata — validated write metadata
// ---------------------------------------------------------------------------

function isKnownKey(key: string, config: MetadataConfig): boolean {
  if ((config.indexedKeys ?? []).some((ik) => ik && ik.key === key)) return true;
  const schema = config.schemaByStrategy ?? {};
  for (const entries of Object.values(schema)) {
    if (Array.isArray(entries) && entries.some((e) => e && e.key === key)) {
      return true;
    }
  }
  return false;
}

function allowedValuesFor(key: string, config: MetadataConfig): string[] | null {
  const schema = config.schemaByStrategy ?? {};
  for (const entries of Object.values(schema)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry && entry.key === key && Array.isArray(entry.allowedValues)) {
        return entry.allowedValues;
      }
    }
  }
  return null;
}

function stringifyMetaValue(value: string | number | string[]): string {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  return value;
}

/**
 * Assemble the flat `Record<string,string>` metadata attached to a written
 * record, merging validated free / strict metadata onto the base metadata.
 *
 * - Strict keys are copied verbatim (no transformation) but only when the key
 *   is a configured `strictKey`; otherwise the key is dropped with a warning.
 * - Free metadata is kept only for known indexed/schema keys; array values are
 *   serialized to strings and `allowedValues` are enforced (invalid keys are
 *   dropped with a warning; all other keys are retained).
 * - When the feature is disabled, the base metadata is returned unchanged.
 */
export function buildRecordMetadata(
  base: Record<string, string>,
  userMeta: Record<string, string | number | string[]> | undefined,
  strictMeta: Record<string, string> | undefined,
  config: MetadataConfig,
): Record<string, string> {
  const result: Record<string, string> = { ...(base ?? {}) };

  // Disabled → behave exactly as today (Requirement 14.2 / Property 7).
  if (!config || config.enabled === false) {
    return result;
  }

  const strictKeys = config.strictKeys ?? [];

  // Strict keys: pass through verbatim, only if declared strict.
  for (const [key, value] of Object.entries(strictMeta ?? {})) {
    if (strictKeys.includes(key)) {
      result[key] = value; // no transformation — deterministic grouping needs the exact value
    } else {
      warn(`strict key not configured, ignored: ${key}`);
    }
  }

  // Free/user metadata: keep only known keys; serialize arrays; enforce allowedValues.
  for (const [key, value] of Object.entries(userMeta ?? {})) {
    if (!isKnownKey(key, config)) {
      warn(`unknown metadata key dropped: ${key}`);
      continue;
    }
    const serialized = stringifyMetaValue(value);
    const allowed = allowedValuesFor(key, config);
    if (allowed && !allowed.includes(serialized)) {
      warn(`value not in allowedValues, dropped: ${key}=${serialized}`);
      continue;
    }
    result[key] = serialized;
  }

  return result;
}
