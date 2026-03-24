import type { ScopesConfig, NamespaceMode } from "./config.js";

export type ScopeKind = "global" | "agent" | "project" | "user" | "custom";

export interface Scope {
  kind: ScopeKind;
  id?: string;
  strategy?: string;
}

const VALID_STRATEGIES = ["semantic", "episodic", "preferences", "summary", "primary"] as const;

export function parseScope(scope: string): Scope {
  if (scope === "global") return { kind: "global" };
  const parts = scope.split(":");
  if (parts.length < 2) return { kind: "global" };
  const kind = parts[0];
  if (!["agent", "project", "user", "custom"].includes(kind)) {
    return { kind: "global" };
  }
  const id = parts[1];
  const strategy = parts[2];
  if (strategy) {
    if ((VALID_STRATEGIES as readonly string[]).includes(strategy)) {
      return { kind: kind as ScopeKind, id, strategy };
    }
    return { kind: "global" }; // invalid strategy → least privilege
  }
  return { kind: kind as ScopeKind, id };
}

function sanitizeId(input: string): string {
  return input.replace(/[^a-zA-Z0-9_\-.]/g, "_");
}

function strategyToNamespace(strategy: string, id: string, mode: NamespaceMode): string {
  if (strategy === "primary") return `/agents/${sanitizeId(id)}`;
  if (mode === "shared") return `/${strategy}`;
  return `/${strategy}/${sanitizeId(id)}`;
}

export function scopeToNamespace(scope: Scope): string {
  switch (scope.kind) {
    case "global":
      return "/global";
    case "agent":
      return `/agents/${sanitizeId(scope.id ?? "")}`;
    case "project":
      return `/projects/${sanitizeId(scope.id ?? "")}`;
    case "user":
      return `/users/${sanitizeId(scope.id ?? "")}`;
    case "custom":
      return `/custom/${sanitizeId(scope.id ?? "")}`;
  }
}

/** Strategy base names matching AgentCore built-in strategies */
const STRATEGY_BASES = ["semantic", "episodic", "preferences"] as const;

/** Build strategy namespace paths based on namespaceMode.
 *  - "shared": flat paths like /semantic
 *  - "per-agent": actor-scoped like /semantic/{actorId}
 */
export function buildStrategyNamespaces(actorId: string, mode: NamespaceMode): string[] {
  if (mode === "shared") {
    return STRATEGY_BASES.map(s => `/${s}`);
  }
  return STRATEGY_BASES.map(s => `/${s}/${sanitizeId(actorId)}`);
}

/** Resolve all namespaces to search for a given scope.
 *  Only agent scope expands to strategy namespaces (createEvent actorId maps to agents).
 *  global/project/user scopes return their primary namespace only.
 */
export function scopeToSearchNamespaces(scope: Scope, mode: NamespaceMode): string[] {
  const primary = scopeToNamespace(scope);
  if (scope.kind === "agent" && scope.id) {
    const summaryNs = mode === "shared"
      ? "/summary"
      : `/summary/${sanitizeId(scope.id)}`;
    return [primary, ...buildStrategyNamespaces(scope.id, mode), summaryNs];
  }
  return [primary];
}

export function scopeToString(scope: Scope): string {
  if (scope.kind === "global") return "global";
  return `${scope.kind}:${scope.id}`;
}

export function resolveAccessibleNamespaces(
  actorId: string,
  scopesConfig: ScopesConfig,
  mode: NamespaceMode,
): string[] {
  const ns = new Set<string>();
  ns.add("/global");

  // Current agent + its strategy namespaces + summary
  ns.add(scopeToNamespace({ kind: "agent", id: actorId }));
  for (const sn of buildStrategyNamespaces(actorId, mode)) ns.add(sn);
  const selfSummary = mode === "shared" ? "/summary" : `/summary/${sanitizeId(actorId)}`;
  ns.add(selfSummary);

  // Authorized scopes — agent scopes get strategy expansion
  const accessList = scopesConfig.agentAccess[actorId];
  if (accessList) {
    for (const scopeStr of accessList) {
      const scope = parseScope(scopeStr);
      if (scope.kind === "agent" && scope.id && scope.strategy) {
        // Strategy-specific access: only the single namespace
        ns.add(strategyToNamespace(scope.strategy, scope.id, mode));
      } else {
        // Full scope access (backward compatible)
        ns.add(scopeToNamespace(scope));
        if (scope.kind === "agent" && scope.id) {
          for (const sn of buildStrategyNamespaces(scope.id, mode)) ns.add(sn);
          const summaryNs = mode === "shared" ? "/summary" : `/summary/${sanitizeId(scope.id)}`;
          ns.add(summaryNs);
        }
      }
    }
  }

  return [...ns];
}

