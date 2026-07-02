export type MemoryStrategy =
  | "SEMANTIC"
  | "USER_PREFERENCE"
  | "EPISODIC"
  | "SUMMARY";

export type NamespaceMode = "per-agent" | "per-user" | "shared" | "custom";

export interface ScopesConfig {
  agentAccess: Record<string, string[]>;
  writeAccess: Record<string, string[]>;
}

/** A metadata key declared filterable at memory-creation time (max 10 per memory). */
export interface IndexedKeyConfig {
  key: string;
  type: "STRING" | "STRINGLIST" | "NUMBER";
}

/** Per-strategy metadata schema entry (informational + validation + optional provisioning). */
export interface MetadataSchemaEntry {
  key: string;
  type: "STRING" | "STRINGLIST" | "NUMBER";
  extractionType?: "LLM_INFERRED" | "STRICTLY_CONSISTENT"; // default LLM_INFERRED
  definition?: string; // required by AWS for LLM_INFERRED
  allowedValues?: string[]; // -> stringValidation.allowedValues (max 10)
}

/** Loose caller-facing filter shape (normalized into a wire filter by metadata-filter.ts). */
export interface MetadataFilterInput {
  key: string;
  operator?: string; // default inferred from value / EQUALS_TO
  value?: string | number | string[]; // omitted for EXISTS / NOT_EXISTS
}

/** Structured-metadata-filtering configuration added to PluginConfig. */
export interface MetadataConfig {
  /** Master switch (default false = current behavior). */
  enabled: boolean;
  /** Declared indexed keys (<=10); informational + validation. */
  indexedKeys: IndexedKeyConfig[];
  /** Per-strategy metadata schema (docs/validation/optional provisioning). */
  schemaByStrategy: Partial<Record<MemoryStrategy, MetadataSchemaEntry[]>>;
  /** Subset of indexedKeys treated as deterministic (<=3 per strategy). */
  strictKeys: string[];
  /** Filters applied automatically on recall/auto-recall. */
  defaultRecallFilters: MetadataFilterInput[];
  /** true = drop filters on unknown keys; false = pass through for AWS to evaluate. */
  dropUnindexedFilters: boolean;
}

export interface PluginConfig {
  enabled: boolean;
  memoryId: string;
  awsRegion: string;
  awsProfile?: string;
  strategies: MemoryStrategy[];
  autoRecallTopK: number;
  autoCaptureEnabled: boolean;
  autoCaptureMinLength: number;
  noiseFilterEnabled: boolean;
  adaptiveRetrievalEnabled: boolean;
  namespaceMode: NamespaceMode;
  scopes: ScopesConfig;
  eventExpiryDays: number;
  showScores: boolean;
  scoreGapEnabled: boolean;
  scoreGapMultiplier: number;
  minScoreFloor: number;
  noisePatterns: string[];
  bypassPatterns: string[];
  statsCacheTtlMs: number;
  fileSyncEnabled: boolean;
  fileSyncPaths: string[];
  maxRetries: number;
  timeoutMs: number;
  metadata: MetadataConfig;
}

const DEFAULTS: PluginConfig = {
  enabled: true,
  memoryId: "",
  awsRegion: "us-east-1",
  strategies: ["SEMANTIC", "USER_PREFERENCE", "EPISODIC", "SUMMARY"],
  autoRecallTopK: 5,
  autoCaptureEnabled: true,
  autoCaptureMinLength: 80,
  noiseFilterEnabled: true,
  adaptiveRetrievalEnabled: true,
  namespaceMode: "per-agent",
  scopes: { agentAccess: {}, writeAccess: {} },
  eventExpiryDays: 90,
  showScores: false,
  scoreGapEnabled: true,
  scoreGapMultiplier: 2.0,
  minScoreFloor: 0.0,
  noisePatterns: [],
  bypassPatterns: [],
  statsCacheTtlMs: 5 * 60 * 1000,
  fileSyncEnabled: true,
  // Default empty — OpenClaw already injects bootstrap files (SOUL.md, USER.md, etc.)
  // into the prompt. Sync is only useful for files NOT in the Project Context.
  // Example: fileSyncPaths: ["docs/api-reference.md", "projects/*/context.md"]
  fileSyncPaths: [],
  maxRetries: 3,
  timeoutMs: 10000,
  // Structured metadata filtering is inert by default: enabled=false preserves
  // exact pre-feature behavior on every read/write path (Requirement 14).
  metadata: {
    enabled: false,
    indexedKeys: [],
    schemaByStrategy: {},
    strictKeys: [],
    defaultRecallFilters: [],
    dropUnindexedFilters: true,
  },
};

