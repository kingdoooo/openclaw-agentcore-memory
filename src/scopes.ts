import type { ScopesConfig } from "./config.js";

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

export function scopeToString(scope: Scope): string {
  if (scope.kind === "global") return "global";
  return `${scope.kind}:${scope.id}`;
}

export function resolveAccessibleNamespaces(
  actorId: string,
  scopesConfig: ScopesConfig,
): string[] {
  const namespaces = ["/global"];
  const agentNs = scopeToNamespace({ kind: "agent", id: actorId });
  namespaces.push(agentNs);

  const accessList = scopesConfig.agentAccess[actorId];
  if (accessList) {
    for (const scopeStr of accessList) {
      const ns = scopeToNamespace(parseScope(scopeStr));
      if (!namespaces.includes(ns)) namespaces.push(ns);
    }
  }

  return namespaces;
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
