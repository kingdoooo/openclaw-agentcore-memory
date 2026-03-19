import type { AgentCoreClient } from "../client.js";
import type { PluginConfig } from "../config.js";
import { parseScope, scopeToNamespace } from "../scopes.js";

export function createRecallTool(
  client: AgentCoreClient,
  config: PluginConfig,
) {
  return {
    name: "agentcore_recall",
    label: "AgentCore Recall",
    description:
      "Search through stored memories in AgentCore using semantic search. Returns relevant memories based on meaning, not just keywords.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to search for in memory",
        },
        limit: {
          type: "number",
          description: "Max results to return (default: 5)",
        },
        scope: {
          type: "string",
          description:
            "Scope filter: 'global', 'agent:<id>', 'project:<id>', 'user:<id>'",
        },
        strategy: {
          type: "string",
          description:
            "Memory strategy filter: SEMANTIC, USER_PREFERENCE, EPISODIC, SUMMARY",
        },
      },
      required: ["query"],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const query = (params.query as string)?.trim();
      if (!query) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "query must not be empty", results: [], count: 0 }) }],
          details: { error: "empty_query" },
        };
      }
      const limit = (params.limit as number) ?? 5;
      const scopeStr = (params.scope as string) ?? "global";
      const strategy = params.strategy as string | undefined;

      const scope = parseScope(scopeStr);
      const namespace = scopeToNamespace(scope);

      try {
        const records = await client.retrieveMemoryRecords({
          query,
          namespace,
          topK: limit,
          ...(strategy ? { strategyId: strategy } : {}),
        });

        const results = records.map((r) => ({
          id: r.memoryRecordId,
          content: r.content,
          ...(config.showScores && r.score != null
            ? { score: Number(r.score.toFixed(3)) }
            : {}),
          date: r.createdAt.toISOString().split("T")[0],
          strategy: r.memoryStrategyId,
          ...(r.metadata ? { metadata: r.metadata } : {}),
        }));

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ results, count: results.length }, null, 2) }],
          details: { count: results.length },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: `Recall failed: ${err}`, results: [], count: 0 }) }],
          details: { error: String(err) },
        };
      }
    },
  };
}
