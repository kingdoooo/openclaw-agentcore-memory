import {
  KinesisClient,
  ListShardsCommand,
  GetShardIteratorCommand,
  GetRecordsCommand,
} from "@aws-sdk/client-kinesis";
import type { PluginConfig } from "./config.js";

export type MemoryStreamEventType =
  | "MemoryRecordCreated"
  | "MemoryRecordUpdated"
  | "MemoryRecordDeleted"
  | "StreamingEnabled";

export interface MemoryStreamEvent {
  eventType: MemoryStreamEventType;
  eventTime: string;
  memoryId?: string;
  memoryRecordId?: string;
  namespaces?: string[];
  createdAt?: number;
  memoryStrategyId?: string;
  memoryStrategyType?: string;
  metadata?: Record<string, unknown>;
  memoryRecordText?: string;
}

export interface StreamConsumerCallbacks {
  onRecordCreated?: (event: MemoryStreamEvent) => void;
  onRecordUpdated?: (event: MemoryStreamEvent) => void;
  onRecordDeleted?: (event: MemoryStreamEvent) => void;
  onStatsCacheInvalidate?: () => void;
}

export interface StreamConsumerStatus {
  isRunning: boolean;
  isPaused: boolean;
  eventCount: number;
  lastEventTime: string | null;
  streamName: string | undefined;
  streamArn: string | undefined;
  startError: string | null;
}

const RING_BUFFER_SIZE = 50;
const POLL_INTERVAL_MS = 5000;
const MAX_BACKOFF_MS = 60000;
const BASE_BACKOFF_MS = 1000;

export class MemoryStreamConsumer {
  private kinesisClient: KinesisClient;
  private config: PluginConfig;
  private callbacks: StreamConsumerCallbacks;

  private _isRunning = false;
  private _isPaused = false;
  private _eventCount = 0;
  private _lastEventTime: string | null = null;
  private _recentEvents: MemoryStreamEvent[] = [];
  private _pollTimer: ReturnType<typeof setTimeout> | null = null;
  private _shardIterators: Map<string, string> = new Map();
  private _shardErrorCounts: Map<string, number> = new Map();
  private _startError: string | null = null;

