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
import type { MemoryMetadataFilterExpression } from "@aws-sdk/client-bedrock-agentcore";
import type { PluginConfig } from "./config.js";
import type { MetadataFilter } from "./metadata-filter.js";

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
  metadataFilters?: MetadataFilter[];
}

export interface ListRecordsOptions {
  namespace: string;
  strategyId?: string;
  maxResults?: number;
  nextToken?: string;
  metadataFilters?: MetadataFilter[];
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

interface StatsCacheEntry {
  count: number;
  updatedAt: number;
}

export class AgentCoreClient {
  private client: BedrockAgentCoreClient;
  private memoryId: string;
  private statsCache = new Map<string, StatsCacheEntry>();
  private statsCacheTtlMs: number;
  // Retained for lazily constructing the read-only control-plane client used by
  // describeMemoryIndexedKeys() (see Task 9 startup validation).
  private awsRegion: string;
  private awsProfile?: string;
  private maxRetries: number;
  private timeoutMs: number;

  constructor(config: PluginConfig) {
    this.memoryId = config.memoryId;
    this.statsCacheTtlMs = config.statsCacheTtlMs;
    this.awsRegion = config.awsRegion;
    this.awsProfile = config.awsProfile;
    this.maxRetries = config.maxRetries;
    this.timeoutMs = config.timeoutMs;
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

  /**
   * Read-only inspection of the provisioned memory resource's declared indexed
   * keys, via the CONTROL-PLANE `GetMemory` API
   * (`@aws-sdk/client-bedrock-agentcore-control`), which is a separate service
   * from the data-plane `BedrockAgentCoreClient` used everywhere else here.
   *
   * Used by the startup validation in `index.ts` to compare the memory's
   * declared indexed keys against `config.metadata.indexedKeys`
   * (Requirements 13.1, 13.3).
   *
   * This method NEVER creates or mutates the memory resource — it issues only
   * the read-only `GetMemoryCommand` (Requirement 13.4).
   *
   * Graceful degradation (Requirement 16.3): if the control-plane SDK cannot be
   * loaded, credentials/permissions are missing, or `GetMemory` fails for any
   * reason, this returns `null` (meaning "could not determine") instead of
   * throwing, so plugin startup and the data path are never disrupted.
   *
   * @returns the declared indexed-key names, or `null` when they cannot be read.
   */
  async describeMemoryIndexedKeys(): Promise<string[] | null> {
    let controlClient: { send: (cmd: unknown) => Promise<unknown>; destroy: () => void } | undefined;
    try {
      // Dynamic import so a missing/unavailable control-plane SDK degrades
      // gracefully (caught below) rather than breaking module load.
      const { BedrockAgentCoreControlClient, GetMemoryCommand } = await import(
        "@aws-sdk/client-bedrock-agentcore-control"
      );
      controlClient = new BedrockAgentCoreControlClient({
        region: this.awsRegion,
        credentials: this.awsProfile
          ? fromNodeProviderChain({ profile: this.awsProfile })
          : fromNodeProviderChain(),
        maxAttempts: this.maxRetries,
        requestHandler: { requestTimeout: this.timeoutMs },
      }) as unknown as { send: (cmd: unknown) => Promise<unknown>; destroy: () => void };

      const response = (await controlClient.send(
        new GetMemoryCommand({ memoryId: this.memoryId }),
      )) as { memory?: { indexedKeys?: Array<{ key?: string }> } };

      return (response.memory?.indexedKeys ?? [])
        .map((k) => k?.key)
        .filter((k): k is string => typeof k === "string" && k !== "");
    } catch {
      // Control-plane SDK/permission unavailable or GetMemory failed.
      return null;
    } finally {
      try {
        controlClient?.destroy();
      } catch {
        /* ignore disposal errors */
      }
    }
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
        ...(options.metadataFilters && options.metadataFilters.length > 0
          ? { metadataFilters: toSdkFilters(options.metadataFilters) }
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
      ...(options.metadataFilters && options.metadataFilters.length > 0
        ? { metadataFilters: toSdkFilters(options.metadataFilters) }
        : {}),
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
    const result = {
      successful: (response.successfulRecords ?? [])
        .filter((r) => r.status === "SUCCEEDED")
        .map((r) => r.memoryRecordId ?? ""),
      failed: (response.failedRecords ?? []).map(
        (r) => r.errorMessage ?? r.memoryRecordId ?? "unknown",
      ),
    };
    if (result.successful.length > 0) this.invalidateStatsCache();
    return result;
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
    this.invalidateStatsCache();
  }

  async batchDeleteRecords(recordIds: string[]): Promise<void> {
    const command = new BatchDeleteMemoryRecordsCommand({
      memoryId: this.memoryId,
      records: recordIds.map((id) => ({ memoryRecordId: id })),
    });
    await this.client.send(command);
    if (recordIds.length > 0) this.invalidateStatsCache();
  }

  getStatsCached(
    key: string,
  ): { count: number; updatedAt: number } | undefined {
    const entry = this.statsCache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.updatedAt > this.statsCacheTtlMs) {
      this.statsCache.delete(key);
      return undefined;
    }
    return entry;
  }

  setStatsCache(key: string, count: number): void {
    this.statsCache.set(key, { count, updatedAt: Date.now() });
  }

  invalidateStatsCache(): void {
    this.statsCache.clear();
  }

  dispose(): void {
    this.client.destroy();
  }
}

// Reconcile our module's broader FilterOperator union with the installed SDK's
// narrower `OperatorType` TS enum. The AgentCore data plane accepts the full
// operator set (CONTAINS / BEFORE / AFTER / comparison operators); the SDK's
// type definitions lag behind that capability, so we cast at this single
// boundary. Filters are validated/normalized upstream in metadata-filter.ts.
function toSdkFilters(
  filters: MetadataFilter[],
): MemoryMetadataFilterExpression[] {
  return filters as unknown as MemoryMetadataFilterExpression[];
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
