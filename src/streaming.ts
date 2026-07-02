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
}

const RING_BUFFER_SIZE = 50;
const POLL_INTERVAL_MS = 5000;

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
    };
  }

  async start(): Promise<void> {
    if (this._isRunning) return;
    this._isRunning = true;
    this._isPaused = false;

    try {
      await this.initializeShardIterators();
      this.schedulePoll();
    } catch (err) {
      this._isRunning = false;
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
        try {
          const cmd = new GetRecordsCommand({
            ShardIterator: iterator,
            Limit: 100,
          });
          const response = await this.kinesisClient.send(cmd);

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
        } catch {
          // Graceful degradation on poll errors - continue with other shards
        }
      }
    }

    this.schedulePoll();
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
