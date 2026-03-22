# File Sync Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple file sync from auto-capture and switch from `createEvent` to semantic memory records (`batchCreateRecords`/`batchUpdateRecords`/`batchDeleteRecords`).

**Architecture:** Rewrite `FileSync` class to use the client's record APIs instead of event API. Decouple the file sync call in `agent_end` hook so it runs independently of capture. Update CLI `agentcore-sync` to match new signature.

**Tech Stack:** TypeScript, AWS Bedrock AgentCore SDK (`@aws-sdk/client-bedrock-agentcore`)

**Spec:** `docs/superpowers/specs/2026-03-22-file-sync-refactor-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/file-sync.ts` | Rewrite | New sync logic: `batchCreateRecords`/`batchUpdateRecords`/`batchDeleteRecords`, new state format, remove chunking, 25KB guard |
| `src/index.ts` | Modify (3 sections) | 1) `agent_end` hook: decouple file sync from capture. 2) `agentcore-status` CLI: `state.hashes` → `state.files`. 3) `agentcore-sync` CLI: new signature + `--actor` option |

---

### Task 1: Rewrite `src/file-sync.ts`

**Files:**
- Rewrite: `src/file-sync.ts`

This is the core change. The new `FileSync` class uses record APIs, tracks recordIds, handles deletes, and has a 25KB file size guard.

- [ ] **Step 1: Rewrite `file-sync.ts` with new sync logic**

Replace the entire file. Key changes from current implementation:
- `SyncState.hashes` → `SyncState.files` (hash + recordId per file)
- `syncAll(sessionId, actorId)` → `syncAll(actorId)`
- `createEvent` calls → `batchCreateRecords` / `batchUpdateRecords` / `batchDeleteRecords`
- Remove `CHUNK_SIZE`, `chunkContent()`, `syncFile()` (replaced by inline logic)
- Add 25KB file size guard
- Add deletion detection (files in state but not on disk)
- Migration: old state format `{ hashes }` (no `files` key) → treated as empty

```ts
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
```

- [ ] **Step 2: Verify `file-sync.ts` compiles in isolation**

Run: `npm run typecheck`
Expected: **Will fail** — `index.ts` still references old `syncAll(sessionId, actorId)` signature and `state.hashes`. This is expected and will be fixed in Task 2.

- [ ] **Step 3: Commit**

```bash
git add src/file-sync.ts
git commit -m "refactor: rewrite file-sync to use semantic memory records

Switch from createEvent to batchCreateRecords/batchUpdateRecords/
batchDeleteRecords. Track recordIds in state, add 25KB guard,
handle file deletion, migrate old state format."
```

---

### Task 2: Decouple file sync from capture in `agent_end` hook

**Files:**
- Modify: `src/index.ts:266-365` (agent_end hook section)
- Modify: `src/index.ts:416` (agentcore-status CLI — `state.hashes` → `state.files`)

Move file sync out of the capture block so it runs independently. File sync only needs `actorId`, not `sessionId`. Also fix `agentcore-status` to use new state format.

- [ ] **Step 1: Restructure the `agent_end` handler**

In `src/index.ts`, the current structure is:

```
agent_end handler (line 267-364):
  guard: !client || !ready
  guard: !event.success
  fire-and-forget IIFE:
    capture logic (messages, noise filter, min length, sessionId)
    file sync (nested inside capture, after createEvent)
```

New structure:

```
agent_end handler:
  guard: !client || !ready
  guard: !event.success
  fire-and-forget IIFE:
    actorId resolution (shared)
    1) file sync (independent, only needs actorId)
    2) capture logic (needs sessionId, may skip independently)
```

Replace lines 266-365 of `src/index.ts`. The `if (config.autoCaptureEnabled)` wrapper stays but is renamed conceptually — it now guards both capture AND file sync since both are "agent_end" behaviors:

Find and replace the entire `agent_end` section (lines 266-365):

Old code (lines 266-365):
```ts
    // --- Hook: Auto-Capture (agent_end) - fire-and-forget ---
    if (config.autoCaptureEnabled) {
      api.on("agent_end", async (event: any, ctx: any) => {
        ...entire block including nested file sync...
      });
    }
```

