import type { AgentCoreClient } from "../client.js";
import { parseScope, scopeToNamespace } from "../scopes.js";

export function createForgetTool(client: AgentCoreClient) {
  return {
    name: "agentcore_forget",
    label: "AgentCore Forget",
    description:
      "Delete memories from AgentCore. Use search_query to preview what would be deleted, then confirm with record IDs.",
    parameters: {
      type: "object",
      properties: {
        record_ids: {
          type: "array",
          items: { type: "string" },
          description: "Specific record IDs to delete",
        },
        search_query: {
          type: "string",
          description:
            "Search for records to delete (preview mode unless confirm=true)",
        },
        confirm: {
          type: "boolean",
          description:
            "Set true to actually delete search results or purge scope (default: false)",
        },
        scope: {
          type: "string",
          description: "Scope for search_query or purge_scope (default: global)",
        },
        purge_scope: {
          type: "boolean",
          description:
            "Set true to delete ALL records in the given scope. Requires confirm=true.",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const recordIds = params.record_ids as string[] | undefined;
      const searchQuery = params.search_query as string | undefined;
      const confirm = (params.confirm as boolean) ?? false;
      const scopeStr = (params.scope as string) ?? "global";
      const purgeScope = (params.purge_scope as boolean) ?? false;

      // Purge entire scope
      if (purgeScope) {
        const namespace = scopeToNamespace(parseScope(scopeStr));
        try {
          // Count first
          let totalCount = 0;
          let nextToken: string | undefined;
          const allIds: string[] = [];
          do {
            const page = await client.listMemoryRecords({
              namespace,
              maxResults: 100,
              nextToken,
            });
            allIds.push(...page.records.map((r) => r.memoryRecordId));
            totalCount += page.records.length;
            nextToken = page.nextToken;
          } while (nextToken);

          if (!confirm) {
            const data = {
              deleted: false,
              purge_preview: true,
              scope: scopeStr,
              namespace,
              estimated_count: totalCount,
              note: "Set confirm=true to permanently delete ALL records in this scope.",
            };
            return {
              content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
              details: { deleted: false, previewCount: totalCount },
            };
          }

          // Batch delete in chunks of 25
          let deleted = 0;
          for (let i = 0; i < allIds.length; i += 25) {
            const chunk = allIds.slice(i, i + 25);
            await client.batchDeleteRecords(chunk);
            deleted += chunk.length;
          }

          const data = { deleted: true, purged: true, scope: scopeStr, namespace, count: deleted };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
            details: { deleted: true, count: deleted },
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ deleted: false, error: `Purge failed: ${err}` }) }],
            details: { deleted: false },
          };
        }
      }

      // Direct delete by IDs
      if (recordIds && recordIds.length > 0) {
        try {
          await client.batchDeleteRecords(recordIds);
          const data = { deleted: true, count: recordIds.length, recordIds };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
            details: { deleted: true, count: recordIds.length },
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ deleted: false, error: `Delete failed: ${err}` }) }],
            details: { deleted: false },
          };
        }
      }

      // Search-based delete
      if (searchQuery) {
        const namespace = scopeToNamespace(parseScope(scopeStr));
        try {
          const records = await client.retrieveMemoryRecords({
            query: searchQuery,
            namespace,
            topK: 10,
          });

          if (!confirm) {
            const data = {
              deleted: false,
              preview: records.map((r) => ({
                id: r.memoryRecordId,
                content: r.content.slice(0, 200),
                score: r.score ? Number(r.score.toFixed(3)) : undefined,
              })),
              note: "Set confirm=true to delete these records, or use record_ids to delete specific ones.",
            };
            return {
              content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
              details: { deleted: false, previewCount: records.length },
            };
          }

          const ids = records.map((r) => r.memoryRecordId);
          if (ids.length > 0) {
            await client.batchDeleteRecords(ids);
          }
          const data = { deleted: true, count: ids.length, recordIds: ids };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
            details: { deleted: true, count: ids.length },
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ deleted: false, error: `Search/delete failed: ${err}` }) }],
            details: { deleted: false },
          };
        }
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ deleted: false, error: "Provide record_ids, search_query, or purge_scope." }) }],
        details: { deleted: false },
      };
    },
  };
}
