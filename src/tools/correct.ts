import type { AgentCoreClient } from "../client.js";

export function createCorrectTool(client: AgentCoreClient) {
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

      try {
        // Try batch update first (preserves original record ID)
        const updateResult = await client.batchUpdateRecords([
          { memoryRecordId: recordId, content: newContent },
        ]);

        if (updateResult.successful.length > 0) {
          const data = {
            corrected: true,
            method: "update",
            recordId,
          };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
            details: { corrected: true, method: "update" },
          };
        }

        // Update failed — check if record exists
        const existing = await client.getMemoryRecord(recordId);
        if (existing) {
          // Record exists but update failed for unknown reason
          const data = {
            corrected: false,
            error: `Update failed: ${updateResult.failed.join(", ")}`,
          };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
            details: { corrected: false },
          };
        }

        // Record not found — fallback to create
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