New code:
```ts
    // --- Hook: agent_end (file sync + auto-capture) - fire-and-forget ---
    api.on("agent_end", async (event: any, ctx: any) => {
      if (!client || !ready) {
        api.logger.debug(`[agentcore] [agent_end] skipped: reason="not ready" (client=${!!client}, ready=${ready})`);
        return;
      }
      if (!event.success) {
        api.logger.debug(`[agentcore] [agent_end] skipped: reason="event not successful"`);
        return;
      }

      const actorId = ctx.sessionKey
        ? parseAgentIdFromSessionKey(ctx.sessionKey)
        : "default";

      // 1. File sync (independent, only needs actorId)
      if (fileSync) {
        try {
          const synced = await fileSync.syncAll(actorId);
          if (synced > 0) {
            api.logger.debug(`[agentcore] [file-sync] synced: ${synced} files (actorId=${actorId})`);
          }
        } catch (err) {
          api.logger.warn(`[agentcore] [file-sync] error: ${err}`);
        }
      }

      // 2. Auto-capture (needs sessionId, may skip independently)
      if (!config.autoCaptureEnabled) return;

      void (async () => {
        try {
          const captureStart = Date.now();
          const messages = (event.messages ?? []) as Array<{ role?: string; content?: any }>;
          if (messages.length === 0) { api.logger.debug(`[agentcore] [capture] skipped: reason="no messages"`); return; }

          const lastUser = [...messages].reverse().find((m) => m.role === "user");
          const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
          const lastPair = [lastUser, lastAssistant].filter(Boolean) as typeof messages;
          if (lastPair.length === 0) return;

          const userText = extractText(lastUser?.content);
          const assistantText = extractText(lastAssistant?.content);

          const noiseConfig = {
            noisePatterns: config.noisePatterns,
            bypassPatterns: config.bypassPatterns,
          };
          const filtered = config.noiseFilterEnabled
            ? lastPair.filter((m) => !isNoise(extractText(m.content), noiseConfig))
            : lastPair;

          if (filtered.length < lastPair.length) {
            api.logger.debug(`[agentcore] [capture] noise-filtered: ${lastPair.length} → ${filtered.length} messages`);
          }

          const userLen = userText.length;
          const totalLen = userText.length + assistantText.length;
          if (userLen < 20 || totalLen < config.autoCaptureMinLength) {
            api.logger.debug(`[agentcore] [capture] skipped: userLen=${userLen}, totalLen=${totalLen}, minLength=${config.autoCaptureMinLength}`);
            return;
          }

          const sessionId =
            ctx.sessionId
            ?? (ctx.sessionKey ? parseSessionIdFromSessionKey(ctx.sessionKey) : undefined);
          if (!sessionId) {
            api.logger.debug(`[agentcore] [capture] skipped: no sessionId available`);
            return;
          }

          api.logger.debug(
            `[agentcore] [capture] start: actorId=${actorId}, sessionId=${sessionId.slice(0, 8)}, totalMessages=${messages.length}, userLen=${userLen}, assistantLen=${assistantText.length}`,
          );
          for (const m of filtered) {
            const txt = extractText(m.content).replace(/\n/g, " ").slice(0, 150);
            api.logger.debug(`[agentcore] [capture]   ${m.role}: ${txt}...`);
          }

          await client!.createEvent({
            actorId,
            sessionId,
            messages: filtered.map((m: any) => ({
              role: m.role ?? "user",
              text: extractText(m.content),
            })),
          });

          api.logger.info(
            `[agentcore] [capture] done: captured ${filtered.length} messages (actorId=${actorId}, sessionId=${sessionId.slice(0, 8)}, userLen=${userLen}, assistantLen=${assistantText.length}), latencyMs=${Date.now() - captureStart}`,
          );
        } catch (err) {
          api.logger.warn(`[agentcore] [capture] error: ${err}`);
        }
      })();
    });
```

Key differences:
- Hook always registers (not wrapped in `if (config.autoCaptureEnabled)`)
- `actorId` resolved once at top, shared by file sync and capture
- File sync runs first, in its own try/catch
- Capture checks `config.autoCaptureEnabled` internally
- File sync block removed from inside capture
- `actorId` resolution removed from inside capture (uses shared one)

- [ ] **Step 2: Fix `agentcore-status` CLI to use new state format**

In `src/index.ts` (~line 416), find:
```ts
              `  Synced files: ${Object.keys(state.hashes).length}`,
```

Replace with:
```ts
              `  Synced files: ${Object.keys(state.files).length}`,
```

- [ ] **Step 3: Verify typecheck passes**

Run: `npm run typecheck`
Expected: **Will fail** — `agentcore-sync` CLI still calls `syncAll("cli-sync", "cli")` with old signature. Fixed in Task 3.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "refactor: decouple file sync from auto-capture in agent_end

File sync now runs independently before capture. Only needs actorId,
not sessionId. Capture skip (noise, min length, no session) no longer
blocks file sync. Fix agentcore-status to use new state format."
```

---

### Task 3: Update CLI `agentcore-sync` command

**Files:**
- Modify: `src/index.ts:646-659` (CLI agentcore-sync section)

Update the CLI to use the new `syncAll(actorId)` signature and add `--actor` option.

- [ ] **Step 1: Update CLI command**

Find this block in `src/index.ts` (~line 646):
```ts
        prog
          .command("agentcore-sync")
          .description("Manually trigger file sync")
          .action(async () => {
            if (!fileSync) {
              console.log("File sync is disabled.");
              return;
            }
            const count = await fileSync.syncAll(
              "cli-sync",
              "cli",
            );
            console.log(`Synced ${count} files.`);
          });
```

Replace with:
```ts
        prog
          .command("agentcore-sync")
          .description("Manually trigger file sync")
          .option("-a, --actor <id>", "Actor ID (default: default)", "default")
          .action(async (opts: unknown) => {
            if (!fileSync) {
              console.log("File sync is disabled.");
              return;
            }
            const o = opts as { actor: string };
            const count = await fileSync.syncAll(o.actor);
            console.log(`Synced ${count} files to /agents/${o.actor}.`);
          });
```

- [ ] **Step 2: Verify typecheck passes (first clean pass)**

Run: `npm run typecheck`
Expected: No errors. All consumers of `FileSync` now use the new `syncAll(actorId)` signature and `state.files` format.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: add --actor option to agentcore-sync CLI command

Drops sessionId from syncAll signature. CLI resolves actorId from
--actor option, defaulting to 'default'."
```

---

### Task 4: Final verification

- [ ] **Step 1: Full typecheck**

Run: `npm run typecheck`
Expected: Clean pass, zero errors.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: Clean compilation to `dist/`.

- [ ] **Step 3: Review changes**

Run: `git diff main --stat`
Expected: Only `src/file-sync.ts` and `src/index.ts` changed.

- [ ] **Step 4: Push**

```bash
git push --no-verify
```
