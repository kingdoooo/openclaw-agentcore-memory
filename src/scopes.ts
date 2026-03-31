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
    console.warn(`[agentcore] [scopes] Invalid scope kind "${kind}" in "${scope}", falling back to global`);
    return { kind: "global" };
  }
  const id = parts[1];
  const strategy = parts[2];
  if (strategy) {
    if ((VALID_STRATEGIES as readonly string[]).includes(strategy)) {
      return { kind: kind as ScopeKind, id, strategy };
    }
    console.warn(`[agentcore] [scopes] Invalid strategy "${strategy}" in "${scope}", entry ignored (least privilege)`);
    return { kind: "global" };
  }
  return { kind: kind as ScopeKind, id };
}

function sanitizeId(input: string): string {
  return input.replace(/[^a-zA-Z0-9_\-.]/g, "_");
}

function strategyToNamespace(strategy: string, id: string, mode: NamespaceMode, kind?: ScopeKind): string {
  if (strategy === "primary") {
    return kind === "user" ? `/users/${sanitizeId(id)}` : `/agents/${sanitizeId(id)}`;
  }
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
  peerId?: string,
  agentId?: string,
): string[] {
  const ns = new Set<string>();
  ns.add("/global");

  // Primary namespace: /users/{peerId} when DM, /agents/{actorId} otherwise
  if (peerId) {
    ns.add(scopeToNamespace({ kind: "user", id: peerId }));
    // Per-peer: also readable /agents/{agentId} for shared knowledge (FAQ, docs)
    if (agentId) {
      ns.add(scopeToNamespace({ kind: "agent", id: agentId }));
    }
  } else {
    ns.add(scopeToNamespace({ kind: "agent", id: actorId }));
  }

  // Strategy namespaces use actorId (= peerId in DM sessions)
  for (const sn of buildStrategyNamespaces(actorId, mode)) ns.add(sn);
  const selfSummary = mode === "shared" ? "/summary" : `/summary/${sanitizeId(actorId)}`;
  ns.add(selfSummary);

  // Authorized scopes — agent & user scopes get strategy expansion
  // "*" key is a wildcard fallback for all actorIds
  const accessList = scopesConfig.agentAccess[actorId]
    ?? scopesConfig.agentAccess["*"];
  if (accessList) {
    for (const scopeStr of accessList) {
      const scope = parseScope(scopeStr);
      if ((scope.kind === "agent" || scope.kind === "user") && scope.id && scope.strategy) {
        // Strategy-specific access: only the single namespace
        ns.add(strategyToNamespace(scope.strategy, scope.id, mode, scope.kind));
      } else {
        // Full scope access (backward compatible)
        ns.add(scopeToNamespace(scope));
        if ((scope.kind === "agent" || scope.kind === "user") && scope.id) {
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
  peerId?: string,
): string[] {
  const namespaces = ["/global"];
  // Primary namespace: /users/{peerId} when DM, /agents/{actorId} otherwise
  if (peerId) {
    namespaces.push(scopeToNamespace({ kind: "user", id: peerId }));
  } else {
    namespaces.push(scopeToNamespace({ kind: "agent", id: actorId }));
  }

  const writeList = scopesConfig.writeAccess[actorId]
    ?? scopesConfig.writeAccess["*"];
  if (writeList) {
    for (const scopeStr of writeList) {
      const scope = parseScope(scopeStr);
      let ns: string;
      if ((scope.kind === "agent" || scope.kind === "user") && scope.id && scope.strategy) {
        ns = strategyToNamespace(scope.strategy, scope.id, mode, scope.kind);
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

function hasReadEnforcement(_sc: ScopesConfig): boolean {
  return true;
}

function hasWriteEnforcement(_sc: ScopesConfig): boolean {
  return true;
}

/** Extract wildcard prefixes from agentAccess config.
 *  "user:*" → "/users/" prefix match. Extensible for future patterns.
 */
export function resolveWildcardPrefixes(scopesConfig: ScopesConfig, actorId: string): string[] {
  const prefixes: string[] = [];
  const accessList = scopesConfig.agentAccess[actorId]
    ?? scopesConfig.agentAccess["*"];
  if (accessList) {
    for (const scopeStr of accessList) {
      if (scopeStr === "user:*") prefixes.push("/users/");
    }
  }
  return prefixes;
}

export function isScopeReadable(
  actorId: string,
  requestedNamespaces: string[],
  scopesConfig: ScopesConfig,
  mode: NamespaceMode,
  peerId?: string,
  agentId?: string,
): { allowed: boolean; filteredNamespaces: string[] } {
  if (!hasReadEnforcement(scopesConfig)) {
    return { allowed: true, filteredNamespaces: requestedNamespaces };
  }
  const accessible = new Set(resolveAccessibleNamespaces(actorId, scopesConfig, mode, peerId, agentId));
  const wildcardPrefixes = resolveWildcardPrefixes(scopesConfig, actorId);
  const filtered = requestedNamespaces.filter(ns =>
    accessible.has(ns) || wildcardPrefixes.some(prefix => ns.startsWith(prefix))
  );
  return { allowed: filtered.length > 0, filteredNamespaces: filtered };
}

export function isScopeWritable(
  actorId: string,
  requestedNamespace: string,
  scopesConfig: ScopesConfig,
  mode: NamespaceMode = "per-agent",
  peerId?: string,
): boolean {
  if (!hasWriteEnforcement(scopesConfig)) return true;
  const writable = resolveWritableNamespaces(actorId, scopesConfig, mode, peerId);
  const wildcardPrefixes = resolveWildcardPrefixes(scopesConfig, actorId);
  return writable.includes(requestedNamespace) ||
    wildcardPrefixes.some(prefix => requestedNamespace.startsWith(prefix));
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