  constructor(config: PluginConfig, callbacks: StreamConsumerCallbacks = {}) {
    this.config = config;
    this.callbacks = callbacks;
    this.kinesisClient = new KinesisClient({
      region: config.awsRegion,
    });
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  get isPaused(): boolean {
    return this._isPaused;
  }

  get eventCount(): number {
    return this._eventCount;
  }

  get lastEventTime(): string | null {
    return this._lastEventTime;
  }

  get recentEvents(): MemoryStreamEvent[] {
    return [...this._recentEvents];
  }

  getStatus(): StreamConsumerStatus {
    return {
      isRunning: this._isRunning,
      isPaused: this._isPaused,
      eventCount: this._eventCount,
      lastEventTime: this._lastEventTime,
      streamName: this.config.streamingKinesisStreamName,
      streamArn: this.config.streamingKinesisStreamArn,
      startError: this._startError,
    };
  }

  async start(): Promise<void> {
    if (this._isRunning) return;
    this._isRunning = true;
    this._isPaused = false;
    this._startError = null;

    try {
      await this.initializeShardIterators();
      this.schedulePoll();
    } catch (err) {
      this._isRunning = false;
      this._startError = String(err);
      throw err;
    }
  }

  async stop(): Promise<void> {
    this._isRunning = false;
    this._isPaused = false;
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    this._shardIterators.clear();
    this._shardErrorCounts.clear();
  }

  pause(): void {
    this._isPaused = true;
  }

  resume(): void {
    if (!this._isRunning) return;
    this._isPaused = false;
  }

  private async initializeShardIterators(): Promise<void> {
    const streamIdentifier = this.getStreamIdentifier();
    if (!streamIdentifier) return;

    try {
      const listCmd = this.config.streamingKinesisStreamArn
        ? new ListShardsCommand({ StreamARN: this.config.streamingKinesisStreamArn })
        : new ListShardsCommand({ StreamName: this.config.streamingKinesisStreamName });

      const response = await this.kinesisClient.send(listCmd);
      const shards = response.Shards ?? [];

      for (const shard of shards) {
        if (!shard.ShardId) continue;

        const iteratorCmd = this.config.streamingKinesisStreamArn
          ? new GetShardIteratorCommand({
              StreamARN: this.config.streamingKinesisStreamArn,
              ShardId: shard.ShardId,
              ShardIteratorType: "LATEST",
            })
          : new GetShardIteratorCommand({
              StreamName: this.config.streamingKinesisStreamName,
              ShardId: shard.ShardId,
              ShardIteratorType: "LATEST",
            });

        const iteratorResponse = await this.kinesisClient.send(iteratorCmd);
        if (iteratorResponse.ShardIterator) {
          this._shardIterators.set(shard.ShardId, iteratorResponse.ShardIterator);
        }
      }
    } catch (err) {
      // Graceful degradation - log but don't throw on shard init failure
      throw new Error(`Failed to initialize shard iterators: ${err}`);
    }
  }

  private getStreamIdentifier(): string | undefined {
    return this.config.streamingKinesisStreamName ?? this.config.streamingKinesisStreamArn;
  }

  private schedulePoll(): void {
    if (!this._isRunning) return;
    this._pollTimer = setTimeout(() => {
      void this.poll();
    }, POLL_INTERVAL_MS);
  }

  private async poll(): Promise<void> {
    if (!this._isRunning) return;

    if (!this._isPaused) {
      for (const [shardId, iterator] of this._shardIterators.entries()) {
        // Apply backoff: skip this shard if it's in backoff period
        const errorCount = this._shardErrorCounts.get(shardId) ?? 0;
        if (errorCount > 0) {
          const backoffMs = Math.min(
            BASE_BACKOFF_MS * Math.pow(2, errorCount - 1),
            MAX_BACKOFF_MS,
          );
          // Add jitter: random value between 0 and backoff/2
          const jitter = Math.random() * (backoffMs / 2);
          const totalBackoff = backoffMs + jitter;
          // Use a simple check: only skip if we haven't waited long enough
          // Since we poll every POLL_INTERVAL_MS, skip this shard if backoff > poll interval
          if (totalBackoff > POLL_INTERVAL_MS) {
            // Decrement error count to eventually retry
            this._shardErrorCounts.set(shardId, Math.max(0, errorCount - 1));
            continue;
          }
        }

        try {
          const cmd = new GetRecordsCommand({
            ShardIterator: iterator,
            Limit: 100,
          });
          const response = await this.kinesisClient.send(cmd);

          // Success - reset error count for this shard
          this._shardErrorCounts.delete(shardId);

          // Update shard iterator
          if (response.NextShardIterator) {
            this._shardIterators.set(shardId, response.NextShardIterator);
          } else {
            // Shard closed
            this._shardIterators.delete(shardId);
          }

          // Process records
          for (const record of response.Records ?? []) {
            if (!record.Data) continue;
            try {
              const text = new TextDecoder().decode(record.Data);
              const parsed = JSON.parse(text);
              const event = parsed.memoryStreamEvent as MemoryStreamEvent | undefined;
              if (event) {
                this.handleEvent(event);
              }
            } catch {
              // Skip unparseable records
            }
          }
        } catch (err: unknown) {
          const errorName = (err as { name?: string })?.name ?? "";
          const errorMessage = String(err);

          if (
            errorName === "ExpiredIteratorException" ||
            errorMessage.includes("ExpiredIteratorException")
          ) {
            // Re-initialize iterator for this shard
            try {
              await this.reinitializeShardIterator(shardId);
              this._shardErrorCounts.delete(shardId);
            } catch {
              // If re-init fails, apply backoff
              this._shardErrorCounts.set(shardId, (this._shardErrorCounts.get(shardId) ?? 0) + 1);
            }
          } else {
            // Increment error count for exponential backoff
            this._shardErrorCounts.set(shardId, (this._shardErrorCounts.get(shardId) ?? 0) + 1);
          }
        }
      }
    }

    this.schedulePoll();
  }

  private async reinitializeShardIterator(shardId: string): Promise<void> {
    const iteratorCmd = this.config.streamingKinesisStreamArn
      ? new GetShardIteratorCommand({
          StreamARN: this.config.streamingKinesisStreamArn,
          ShardId: shardId,
          ShardIteratorType: "LATEST",
        })
      : new GetShardIteratorCommand({
          StreamName: this.config.streamingKinesisStreamName,
          ShardId: shardId,
          ShardIteratorType: "LATEST",
        });

    const iteratorResponse = await this.kinesisClient.send(iteratorCmd);
    if (iteratorResponse.ShardIterator) {
      this._shardIterators.set(shardId, iteratorResponse.ShardIterator);
    } else {
      this._shardIterators.delete(shardId);
    }
  }

  private handleEvent(event: MemoryStreamEvent): void {
    this._eventCount++;
    this._lastEventTime = event.eventTime ?? new Date().toISOString();

    // Add to ring buffer
    this._recentEvents.push(event);
    if (this._recentEvents.length > RING_BUFFER_SIZE) {
      this._recentEvents.shift();
    }

    // Fire callbacks
    switch (event.eventType) {
      case "MemoryRecordCreated":
        this.callbacks.onRecordCreated?.(event);
        this.callbacks.onStatsCacheInvalidate?.();
        break;
      case "MemoryRecordUpdated":
        this.callbacks.onRecordUpdated?.(event);
        this.callbacks.onStatsCacheInvalidate?.();
        break;
      case "MemoryRecordDeleted":
        this.callbacks.onRecordDeleted?.(event);
        this.callbacks.onStatsCacheInvalidate?.();
        break;
    }
  }
}
