import type { ScopesConfig, NamespaceMode } from "./config.js";

export type ScopeKind = "global" | "agent" | "project" | "user" | "custom";

export interface Scope {
  kind: ScopeKind;
  id?: string;
}

export function parseScope(scope: string): Scope {
  if (scope === "global") return { kind: "global" };
  const colonIdx = scope.indexOf(":");
  if (colonIdx === -1) return { kind: "global" };
  const kind = scope.slice(0, colonIdx);
  const id = scope.slice(colonIdx + 1);
  if (!["agent", "project", "user", "custom"].includes(kind)) {
    return { kind: "global" };
  }
  return { kind: kind as ScopeKind, id };
}

function sanitizeId(input: string): string {
  return input.replace(/[^a-zA-Z0-9_\-.]/g, "_");
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
const STRATEGY_BASES = ["semantic", "episodic", "preferences", "summary"] as const;

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
    return [primary, ...buildStrategyNamespaces(scope.id, mode)];
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

  // Current agent + its strategy namespaces
  ns.add(scopeToNamespace({ kind: "agent", id: actorId }));
  for (const sn of buildStrategyNamespaces(actorId, mode)) ns.add(sn);

  // Authorized scopes — only agent scopes get strategy expansion
  const accessList = scopesConfig.agentAccess[actorId];
  if (accessList) {
    for (const scopeStr of accessList) {
      const scope = parseScope(scopeStr);
      ns.add(scopeToNamespace(scope));
      if (scope.kind === "agent" && scope.id) {
        for (const sn of buildStrategyNamespaces(scope.id, mode)) ns.add(sn);
      }
    }
  }

  return [...ns];
}

export function resolveWritableNamespaces(
  actorId: string,
  scopesConfig: ScopesConfig,
): string[] {
  const namespaces = ["/global"];
  const agentNs = scopeToNamespace({ kind: "agent", id: actorId });
  namespaces.push(agentNs);

  const writeList = scopesConfig.writeAccess[actorId];
  if (writeList) {
    for (const scopeStr of writeList) {
      const ns = scopeToNamespace(parseScope(scopeStr));
      if (!namespaces.includes(ns)) namespaces.push(ns);
    }
  }

  return namespaces;
}

export function buildEpisodicNamespace(
  actorId?: string,
  sessionId?: string,
): string {
  if (actorId && sessionId) {
    return `/strategy/episodic/actor/${sanitizeId(actorId)}/session/${sanitizeId(sessionId)}`;
  }
  if (actorId) {
    return `/strategy/episodic/actor/${sanitizeId(actorId)}`;
  }
  return "/strategy/episodic";
}
