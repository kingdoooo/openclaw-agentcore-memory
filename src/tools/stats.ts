import type { AgentCoreClient } from "../client.js";
import type { PluginConfig } from "../config.js";
import { parseScope, scopeToNamespace, scopeToSearchNamespaces, scopeToString, isScopeReadable, buildStrategyNamespaces, STRATEGY_PREFIX_MAP } from "../scopes.js";

export function createStatsTool(
  client: AgentCoreClient,
  config: PluginConfig,
  getActorId: () => string,
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
      const scope = parseScope(scopeStr);
      const namespace = scopeToNamespace(scope);
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

      try {
        const strategyCounts: Record<string, number> = {};
        let cacheHit = false;

        if (scope.kind === "agent" && scope.id) {
          // For agent scopes: iterate strategy namespaces
          const strategyNs = buildStrategyNamespaces(scope.id, config.namespaceMode);
          // Add summary namespace
          const summaryNs = config.namespaceMode === "shared"
            ? "/summary"
            : `/summary/${scope.id}`;
          const allStrategyNs = [...strategyNs, summaryNs];

          for (const ns of allStrategyNs) {
            // Derive strategy name from namespace prefix
            const strategyName = Object.entries(STRATEGY_PREFIX_MAP)
              .find(([, prefix]) => ns.startsWith(`/${prefix}`))
              ?.[0] ?? ns;

            const cacheKey = `${ns}:count`;
            const cached = client.getStatsCached(cacheKey);
            if (cached !== undefined) {
              strategyCounts[strategyName] = cached.count;
              cacheHit = true;
              continue;
            }
            try {
              const result = await client.listMemoryRecords({
                namespace: ns,
                maxResults: 1,
              });
              strategyCounts[strategyName] = result.records.length;
              client.setStatsCache(cacheKey, result.records.length);
            } catch {
              strategyCounts[strategyName] = -1;
            }
          }

          // Also count primary namespace
          const primaryCacheKey = `${namespace}:count`;
          const primaryCached = client.getStatsCached(primaryCacheKey);
          if (primaryCached !== undefined) {
            strategyCounts["primary"] = primaryCached.count;
            cacheHit = true;
          } else {
            try {
              const result = await client.listMemoryRecords({
                namespace,
                maxResults: 1,
              });
              strategyCounts["primary"] = result.records.length;
              client.setStatsCache(primaryCacheKey, result.records.length);
            } catch {
              strategyCounts["primary"] = -1;
            }
          }
        } else {
          // For non-agent scopes: count total records in primary namespace
          const cacheKey = `${namespace}:count`;
          const cached = client.getStatsCached(cacheKey);
          if (cached !== undefined) {
            strategyCounts["total"] = cached.count;
            cacheHit = true;
          } else {
            try {
              const result = await client.listMemoryRecords({
                namespace,
                maxResults: 1,
              });
              strategyCounts["total"] = result.records.length;
              client.setStatsCache(cacheKey, result.records.length);
            } catch {
              strategyCounts["total"] = -1;
            }
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