function str(
  env: string | undefined,
  raw: unknown,
  fallback: string,
): string;
function str(
  env: string | undefined,
  raw: unknown,
  fallback: undefined,
): string | undefined;
function str(
  env: string | undefined,
  raw: unknown,
  fallback: string | undefined,
): string | undefined {
  if (env !== undefined && env !== "") return env;
  if (typeof raw === "string" && raw !== "") return raw;
  return fallback;
}

function num(
  env: string | undefined,
  raw: unknown,
  fallback: number,
): number {
  if (env !== undefined && env !== "") {
    const n = Number(env);
    if (!Number.isNaN(n)) return n;
  }
  if (typeof raw === "number" && !Number.isNaN(raw)) return raw;
  return fallback;
}

function bool(
  env: string | undefined,
  raw: unknown,
  fallback: boolean,
): boolean {
  if (env !== undefined && env !== "") return env === "true" || env === "1";
  if (typeof raw === "boolean") return raw;
  return fallback;
}

function arr<T>(raw: unknown, fallback: T[]): T[] {
  if (Array.isArray(raw) && raw.length > 0) return raw as T[];
  return fallback;
}

function parseCommaSeparated(
  env: string | undefined,
  raw: unknown,
  fallback: string[],
): string[] {
  if (env !== undefined && env !== "") {
    return env.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === "string" && s !== "");
  return fallback;
}

const INDEXED_KEY_TYPES = ["STRING", "STRINGLIST", "NUMBER"] as const;

function normalizeIndexedKeyType(value: string): IndexedKeyConfig["type"] {
  const upper = value.trim().toUpperCase();
  return (INDEXED_KEY_TYPES as readonly string[]).includes(upper)
    ? (upper as IndexedKeyConfig["type"])
    : "STRING";
}

/**
 * Parse a comma-separated list of `key:type` pairs (env) or an array of
 * `{ key, type }` objects (raw) into IndexedKeyConfig[]. A pair without a
 * `:type` suffix defaults to STRING; validation of counts/types/charset is
 * left to validateMetadataConfig.
 */
function parseIndexedKeys(
  env: string | undefined,
  raw: unknown,
  fallback: IndexedKeyConfig[],
): IndexedKeyConfig[] {
  if (env !== undefined && env !== "") {
    return env
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((pair) => {
        const idx = pair.indexOf(":");
        if (idx === -1) return { key: pair, type: "STRING" as const };
        return {
          key: pair.slice(0, idx).trim(),
          type: normalizeIndexedKeyType(pair.slice(idx + 1)),
        };
      })
      .filter((k) => k.key !== "");
  }
  if (Array.isArray(raw)) {
    return raw
      .filter(
        (e): e is { key: string; type?: string } =>
          typeof e === "object" &&
          e !== null &&
          typeof (e as { key?: unknown }).key === "string" &&
          (e as { key: string }).key !== "",
      )
      .map((e) => ({
        key: e.key,
        type:
          typeof e.type === "string"
            ? normalizeIndexedKeyType(e.type)
            : ("STRING" as const),
      }));
  }
  return fallback;
}

