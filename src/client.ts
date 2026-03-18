import {
  BedrockAgentCoreClient,
  CreateEventCommand,
  RetrieveMemoryRecordsCommand,
  ListMemoryRecordsCommand,
  GetMemoryRecordCommand,
  BatchCreateMemoryRecordsCommand,
  DeleteMemoryRecordCommand,
  BatchDeleteMemoryRecordsCommand,
  BatchUpdateMemoryRecordsCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import type { PluginConfig } from "./config.js";

export interface EventInput {
  actorId: string;
  sessionId: string;
  messages: Array<{ role: string; text: string }>;
  metadata?: Record<string, string>;
}

export interface SearchOptions {
  query: string;
  namespace: string;
  topK?: number;
  strategyId?: string;
}

export interface ListRecordsOptions {
  namespace: string;
  strategyId?: string;
  maxResults?: number;
  nextToken?: string;
}

export interface MemoryRecordResult {
  memoryRecordId: string;
  content: string;
  memoryStrategyId: string;
  namespaces: string[];
  score?: number;
  createdAt: Date;
  metadata?: Record<string, string>;
}

export interface CustomRecordInput {
  content: string;
  namespaces: string[];
  metadata?: Record<string, string>;
}

export class AgentCoreClient {
  private client: BedrockAgentCoreClient;
  private memoryId: string;

  constructor(config: PluginConfig) {
    this.memoryId = config.memoryId;
    this.client = new BedrockAgentCoreClient({
      region: config.awsRegion,
      credentials: config.awsProfile
        ? fromNodeProviderChain({ profile: config.awsProfile })
        : fromNodeProviderChain(),
      maxAttempts: config.maxRetries,
      requestHandler: {
        requestTimeout: config.timeoutMs,
      },
    });
  }

  async createEvent(input: EventInput): Promise<string> {
    const command = new CreateEventCommand({
      memoryId: this.memoryId,
      actorId: input.actorId,
      sessionId: input.sessionId,
      eventTimestamp: new Date(),
      payload: input.messages.map((m) => ({
        conversational: {
          content: { text: m.text },
          role: mapRole(m.role),
        },
      })),
      ...(input.metadata
        ? {
            metadata: Object.fromEntries(
              Object.entries(input.metadata).map(([k, v]) => [
                k,
                { stringValue: v },
              ]),
            ),
          }
        : {}),
    });

    const response = await this.client.send(command);
    return response.event?.eventId ?? "";
  }

  async retrieveMemoryRecords(
    options: SearchOptions,
  ): Promise<MemoryRecordResult[]> {
    const command = new RetrieveMemoryRecordsCommand({
      memoryId: this.memoryId,
      namespace: options.namespace,
      searchCriteria: {
        searchQuery: options.query,
        ...(options.topK ? { topK: options.topK } : {}),
        ...(options.strategyId
          ? { memoryStrategyId: options.strategyId }
          : {}),
      },
    });

    const response = await this.client.send(command);
    return (response.memoryRecordSummaries ?? []).map(mapRecordSummary);
  }

  async listMemoryRecords(
    options: ListRecordsOptions,
  ): Promise<{ records: MemoryRecordResult[]; nextToken?: string }> {
    const command = new ListMemoryRecordsCommand({
      memoryId: this.memoryId,
      namespace: options.namespace,
      ...(options.strategyId
        ? { memoryStrategyId: options.strategyId }
        : {}),
      ...(options.maxResults ? { maxResults: options.maxResults } : {}),
      ...(options.nextToken ? { nextToken: options.nextToken } : {}),
    });

    const response = await this.client.send(command);
    return {
      records: (response.memoryRecordSummaries ?? []).map(mapRecordSummary),
      nextToken: response.nextToken,
    };
  }

  async getMemoryRecord(
    recordId: string,
  ): Promise<MemoryRecordResult | null> {
    try {
      const command = new GetMemoryRecordCommand({
        memoryId: this.memoryId,
        memoryRecordId: recordId,
      });
      const response = await this.client.send(command);
      if (!response.memoryRecord) return null;
      const rec = response.memoryRecord;
      return {
        memoryRecordId: rec.memoryRecordId ?? recordId,
        content: extractContent(rec.content),
        memoryStrategyId: rec.memoryStrategyId ?? "",
        namespaces: rec.namespaces ?? [],
        createdAt: rec.createdAt ?? new Date(),
        metadata: extractMetadata(rec.metadata),
      };
    } catch (err: unknown) {
      if (isResourceNotFound(err)) return null;
      throw err;
    }
  }

  async batchCreateRecords(
    records: CustomRecordInput[],
  ): Promise<{ successful: string[]; failed: string[] }> {
    const command = new BatchCreateMemoryRecordsCommand({
      memoryId: this.memoryId,
      records: records.map((r, i) => ({
        requestIdentifier: `req-${Date.now()}-${i}`,
        namespaces: r.namespaces,
        content: { text: r.content },
        timestamp: new Date(),
        ...(r.metadata
          ? {
              metadata: Object.fromEntries(
                Object.entries(r.metadata).map(([k, v]) => [
                  k,
                  { stringValue: v },
                ]),
              ),
            }
          : {}),
      })),
    });

    const response = await this.client.send(command);
    return {
      successful: (response.successfulRecords ?? [])
        .filter((r) => r.status === "SUCCEEDED")
        .map((r) => r.memoryRecordId ?? ""),
      failed: (response.failedRecords ?? []).map(
        (r) => r.errorMessage ?? r.memoryRecordId ?? "unknown",
      ),
    };
  }

  async batchUpdateRecords(
    records: Array<{
      memoryRecordId: string;
      content: string;
      namespaces?: string[];
    }>,
  ): Promise<{ successful: string[]; failed: string[] }> {
    const command = new BatchUpdateMemoryRecordsCommand({
      memoryId: this.memoryId,
      records: records.map((r) => ({
        memoryRecordId: r.memoryRecordId,
        content: { text: r.content },
        timestamp: new Date(),
        ...(r.namespaces ? { namespaces: r.namespaces } : {}),
      })),
    });

    const response = await this.client.send(command);
    return {
      successful: (response.successfulRecords ?? [])
        .filter((r) => r.status === "SUCCEEDED")
        .map((r) => r.memoryRecordId ?? ""),
      failed: (response.failedRecords ?? []).map(
        (r) => r.errorMessage ?? r.memoryRecordId ?? "unknown",
      ),
    };
  }

  async deleteMemoryRecord(recordId: string): Promise<void> {
    const command = new DeleteMemoryRecordCommand({
      memoryId: this.memoryId,
      memoryRecordId: recordId,
    });
    await this.client.send(command);
  }

  async batchDeleteRecords(recordIds: string[]): Promise<void> {
    const command = new BatchDeleteMemoryRecordsCommand({
      memoryId: this.memoryId,
      records: recordIds.map((id) => ({ memoryRecordId: id })),
    });
    await this.client.send(command);
  }

  dispose(): void {
    this.client.destroy();
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapRecordSummary(summary: any): MemoryRecordResult {
  return {
    memoryRecordId: summary.memoryRecordId ?? "",
    content: extractContent(summary.content),
    memoryStrategyId: summary.memoryStrategyId ?? "",
    namespaces: summary.namespaces ?? [],
    score: summary.score,
    createdAt: summary.createdAt ?? new Date(),
    metadata: extractMetadata(summary.metadata),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractContent(content: any): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (content.text) return content.text;
  return "";
}

function extractMetadata(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata: any,
): Record<string, string> | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (v && typeof v === "object" && "stringValue" in (v as object)) {
      result[k] = (v as { stringValue: string }).stringValue;
    } else if (typeof v === "string") {
      result[k] = v;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function mapRole(role: string): "USER" | "ASSISTANT" | "TOOL" | "OTHER" {
  const upper = role.toUpperCase();
  if (upper === "USER") return "USER";
  if (upper === "ASSISTANT") return "ASSISTANT";
  if (upper === "TOOL") return "TOOL";
  return "OTHER";
}

function isResourceNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if ("name" in err && err.name === "ResourceNotFoundException") return true;
  if ("$metadata" in err) {
    const meta = (err as { $metadata: { httpStatusCode?: number } }).$metadata;
    if (meta?.httpStatusCode === 404) return true;
  }
  return false;
}
