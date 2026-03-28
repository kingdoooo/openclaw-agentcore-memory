import type { AgentCoreClient } from "../client.js";
import type { PluginConfig } from "../config.js";
import { parseScope, scopeToNamespace, scopeToString, isScopeWritable } from "../scopes.js";

export function createStoreTool(client: AgentCoreClient, config: PluginConfig, getActorId: () => string, getPeerId?: () => string | undefined) {
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
            "Scope: 'global', 'agent:<id>', 'project:<id>', 'user:<id>'",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags for categorization",
        },
      },
      required: ["content"],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const content = params.content as string;
      const category = (params.category as string) ?? "other";
      const importance = (params.importance as number) ?? 0.5;
      const scopeStr = (params.scope as string) ?? "global";
      const tags = (params.tags as string[]) ?? [];

      const scope = parseScope(scopeStr);
      const namespace = scopeToNamespace(scope);

      // Write permission check
      const actorId = getActorId();
      const peerId = getPeerId?.();
      if (!isScopeWritable(actorId, namespace, config.scopes, config.namespaceMode, peerId)) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ stored: false, error: `Scope '${scopeToString(scope)}' is not in your writable namespaces. Configure scopes.writeAccess to grant access.` }) }],
          details: { stored: false, error: "permission_denied" },
        };
      }

      try {
        const result = await client.batchCreateRecords([
          {
            content,
            namespaces: [namespace],
            metadata: {
              category,
              importance: String(importance),
              scope: scopeStr,
              source: "manual",
              ...(tags.length > 0 ? { tags: JSON.stringify(tags) } : {}),
              ...(peerId ? { userId: peerId } : {}),
            },
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
