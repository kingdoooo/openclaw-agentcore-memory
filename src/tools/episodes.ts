import type { AgentCoreClient } from "../client.js";
import type { PluginConfig } from "../config.js";
import { buildEpisodicNamespace, buildStrategyNamespaces, isScopeReadable } from "../scopes.js";
import { filterByScoreGap } from "../score-filter.js";

export function createEpisodesTool(
  client: AgentCoreClient,
  config: PluginConfig,
  getActorId: () => string,
) {
  return {
    name: "agentcore_episodes",
    label: "AgentCore Episodes",
    description:
      "Search episodic memory for past experiences, reflections, and learned patterns. Episodic memory helps agents learn from previous interactions.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What experience or pattern to search for",
        },
        actor_id: {
          type: "string",
          description: "Filter by actor/agent ID",
        },
        top_k: {
          type: "number",
          description: "Max results (default: 5)",
        },
      },
      required: ["query"],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const query = (params.query as string)?.trim();
      if (!query) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "query must not be empty", episodes: [], count: 0 }) }],
          details: { error: "empty_query" },
        };
      }
      const actorId = params.actor_id as string | undefined;
      const topK = (params.top_k as number) ?? 5;

      const namespace = buildEpisodicNamespace(actorId, undefined, config.namespaceMode);
      // Also search the strategy episodic namespace (where createEvent stores records)
      const episodicStrategyNs = actorId
        ? buildStrategyNamespaces(actorId, config.namespaceMode).filter(ns => ns.startsWith("/episodic"))
        : ["/episodic"];
      const uniqueNamespaces = [...new Set([namespace, ...episodicStrategyNs])];

      // Permission check
      const currentActorId = getActorId();
      const readCheck = isScopeReadable(currentActorId, uniqueNamespaces, config.scopes, config.namespaceMode);
      if (!readCheck.allowed) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: `Episodic namespaces for '${actorId ?? "default"}' are not in your accessible namespaces. Configure scopes.agentAccess to grant access.` }) }],
          details: { error: "permission_denied" },
        };
      }

      try {
        const allResults = await Promise.allSettled(
          uniqueNamespaces.map((ns) =>
            client.retrieveMemoryRecords({
              query,
              namespace: ns,
              topK,
            }),
          ),
        );

        const merged = allResults
          .filter(
            (r): r is PromiseFulfilledResult<any[]> =>
              r.status === "fulfilled",
          )
          .flatMap((r) => r.value);

        // Dedup by memoryRecordId
        const seen = new Set<string>();
        const deduped = merged.filter((r: any) => {
          if (seen.has(r.memoryRecordId)) return false;
          seen.add(r.memoryRecordId);
          return true;
        });

        deduped.sort((a: any, b: any) => (b.score ?? 0) - (a.score ?? 0));
        const records = filterByScoreGap(deduped.slice(0, topK), config);

        const episodes = records.map((r) => ({
          id: r.memoryRecordId,
          content: r.content,
          ...(config.showScores && r.score != null
            ? { score: Number(r.score.toFixed(3)) }
            : {}),
          date: r.createdAt.toISOString().split("T")[0],
          ...(r.metadata ? { metadata: r.metadata } : {}),
        }));

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ episodes, count: episodes.length, namespace }, null, 2) }],
          details: { count: episodes.length },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: `Episodes search failed: ${err}`, episodes: [], count: 0 }) }],
          details: { error: String(err) },
        };
      }
    },
  };
}
