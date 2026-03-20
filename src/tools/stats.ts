import type { AgentCoreClient } from "../client.js";
import type { PluginConfig } from "../config.js";
import { parseScope, scopeToNamespace } from "../scopes.js";

export function createStatsTool(
  client: AgentCoreClient,
  config: PluginConfig,
) {
  return {
    name: "agentcore_stats",
    label: "AgentCore Stats",
    description:
      "Show memory statistics and connection status for AgentCore Memory.",
    parameters: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          description: "Scope to check (default: global)",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const scopeStr = (params.scope as string) ?? "global";
      const namespace = scopeToNamespace(parseScope(scopeStr));

      try {
        const strategyCounts: Record<string, number> = {};
        let cacheHit = false;

        for (const strategy of config.strategies) {
          const cacheKey = `${namespace}:${strategy}`;
          const cached = client.getStatsCached(cacheKey);
          if (cached !== undefined) {
            strategyCounts[strategy] = cached.count;
            cacheHit = true;
            continue;
          }
          try {
            const result = await client.listMemoryRecords({
              namespace,
              strategyId: strategy,
              maxResults: 1,
            });
            strategyCounts[strategy] = result.records.length;
            client.setStatsCache(cacheKey, result.records.length);
          } catch {
            strategyCounts[strategy] = -1;
          }
        }

        const data = {
          connected: true,
          memoryId: config.memoryId,
          region: config.awsRegion,
          namespace,
          strategies: config.strategies,
          strategyCounts,
          cacheHit,
          config: {
            autoRecallTopK: config.autoRecallTopK,
            autoCaptureEnabled: config.autoCaptureEnabled,
            noiseFilterEnabled: config.noiseFilterEnabled,
            fileSyncEnabled: config.fileSyncEnabled,
            namespaceMode: config.namespaceMode,
          },
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
          details: { connected: true },
        };
      } catch (err) {
        const data = {
          connected: false,
          error: `Connection failed: ${err}`,
          memoryId: config.memoryId,
          region: config.awsRegion,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
          details: { connected: false },
        };
      }
    },
  };
}
