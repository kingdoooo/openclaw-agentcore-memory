import type { AgentCoreClient } from "../client.js";
import type { PluginConfig } from "../config.js";
import { parseScope, scopeToNamespace, scopeToString, isScopeWritable } from "../scopes.js";
import { buildRecordMetadata } from "../metadata-filter.js";

export function createStoreTool(client: AgentCoreClient, config: PluginConfig, getActorId: () => string, getPeerId?: () => string | undefined, getAgentId?: () => string) {
  return {
    name: "agentcore_store",
    label: "AgentCore Store",
    description:
      "Save important facts, preferences, or decisions to AgentCore long-term memory. Stored memories persist across sessions and can be shared across agents.",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The memory content to store",
        },
        category: {
          type: "string",
          enum: ["preference", "fact", "decision", "entity", "other"],
          description: "Memory category (default: other)",
        },
        importance: {
          type: "number",
          description: "Importance 0.0-1.0 (default: 0.5)",
        },
        scope: {
          type: "string",
          description:
            "Scope: 'global', 'agent:<id>', 'project:<id>', 'user:<id>'. In DM sessions, defaults to current user scope; otherwise defaults to 'global'.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags for categorization",
        },
        metadata: {
          type: "object",
          description:
            "Optional structured attributes (e.g. priority, department, channel) attached to the record. Only keys declared as indexed/schema keys are stored; unknown keys and values outside a configured allowedValues set are dropped. Ignored when metadata filtering is disabled.",
        },
        strictMetadata: {
          type: "object",
          description:
            "Optional strictly-consistent (deterministic) classifier values, copied verbatim for keys configured as strict keys. Ignored when metadata filtering is disabled.",
        },
      },
      required: ["content"],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const content = params.content as string;
      const category = (params.category as string) ?? "other";
      const importance = (params.importance as number) ?? 0.5;
      const peerId = getPeerId?.();
      const scopeStr = (params.scope as string)
        ?? (peerId ? `user:${peerId}` : "global");
      const tags = (params.tags as string[]) ?? [];
      const userMeta = params.metadata as Record<string, string | number | string[]> | undefined;
      const strictMeta = params.strictMetadata as Record<string, string> | undefined;

      const scope = parseScope(scopeStr);
      const namespace = scopeToNamespace(scope);

      // Write permission check
      const actorId = getActorId();
      if (!isScopeWritable(actorId, namespace, config.scopes, config.namespaceMode, peerId)) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ stored: false, error: `Scope '${scopeToString(scope)}' is not in your writable namespaces. Configure scopes.writeAccess to grant access.` }) }],
          details: { stored: false, error: "permission_denied" },
        };
      }

      // Base metadata attached today (category/importance/scope/source/tags/userId).
      const baseMetadata: Record<string, string> = {
        category,
        importance: String(importance),
        scope: scopeStr,
        source: "manual",
        ...(tags.length > 0 ? { tags: JSON.stringify(tags) } : {}),
        ...(peerId ? { userId: peerId } : {}),
      };

      // When metadata filtering is enabled, merge user-supplied structured +
      // strictly-consistent metadata onto the base via the single validated
      // path; otherwise keep today's base metadata unchanged (Requirement 14.2).
      // buildRecordMetadata drops unknown keys and allowedValues-rejected values
      // (retaining all other keys) rather than failing the store (Requirement 16.2).
      const metadata = config.metadata.enabled
        ? buildRecordMetadata(baseMetadata, userMeta, strictMeta, config.metadata)
        : baseMetadata;

      try {
        const result = await client.batchCreateRecords([
          {
            content,
            namespaces: [namespace],
            metadata,
          },
        ]);

        const data = {
          stored: result.successful.length > 0,
          recordIds: result.successful,
          namespace,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
          details: { stored: data.stored },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ stored: false, error: `Store failed: ${err}` }) }],
          details: { stored: false, error: String(err) },
        };
      }
    },
  };
}
