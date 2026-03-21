import type { AgentCoreClient } from "../client.js";
import { parseScope, scopeToNamespace, scopeToSearchNamespaces } from "../scopes.js";

export function createSearchTool(client: AgentCoreClient) {
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
          description: "Max results (default: 20)",
        },
        next_token: {
          type: "string",
          description: "Pagination token from previous search",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const scopeStr = (params.scope as string) ?? "global";
      const strategy = params.strategy as string | undefined;
      const maxResults = (params.max_results as number) ?? 20;
      const nextToken = params.next_token as string | undefined;

      const scope = parseScope(scopeStr);
      const namespaces = scopeToSearchNamespaces(scope);

      try {
        const allResults = await Promise.allSettled(
          namespaces.map((ns) =>
            client.listMemoryRecords({
              namespace: ns,
              strategyId: strategy,
              maxResults,
              nextToken,
            }),
          ),
        );

        const allRecords = allResults
          .filter(
            (r): r is PromiseFulfilledResult<{ records: any[]; nextToken?: string }> =>
              r.status === "fulfilled",
          )
          .flatMap((r) => r.value.records);

        const data = {
          records: allRecords.map((r: any) => ({
            id: r.memoryRecordId,
            content: r.content.slice(0, 300),
            strategy: r.memoryStrategyId,
            date: r.createdAt.toISOString().split("T")[0],
            ...(r.metadata ? { metadata: r.metadata } : {}),
          })),
          count: allRecords.length,
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
