import type { AgentCoreClient } from "../client.js";
import type { PluginConfig } from "../config.js";
import { parseScope, scopeToSearchNamespaces, isScopeReadable, filterNamespacesByStrategy, resolveAccessibleNamespaces, buildSessionNamespaces } from "../scopes.js";
import { filterByScoreGap } from "../score-filter.js";

export function createRecallTool(
  client: AgentCoreClient,
  config: PluginConfig,
  getActorId: () => string,
  getPeerId?: () => string | undefined,
  getAgentId?: () => string,
  getSessionId?: () => string | undefined,
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
            "Scope filter: 'global', 'agent:<id>', 'project:<id>', 'user:<id>'. If omitted, searches all accessible namespaces (same as auto-recall).",
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
      const strategy = params.strategy as string | undefined;
      const peerId = getPeerId?.();
      const actorId = getActorId();
      const agentId = getAgentId?.();

      let allNamespaces: string[];
      if (params.scope) {
        const scope = parseScope(params.scope as string);
        allNamespaces = scopeToSearchNamespaces(scope, config.namespaceMode);
      } else {
        allNamespaces = resolveAccessibleNamespaces(
          actorId, config.scopes, config.namespaceMode, peerId, agentId,
        );
        // Add session namespaces (same as auto-recall)
        const sessionId = getSessionId?.();
        if (sessionId) {
          for (const ns of buildSessionNamespaces(actorId, sessionId, config.namespaceMode)) {
            allNamespaces.push(ns);
          }
        }
      }

      // Permission check
      const readCheck = isScopeReadable(actorId, allNamespaces, config.scopes, config.namespaceMode, peerId, getAgentId?.());
      if (!readCheck.allowed) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: `Scope '${params.scope ?? "auto"}' is not in your accessible namespaces. Configure scopes.agentAccess to grant access.` }) }],
          details: { error: "permission_denied" },
        };
      }

      // Filter namespaces by strategy instead of passing strategyId to AWS
      const namespaces = filterNamespacesByStrategy(readCheck.filteredNamespaces, strategy);

      try {
        const allResults = await Promise.allSettled(
          namespaces.map((ns) =>
            client.retrieveMemoryRecords({
              query,
              namespace: ns,
              topK: limit,
            }),
          ),
        );

        const merged = allResults
          .filter(
            (r): r is PromiseFulfilledResult<any[]> =>
              r.status === "fulfilled",
          )
          .flatMap((r) => r.value);

        // Dedup by memoryRecordId (same record may appear in multiple namespaces)
        const seen = new Set<string>();
        const deduped = merged.filter((r: any) => {
          if (seen.has(r.memoryRecordId)) return false;
          seen.add(r.memoryRecordId);
          return true;
        });

        deduped.sort((a: any, b: any) => (b.score ?? 0) - (a.score ?? 0));
        const topRecords = filterByScoreGap(deduped.slice(0, limit), config);

        const results = topRecords.map((r: any) => ({
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
