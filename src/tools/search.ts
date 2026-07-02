import type { AgentCoreClient } from "../client.js";
import type { PluginConfig, MetadataFilterInput } from "../config.js";
import { parseScope, scopeToSearchNamespaces, scopeToString, isScopeReadable, filterNamespacesByStrategy } from "../scopes.js";
import { buildFilters } from "../metadata-filter.js";
import type { MetadataFilter, DroppedFilter } from "../metadata-filter.js";

export function createSearchTool(client: AgentCoreClient, config: PluginConfig, getActorId: () => string, getPeerId?: () => string | undefined, getAgentId?: () => string) {
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
        filters: {
          type: "array",
          description:
            "Optional metadata filters ({ key, operator?, value? }) applied within already-authorized namespaces (max 5, AND-combined). Ignored when metadata filtering is disabled.",
          items: {
            type: "object",
            properties: {
              key: { type: "string", description: "Metadata key to filter on" },
              operator: {
                type: "string",
                description:
                  "One of EQUALS_TO, CONTAINS, EXISTS, NOT_EXISTS, GREATER_THAN, GREATER_THAN_OR_EQUALS, LESS_THAN, LESS_THAN_OR_EQUALS, BEFORE, AFTER (inferred when omitted)",
              },
              value: {
                description: "Value to compare against (omit for EXISTS / NOT_EXISTS)",
              },
            },
            required: ["key"],
          },
        },
        created_after: {
          type: "string",
          description:
            "Only return records created after this ISO-8601 timestamp (system createdAt AFTER). Ignored when metadata filtering is disabled.",
        },
        created_before: {
          type: "string",
          description:
            "Only return records created before this ISO-8601 timestamp (system createdAt BEFORE). Ignored when metadata filtering is disabled.",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const scopeStr = (params.scope as string) ?? "global";
      const strategy = params.strategy as string | undefined;
      const maxResults = (params.max_results as number) ?? 20;

      const scope = parseScope(scopeStr);
      const allNamespaces = scopeToSearchNamespaces(scope, config.namespaceMode);

      // Permission check — namespaces are resolved/authorized via scopes.ts FIRST,
      // before any metadata filter is constructed or applied (no privilege
      // escalation; filters only narrow an already-authorized set — Req 15.1/15.2).
      const actorId = getActorId();
      const peerId = getPeerId?.();
      const readCheck = isScopeReadable(actorId, allNamespaces, config.scopes, config.namespaceMode, peerId, getAgentId?.());
      if (!readCheck.allowed) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: `Scope '${scopeToString(scope)}' is not in your accessible namespaces. Configure scopes.agentAccess to grant access.` }) }],
          details: { error: "permission_denied" },
        };
      }

      // Filter namespaces by strategy instead of passing strategyId to AWS
      const namespaces = filterNamespacesByStrategy(readCheck.filteredNamespaces, strategy);

      // Build metadata filters via the single validated path. When metadata
      // filtering is disabled the feature is inert: no filters are constructed
      // and the emitted list command is byte-identical to pre-feature behavior
      // (Requirements 5.1, 14.4).
      let metadataFilters: MetadataFilter[] = [];
      let dropped: DroppedFilter[] = [];
      if (config.metadata.enabled) {
        const built = buildFilters({
          enabled: true,
          userFilters: params.filters as MetadataFilterInput[] | undefined,
          createdAfter: params.created_after as string | undefined,
          createdBefore: params.created_before as string | undefined,
          indexedKeys: config.metadata.indexedKeys,
          dropUnindexedFilters: config.metadata.dropUnindexedFilters,
        });
        metadataFilters = built.filters;
        dropped = built.dropped;
      }

      try {
        // Keep per-namespace Promise.allSettled isolation: a pass-through filter
        // that trips an AWS validation error only drops that namespace, leaving
        // results from the unaffected namespaces intact (Requirement 10.3).
        const allResults = await Promise.allSettled(
          namespaces.map((ns) =>
            client.listMemoryRecords({
              namespace: ns,
              maxResults,
              ...(metadataFilters.length > 0 ? { metadataFilters } : {}),
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
          details: {
            count: data.count,
            hasMore: data.hasMore,
            // Surface any filters dropped during construction (over cap, not
            // indexed, invalid operator/value) so callers can correct input.
            ...(dropped.length > 0 ? { dropped } : {}),
          },
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