export function resolveConfig(
  env: Record<string, string | undefined>,
  raw: Record<string, unknown>,
): PluginConfig {
  const rawScopes =
    typeof raw.scopes === "object" && raw.scopes !== null
      ? (raw.scopes as Record<string, unknown>)
      : {};

  // Complex metadata objects (schemaByStrategy, defaultRecallFilters) come from
  // the raw plugin config only; scalar/list fields also accept env overrides.
  const rawMetadata =
    typeof raw.metadata === "object" && raw.metadata !== null
      ? (raw.metadata as Record<string, unknown>)
      : {};

  return {
    enabled: bool(env.AGENTCORE_ENABLED, raw.enabled, DEFAULTS.enabled),
    memoryId: str(env.AGENTCORE_MEMORY_ID, raw.memoryId, DEFAULTS.memoryId),
    awsRegion: str(
      env.AGENTCORE_REGION,
      raw.awsRegion,
      env.AWS_REGION ?? DEFAULTS.awsRegion,
    ),
    awsProfile: str(
      env.AWS_PROFILE ?? env.AGENTCORE_PROFILE,
      raw.awsProfile,
      undefined,
    ),
    strategies: arr<MemoryStrategy>(raw.strategies, DEFAULTS.strategies),
    autoRecallTopK: num(
      env.AGENTCORE_AUTO_RECALL_TOP_K,
      raw.autoRecallTopK,
      DEFAULTS.autoRecallTopK,
    ),
    autoCaptureEnabled: bool(
      env.AGENTCORE_AUTO_CAPTURE_ENABLED,
      raw.autoCaptureEnabled,
      DEFAULTS.autoCaptureEnabled,
    ),
    autoCaptureMinLength: num(
      env.AGENTCORE_AUTO_CAPTURE_MIN_LENGTH,
      raw.autoCaptureMinLength,
      DEFAULTS.autoCaptureMinLength,
    ),
    noiseFilterEnabled: bool(
      env.AGENTCORE_NOISE_FILTER_ENABLED,
      raw.noiseFilterEnabled,
      DEFAULTS.noiseFilterEnabled,
    ),
    adaptiveRetrievalEnabled: bool(
      env.AGENTCORE_ADAPTIVE_RETRIEVAL_ENABLED,
      raw.adaptiveRetrievalEnabled,
      DEFAULTS.adaptiveRetrievalEnabled,
    ),
    namespaceMode: str(
      env.AGENTCORE_NAMESPACE_MODE,
      raw.namespaceMode,
      DEFAULTS.namespaceMode,
    ) as NamespaceMode,
    scopes: {
      agentAccess:
        typeof rawScopes.agentAccess === "object" &&
        rawScopes.agentAccess !== null
          ? (rawScopes.agentAccess as Record<string, string[]>)
          : DEFAULTS.scopes.agentAccess,
      writeAccess:
        typeof rawScopes.writeAccess === "object" &&
        rawScopes.writeAccess !== null
          ? (rawScopes.writeAccess as Record<string, string[]>)
          : DEFAULTS.scopes.writeAccess,
    },
    eventExpiryDays: num(
      env.AGENTCORE_EVENT_EXPIRY_DAYS,
      raw.eventExpiryDays,
      DEFAULTS.eventExpiryDays,
    ),
    showScores: bool(
      env.AGENTCORE_SHOW_SCORES,
      raw.showScores,
      DEFAULTS.showScores,
    ),
    scoreGapEnabled: bool(
      env.AGENTCORE_SCORE_GAP_ENABLED,
      raw.scoreGapEnabled,
      DEFAULTS.scoreGapEnabled,
    ),
    scoreGapMultiplier: num(
      env.AGENTCORE_SCORE_GAP_MULTIPLIER,
      raw.scoreGapMultiplier,
      DEFAULTS.scoreGapMultiplier,
    ),
    minScoreFloor: num(
      env.AGENTCORE_MIN_SCORE_FLOOR,
      raw.minScoreFloor,
      DEFAULTS.minScoreFloor,
    ),
    noisePatterns: parseCommaSeparated(
      env.AGENTCORE_NOISE_PATTERNS,
      raw.noisePatterns,
      DEFAULTS.noisePatterns,
    ),
    bypassPatterns: parseCommaSeparated(
      env.AGENTCORE_BYPASS_PATTERNS,
      raw.bypassPatterns,
      DEFAULTS.bypassPatterns,
    ),
    statsCacheTtlMs: num(
      env.AGENTCORE_STATS_CACHE_TTL_MS,
      raw.statsCacheTtlMs,
      DEFAULTS.statsCacheTtlMs,
    ),
    fileSyncEnabled: bool(
      env.AGENTCORE_FILE_SYNC_ENABLED,
      raw.fileSyncEnabled,
      DEFAULTS.fileSyncEnabled,
    ),
    fileSyncPaths: arr<string>(raw.fileSyncPaths, DEFAULTS.fileSyncPaths),
    maxRetries: num(
      env.AGENTCORE_MAX_RETRIES,
      raw.maxRetries,
      DEFAULTS.maxRetries,
    ),
    timeoutMs: num(
      env.AGENTCORE_TIMEOUT_MS,
      raw.timeoutMs,
      DEFAULTS.timeoutMs,
    ),
    metadata: {
      enabled: bool(
        env.AGENTCORE_METADATA_ENABLED,
        rawMetadata.enabled,
        DEFAULTS.metadata.enabled,
      ),
      indexedKeys: parseIndexedKeys(
        env.AGENTCORE_METADATA_INDEXED_KEYS,
        rawMetadata.indexedKeys,
        DEFAULTS.metadata.indexedKeys,
      ),
      strictKeys: parseCommaSeparated(
        env.AGENTCORE_METADATA_STRICT_KEYS,
        rawMetadata.strictKeys,
        DEFAULTS.metadata.strictKeys,
      ),
      schemaByStrategy:
        typeof rawMetadata.schemaByStrategy === "object" &&
        rawMetadata.schemaByStrategy !== null
          ? (rawMetadata.schemaByStrategy as MetadataConfig["schemaByStrategy"])
          : DEFAULTS.metadata.schemaByStrategy,
      defaultRecallFilters: Array.isArray(rawMetadata.defaultRecallFilters)
        ? (rawMetadata.defaultRecallFilters as MetadataFilterInput[])
        : DEFAULTS.metadata.defaultRecallFilters,
      dropUnindexedFilters: bool(
        env.AGENTCORE_METADATA_DROP_UNINDEXED_FILTERS,
        rawMetadata.dropUnindexedFilters,
        DEFAULTS.metadata.dropUnindexedFilters,
      ),
    },
  };
}


