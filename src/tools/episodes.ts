import type { AgentCoreClient } from "../client.js";
import type { PluginConfig } from "../config.js";
import { buildEpisodicNamespace } from "../scopes.js";

export function createEpisodesTool(
  client: AgentCoreClient,
  config: PluginConfig,
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
      const query = params.query as string;
      const actorId = params.actor_id as string | undefined;
      const topK = (params.top_k as number) ?? 5;

      const namespace = buildEpisodicNamespace(actorId);

      try {
        const records = await client.retrieveMemoryRecords({
          query,
          namespace,
          topK,
          strategyId: "EPISODIC",
        });

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
