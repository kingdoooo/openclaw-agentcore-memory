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
}

const DEFAULTS: PluginConfig = {
  enabled: true,
  memoryId: "",
  awsRegion: "us-east-1",
  strategies: ["SEMANTIC", "USER_PREFERENCE", "EPISODIC", "SUMMARY"],
  autoRecallTopK: 5,
  autoCaptureEnabled: true,
  autoCaptureMinLength: 30,
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
  fileSyncPaths: ["MEMORY.md", "USER.md", "SOUL.md", "TOOLS.md", "memory/*.md"],
  maxRetries: 3,
  timeoutMs: 10000,
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

export function resolveConfig(
  env: Record<string, string | undefined>,
  raw: Record<string, unknown>,
): PluginConfig {
  const rawScopes =
    typeof raw.scopes === "object" && raw.scopes !== null
      ? (raw.scopes as Record<string, unknown>)
      : {};

  return {
    enabled: bool(env.AGENTCORE_ENABLED, raw.enabled, DEFAULTS.enabled),
    memoryId: str(env.AGENTCORE_MEMORY_ID, raw.memoryId, DEFAULTS.memoryId),
    awsRegion: str(
      env.AWS_REGION ?? env.AGENTCORE_REGION,
      raw.awsRegion,
      DEFAULTS.awsRegion,
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
  };
}
