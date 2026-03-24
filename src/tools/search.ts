import type { AgentCoreClient } from "../client.js";
import type { PluginConfig } from "../config.js";
import { parseScope, scopeToSearchNamespaces, scopeToString, isScopeReadable, filterNamespacesByStrategy } from "../scopes.js";

export function createSearchTool(client: AgentCoreClient, config: PluginConfig, getActorId: () => string) {
  return {
    name: "agentcore_search",
    label: "AgentCore Search",
    description:
      "List and filter memory records in AgentCore. Unlike recall (semantic search), this lists records by namespace and strategy.",
    parameters: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          description:
            "Scope: 'global', 'agent:<id>', 'project:<id>', 'user:<id>' (default: global)",
        },
        strategy: {
          type: "string",
          description:
            "Filter by strategy: SEMANTIC, USER_PREFERENCE, EPISODIC, SUMMARY",
        },
        max_results: {
          type: "number",
          description: "Max results per namespace (default: 20)",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const scopeStr = (params.scope as string) ?? "global";
      const strategy = params.strategy as string | undefined;
      const maxResults = (params.max_results as number) ?? 20;

      const scope = parseScope(scopeStr);
      const allNamespaces = scopeToSearchNamespaces(scope, config.namespaceMode);

      // Permission check
      const actorId = getActorId();
      const readCheck = isScopeReadable(actorId, allNamespaces, config.scopes, config.namespaceMode);
      if (!readCheck.allowed) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: `Scope '${scopeToString(scope)}' is not in your accessible namespaces. Configure scopes.agentAccess to grant access.` }) }],
          details: { error: "permission_denied" },
        };
      }

      // Filter namespaces by strategy instead of passing strategyId to AWS
      const namespaces = filterNamespacesByStrategy(allNamespaces, strategy);

      try {
        const allResults = await Promise.allSettled(
          namespaces.map((ns) =>
            client.listMemoryRecords({
              namespace: ns,
              maxResults,
            }),
          ),
        );

        const merged = allResults
          .filter(
            (r): r is PromiseFulfilledResult<{ records: any[]; nextToken?: string }> =>
              r.status === "fulfilled",
          )
          .flatMap((r) => r.value.records);

        // Dedup by memoryRecordId
        const seen = new Set<string>();
        const deduped = merged.filter((r: any) => {
          if (seen.has(r.memoryRecordId)) return false;
          seen.add(r.memoryRecordId);
          return true;
        });

        const data = {
          records: deduped.map((r: any) => ({
            id: r.memoryRecordId,
            content: r.content.slice(0, 300),
            strategy: r.memoryStrategyId,
            date: r.createdAt.toISOString().split("T")[0],
            ...(r.metadata ? { metadata: r.metadata } : {}),
          })),
          count: deduped.length,
          hasMore: false,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
          details: { count: data.count, hasMore: data.hasMore },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: `Search failed: ${err}`, records: [], count: 0 }) }],
          details: { error: String(err) },
        };
      }
    },
  };
}