export function resolveWritableNamespaces(
  actorId: string,
  scopesConfig: ScopesConfig,
  mode: NamespaceMode = "per-agent",
): string[] {
  const namespaces = ["/global"];
  const agentNs = scopeToNamespace({ kind: "agent", id: actorId });
  namespaces.push(agentNs);

  const writeList = scopesConfig.writeAccess[actorId];
  if (writeList) {
    for (const scopeStr of writeList) {
      const scope = parseScope(scopeStr);
      let ns: string;
      if (scope.kind === "agent" && scope.id && scope.strategy) {
        ns = strategyToNamespace(scope.strategy, scope.id, mode);
      } else {
        ns = scopeToNamespace(scope);
      }
      if (!namespaces.includes(ns)) namespaces.push(ns);
    }
  }

  return namespaces;
}

/** Build episodic namespace path matching AWS strategy templates.
 *  "per-agent": /episodic/{actorId}[/{sessionId}]
 *  "shared":    /episodic[/{sessionId}]
 */
export function buildEpisodicNamespace(
  actorId?: string,
  sessionId?: string,
  mode: NamespaceMode = "per-agent",
): string {
  if (mode === "shared") {
    return sessionId ? `/episodic/${sanitizeId(sessionId)}` : "/episodic";
  }
  if (actorId && sessionId) {
    return `/episodic/${sanitizeId(actorId)}/${sanitizeId(sessionId)}`;
  }
  if (actorId) {
    return `/episodic/${sanitizeId(actorId)}`;
  }
  return "/episodic";
}

// --- Permission enforcement helpers ---

function hasReadEnforcement(sc: ScopesConfig): boolean {
  return Object.keys(sc.agentAccess).length > 0;
}

function hasWriteEnforcement(sc: ScopesConfig): boolean {
  return Object.keys(sc.writeAccess).length > 0;
}

export function isScopeReadable(
  actorId: string,
  requestedNamespaces: string[],
  scopesConfig: ScopesConfig,
  mode: NamespaceMode,
): { allowed: boolean; filteredNamespaces: string[] } {
  if (!hasReadEnforcement(scopesConfig)) {
    return { allowed: true, filteredNamespaces: requestedNamespaces };
  }
  const accessible = new Set(resolveAccessibleNamespaces(actorId, scopesConfig, mode));
  const filtered = requestedNamespaces.filter(ns => accessible.has(ns));
  return { allowed: filtered.length > 0, filteredNamespaces: filtered };
}

export function isScopeWritable(
  actorId: string,
  requestedNamespace: string,
  scopesConfig: ScopesConfig,
  mode: NamespaceMode = "per-agent",
): boolean {
  if (!hasWriteEnforcement(scopesConfig)) return true;
  return resolveWritableNamespaces(actorId, scopesConfig, mode).includes(requestedNamespace);
}

// --- Strategy-to-namespace prefix mapping ---

export const STRATEGY_PREFIX_MAP: Record<string, string> = {
  SEMANTIC: "semantic",
  USER_PREFERENCE: "preferences",
  EPISODIC: "episodic",
  SUMMARY: "summary",
};

/** Filter namespaces to only those matching a strategy prefix. Returns all if no match. */
export function filterNamespacesByStrategy(namespaces: string[], strategy?: string): string[] {
  if (!strategy) return namespaces;
  const prefix = STRATEGY_PREFIX_MAP[strategy];
  if (!prefix) return namespaces;
  const filtered = namespaces.filter(ns => ns.startsWith(`/${prefix}`));
  return filtered.length > 0 ? filtered : namespaces;
}

/** Session-scoped strategy namespaces that need a separate search.
 *  Only summary — episodic is already prefix-covered by the actor-level /episodic/{actorId}.
 */
const SESSION_SCOPED_STRATEGIES = ["summary"] as const;

export function buildSessionNamespaces(
  actorId: string,
  sessionId: string,
  mode: NamespaceMode,
): string[] {
  if (mode === "shared") {
    return SESSION_SCOPED_STRATEGIES.map(s => `/${s}/${sanitizeId(sessionId)}`);
  }
  return SESSION_SCOPED_STRATEGIES.map(
    s => `/${s}/${sanitizeId(actorId)}/${sanitizeId(sessionId)}`,
  );
}
