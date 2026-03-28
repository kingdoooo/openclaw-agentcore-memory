import type { AgentCoreClient } from "../client.js";
import type { PluginConfig } from "../config.js";
import { isScopeWritable } from "../scopes.js";

function isRetryable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name ?? "";
  if (name === "ThrottlingException" || name === "ServiceUnavailableException") return true;
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return status !== undefined && status >= 500;
}

async function retryWithBackoff<T>(fn: () => Promise<T>): Promise<T> {
  const delays = [200, 400, 800];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < delays.length && isRetryable(err)) {
        await new Promise((r) => setTimeout(r, delays[attempt]));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

export function createCorrectTool(client: AgentCoreClient, config: PluginConfig, getActorId: () => string, getPeerId?: () => string | undefined) {
  return {
    name: "agentcore_correct",
    label: "AgentCore Correct",
    description:
      "Update or correct an existing memory record in place. If the record doesn't exist, creates a new one as fallback.",
    parameters: {
      type: "object",
      properties: {
        record_id: {
          type: "string",
          description: "ID of the record to update",
        },
        new_content: {
          type: "string",
          description: "The corrected content",
        },
      },
      required: ["record_id", "new_content"],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const recordId = params.record_id as string;
      const newContent = params.new_content as string;
      const actorId = getActorId();

      try {
        // Check if record exists and verify write permission
        const existing = await client.getMemoryRecord(recordId);
        if (existing) {
          const peerId = getPeerId?.();
          const writable = existing.namespaces.some(ns => isScopeWritable(actorId, ns, config.scopes, config.namespaceMode, peerId));
          if (!writable) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ corrected: false, error: `Record '${recordId}' is not in your writable namespaces. Configure scopes.writeAccess to grant access.` }) }],
              details: { corrected: false, error: "permission_denied" },
            };
          }

          // Try batch update with exponential backoff for transient errors
          const updateResult = await retryWithBackoff(() =>
            client.batchUpdateRecords([
              { memoryRecordId: recordId, content: newContent },
            ]),
          );

          if (updateResult.successful.length > 0) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ corrected: true, method: "update", recordId }, null, 2) }],
              details: { corrected: true, method: "update" },
            };
          }

          // Record exists but update failed for unknown reason
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ corrected: false, error: `Update failed: ${updateResult.failed.join(", ")}` }, null, 2) }],
            details: { corrected: false },
          };
        }

        // Record not found — fallback to create in /global (always writable)
        const createResult = await client.batchCreateRecords([
          {
            content: newContent,
            namespaces: ["/global"],
            metadata: {
              correctedFrom: recordId,
              correctedAt: new Date().toISOString(),
              source: "correction-fallback",
            },
          },
        ]);
        const data = {
          corrected: true,
          method: "create",
          note: `Original record ${recordId} not found, created new record.`,
          newRecordIds: createResult.successful,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
          details: { corrected: true, method: "create" },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ corrected: false, error: `Correction failed: ${err}` }) }],
          details: { corrected: false },
        };
      }
    },
  };
}
