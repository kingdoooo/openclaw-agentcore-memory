import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { createHash } from "node:crypto";
import type { PluginConfig } from "./config.js";
import type { AgentCoreClient } from "./client.js";

interface SyncState {
  hashes: Record<string, string>;
  lastSyncAt?: string;
}

interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  debug: (msg: string) => void;
}

const SYNC_STATE_FILE = ".agentcore-sync.json";
const CHUNK_SIZE = 2000;

export class FileSync {
  private config: PluginConfig;
  private client: AgentCoreClient;
  private agentDir: string;
  private state: SyncState;
  private stateFile: string;
  private log: Logger;

  constructor(
    config: PluginConfig,
    client: AgentCoreClient,
    agentDir: string,
    log: Logger,
  ) {
    this.config = config;
    this.client = client;
    this.agentDir = agentDir;
    this.log = log;
    this.stateFile = join(agentDir, SYNC_STATE_FILE);
    this.state = this.loadState();
  }

  private loadState(): SyncState {
    try {
      if (existsSync(this.stateFile)) {
        return JSON.parse(readFileSync(this.stateFile, "utf-8"));
      }
    } catch {
      // Ignore corrupted state
    }
    return { hashes: {} };
  }

  private saveState(): void {
    try {
      writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
    } catch (err) {
      this.log.warn(`[file-sync] Failed to save state: ${err}`);
    }
  }

  private computeHash(content: string): string {
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
  }

  async syncAll(sessionId: string, actorId: string): Promise<number> {
    if (!this.config.fileSyncEnabled) return 0;

    let syncedCount = 0;
    const filePaths = this.resolveFilePaths();

    for (const filePath of filePaths) {
      try {
        const synced = await this.syncFile(filePath, sessionId, actorId);
        if (synced) syncedCount++;
      } catch (err) {
        this.log.warn(`[file-sync] Failed to sync ${filePath}: ${err}`);
      }
    }

    if (syncedCount > 0) {
      this.state.lastSyncAt = new Date().toISOString();
      this.saveState();
    }

    return syncedCount;
  }

  private async syncFile(
    filePath: string,
    sessionId: string,
    actorId: string,
  ): Promise<boolean> {
    const fullPath = resolve(this.agentDir, filePath);
    if (!existsSync(fullPath)) return false;

    const content = readFileSync(fullPath, "utf-8");
    if (!content.trim()) return false;

    const hash = this.computeHash(content);
    if (this.state.hashes[filePath] === hash) return false;

    const chunks = this.chunkContent(content);
    for (let i = 0; i < chunks.length; i++) {
      await this.client.createEvent({
        actorId,
        sessionId,
        messages: [{ role: "system", text: chunks[i] }],
        metadata: {
          source: "file-sync",
          file: filePath,
          chunk: `${i + 1}/${chunks.length}`,
        },
      });
    }

    this.state.hashes[filePath] = hash;
    this.log.debug(
      `[file-sync] Synced ${filePath} (${chunks.length} chunks)`,
    );
    return true;
  }

  private chunkContent(content: string): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < content.length; i += CHUNK_SIZE) {
      chunks.push(content.slice(i, i + CHUNK_SIZE));
    }
    return chunks;
  }

  private resolveFilePaths(): string[] {
    const paths: string[] = [];

    for (const pattern of this.config.fileSyncPaths) {
      if (pattern.includes("*")) {
        // Simple glob: "memory/*.md" -> list dir + filter
        const dir = dirname(pattern);
        const ext = pattern.split("*.").pop() ?? "";
        const fullDir = resolve(this.agentDir, dir);

        if (existsSync(fullDir)) {
          try {
            const entries = readdirSync(fullDir);
            for (const entry of entries) {
              if (ext && entry.endsWith(`.${ext}`)) {
                paths.push(join(dir, entry));
              }
            }
          } catch (err) {
            this.log.debug(`[file-sync] Cannot read directory ${fullDir}: ${err}`);
          }
        }
      } else {
        paths.push(pattern);
      }
    }

    return paths;
  }

  getState(): SyncState {
    return { ...this.state };
  }
}
