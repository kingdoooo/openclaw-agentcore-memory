import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import type { PluginConfig } from "./config.js";
import type { AgentCoreClient } from "./client.js";
import { scopeToNamespace } from "./scopes.js";

interface FileEntry {
  hash: string;
  recordId: string;
}

interface SyncState {
  files: Record<string, FileEntry>;
  lastSyncAt?: string;
}

interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  debug: (msg: string) => void;
}

const SYNC_STATE_FILE = ".agentcore-sync.json";
const MAX_FILE_SIZE = 25 * 1024; // 25KB

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
        const raw = JSON.parse(readFileSync(this.stateFile, "utf-8"));
        // Migration: old format { hashes } has no "files" key → treat as empty
        if (raw.files && typeof raw.files === "object") {
          return raw as SyncState;
        }
      }
    } catch {
      // Ignore corrupted state
    }
    return { files: {} };
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

  async syncAll(actorId: string): Promise<number> {
    if (!this.config.fileSyncEnabled) return 0;

    const namespace = scopeToNamespace({ kind: "agent", id: actorId });
    const filePaths = this.resolveFilePaths();
    let syncedCount = 0;

    // Create or update files
    for (const filePath of filePaths) {
      try {
        const fullPath = resolve(this.agentDir, filePath);
        if (!existsSync(fullPath)) continue;

        const content = readFileSync(fullPath, "utf-8");
        if (!content.trim()) continue;

        if (content.length > MAX_FILE_SIZE) {
          this.log.warn(`[file-sync] Skipped ${filePath}: exceeds ${MAX_FILE_SIZE} bytes (${content.length})`);
          continue;
        }

        const hash = this.computeHash(content);
        const entry = this.state.files[filePath];

        if (entry && entry.hash === hash) continue; // unchanged

        if (entry?.recordId) {
          // Update existing record (content only, no namespaces)
          const result = await this.client.batchUpdateRecords([
            { memoryRecordId: entry.recordId, content },
          ]);
          if (result.successful.length > 0) {
            this.state.files[filePath] = { hash, recordId: entry.recordId };
            syncedCount++;
            this.log.debug(`[file-sync] Updated ${filePath}`);
          } else {
            this.log.warn(`[file-sync] Failed to update ${filePath}: ${result.failed.join(", ")}`);
          }
        } else {
          // Create new record
          const result = await this.client.batchCreateRecords([
            { content, namespaces: [namespace] },
          ]);
          if (result.successful.length > 0) {
            this.state.files[filePath] = { hash, recordId: result.successful[0] };
            syncedCount++;
            this.log.debug(`[file-sync] Created ${filePath}`);
          } else {
            this.log.warn(`[file-sync] Failed to create ${filePath}: ${result.failed.join(", ")}`);
          }
        }
      } catch (err) {
        this.log.warn(`[file-sync] Failed to sync ${filePath}: ${err}`);
      }
    }

    // Delete records for files that no longer exist on disk
    const existingFiles = new Set(filePaths.filter((p) => {
      const fullPath = resolve(this.agentDir, p);
      return existsSync(fullPath);
    }));

    const toDelete: string[] = [];
    for (const [filePath, entry] of Object.entries(this.state.files)) {
      if (!existingFiles.has(filePath) && entry.recordId) {
        toDelete.push(entry.recordId);
        delete this.state.files[filePath];
        this.log.debug(`[file-sync] Deleted record for removed file ${filePath}`);
        syncedCount++;
      }
    }
    if (toDelete.length > 0) {
      try {
        await this.client.batchDeleteRecords(toDelete);
      } catch (err) {
        this.log.warn(`[file-sync] Failed to delete records: ${err}`);
      }
    }

    if (syncedCount > 0) {
      this.state.lastSyncAt = new Date().toISOString();
      this.saveState();
    }

    return syncedCount;
  }

  private resolveFilePaths(): string[] {
    const paths: string[] = [];

    for (const pattern of this.config.fileSyncPaths) {
      if (pattern.includes("*")) {
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
