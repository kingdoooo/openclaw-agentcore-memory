import type { AgentCoreClient } from "../client.js";
import { parseScope, scopeToNamespace } from "../scopes.js";

export function createShareTool(client: AgentCoreClient) {
  return {
    name: "agentcore_share",
    label: "AgentCore Share",
    description:
      "Share a memory across multiple scopes/namespaces. Creates the same record in each target namespace.",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The memory content to share",
        },
        target_scopes: {
          type: "array",
          items: { type: "string" },
          description:
            "Target scopes, e.g. ['agent:sales-bot', 'project:ecommerce']",
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
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags for categorization",
        },
      },
      required: ["content", "target_scopes"],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const content = params.content as string;
      const targetScopes = params.target_scopes as string[] | undefined;
      const category = (params.category as string) ?? "other";
      const importance = (params.importance as number) ?? 0.5;
      const tags = (params.tags as string[]) ?? [];

      if (!targetScopes || targetScopes.length === 0) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ shared: false, error: "target_scopes is required and must not be empty" }) }],
          details: { shared: false },
        };
      }

      const targetNamespaces = targetScopes.map((s) =>
        scopeToNamespace(parseScope(s)),
      );
      const allRecordIds: string[] = [];
      const failed: string[] = [];

      for (const namespace of targetNamespaces) {
        try {
          const result = await client.batchCreateRecords([
            {
              content,
              namespaces: [namespace],
              metadata: {
                category,
                importance: String(importance),
                source: "shared",
                sharedAt: new Date().toISOString(),
                ...(tags.length > 0 ? { tags: JSON.stringify(tags) } : {}),
              },
            },
          ]);
          allRecordIds.push(...result.successful);
          if (result.failed.length > 0) {
            failed.push(`${namespace}: ${result.failed.join(", ")}`);
          }
        } catch (err) {
          failed.push(`${namespace}: ${err}`);
        }
      }

      const data = {
        shared: allRecordIds.length > 0,
        targetNamespaces,
        recordIds: allRecordIds,
        ...(failed.length > 0 ? { failed } : {}),
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        details: { shared: data.shared, count: allRecordIds.length },
      };
    },
  };
}