/**
 * Character set permitted for metadata keys and allowedValues.
 * Mirrors the AWS-permitted charset; empty strings are allowed by the {0,128} bound.
 */
const METADATA_KEY_CHARSET = /^[a-zA-Z0-9\s._:/=+@-]{0,128}$/;

const MAX_INDEXED_KEYS = 10;
const MAX_STRICT_KEYS_PER_STRATEGY = 3;
const MAX_ALLOWED_VALUES = 10;

/**
 * Validate a MetadataConfig against the design's validation rules.
 *
 * Enforces: <=10 indexed keys; key charset; every strictKey present in
 * indexedKeys and typed STRING; <=3 strict keys per strategy and none under
 * SUMMARY; allowedValues length <=10 with a valid charset.
 *
 * Never throws for any input — callers decide whether to disable the feature
 * (fail-safe) on invalid config.
 */
export function validateMetadataConfig(
  config: MetadataConfig,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  try {
    const indexedKeys = Array.isArray(config?.indexedKeys)
      ? config.indexedKeys
      : [];
    const strictKeys = Array.isArray(config?.strictKeys)
      ? config.strictKeys
      : [];
    const schemaByStrategy =
      config?.schemaByStrategy && typeof config.schemaByStrategy === "object"
        ? config.schemaByStrategy
        : {};

    // Rule: at most 10 indexed keys.
    if (indexedKeys.length > MAX_INDEXED_KEYS) {
      errors.push(
        `indexedKeys exceeds maximum of ${MAX_INDEXED_KEYS} (found ${indexedKeys.length})`,
      );
    }

    // Rule: each indexed key matches the required character set.
    for (const ik of indexedKeys) {
      if (!ik || typeof ik.key !== "string" || !METADATA_KEY_CHARSET.test(ik.key)) {
        errors.push(
          `indexed key "${ik?.key}" does not match required character set`,
        );
      }
    }

    // Lookup of indexed key -> type for strict-key validation.
    const indexedTypeByKey = new Map<string, string>();
    for (const ik of indexedKeys) {
      if (ik && typeof ik.key === "string") {
        indexedTypeByKey.set(ik.key, ik.type);
      }
    }

    // Rule: each strict key must be a declared indexed key of type STRING.
    for (const sk of strictKeys) {
      if (!indexedTypeByKey.has(sk)) {
        errors.push(`strict key "${sk}" is not present in indexedKeys`);
      } else if (indexedTypeByKey.get(sk) !== "STRING") {
        errors.push(`strict key "${sk}" must be of type STRING`);
      }
    }

    // Rule: per-strategy strict-key limits, SUMMARY exclusion, and allowedValues.
    for (const [strategy, entries] of Object.entries(schemaByStrategy)) {
      const list = Array.isArray(entries) ? entries : [];
      const strictEntries = list.filter(
        (e) => e && e.extractionType === "STRICTLY_CONSISTENT",
      );

      if (strictEntries.length > MAX_STRICT_KEYS_PER_STRATEGY) {
        errors.push(
          `strategy "${strategy}" defines more than ${MAX_STRICT_KEYS_PER_STRATEGY} strict keys (found ${strictEntries.length})`,
        );
      }

      if (strategy === "SUMMARY" && strictEntries.length > 0) {
        errors.push(`strategy "SUMMARY" must not define strict keys`);
      }

      for (const entry of list) {
        if (!entry) continue;
        if (typeof entry.key === "string" && !METADATA_KEY_CHARSET.test(entry.key)) {
          errors.push(
            `schema key "${entry.key}" does not match required character set`,
          );
        }
        if (Array.isArray(entry.allowedValues)) {
          if (entry.allowedValues.length > MAX_ALLOWED_VALUES) {
            errors.push(
              `allowedValues for key "${entry.key}" exceeds maximum of ${MAX_ALLOWED_VALUES} (found ${entry.allowedValues.length})`,
            );
          }
          for (const v of entry.allowedValues) {
            if (typeof v !== "string" || !METADATA_KEY_CHARSET.test(v)) {
              errors.push(
                `allowedValue "${v}" for key "${entry.key}" does not match required character set`,
              );
            }
          }
        }
      }
    }
  } catch (err) {
    // Defensive: the function must never throw regardless of input shape.
    errors.push(
      `unexpected validation error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return { valid: errors.length === 0, errors };
}
