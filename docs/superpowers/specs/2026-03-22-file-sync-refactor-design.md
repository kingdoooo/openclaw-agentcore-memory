# File Sync Refactor: createMemory + Independent Trigger

## Problem

File sync is coupled to auto-capture in the `agent_end` hook. Three issues:

1. **Trigger coupling** — capture skip (noise, min length, no sessionId) also skips file sync
2. **Wrong storage API** — `createEvent` stores files as conversational events, not persistent knowledge
3. **Namespace fragmentation** — each session's unique sessionId scatters the same file across multiple namespaces

## Design

### Storage API

Replace `createEvent` with `batchCreateRecords` (create) and `batchUpdateRecords` (update). Files become semantic memory records, searchable by auto-recall without session context.

### Namespace

Write to `/agents/{actorId}` — the same namespace used by `agentcore_store`. Distinguish file-synced records via `metadata.source: "file-sync"` and `metadata.file: "<filename>"`.

No sub-namespace (`/docs`). Auto-recall already searches `/agents/{actorId}`, so records are immediately retrievable.

### Sync State

```ts
// Before
{ hashes: Record<string, string> }

// After
{ files: Record<string, { hash: string; recordId: string }> }
```

Each file maps to one recordId (no chunking — whole file as single record).

### Sync Logic (`syncAll(actorId)`)

1. Resolve file list from `fileSyncPaths`
2. For each file in list:
   - **Exists + hash changed + has recordId** → `batchUpdateRecords` (without namespaces param, preserves original)
   - **Exists + hash changed + no recordId** (new file or state lost) → `batchCreateRecords`
   - **Exists + hash same** → skip
3. For each file in state but not on disk → `batchDeleteRecords`, remove from state
4. Save updated state

Note: cleanup of deleted files only runs on next `agent_end` trigger. If a file is deleted but no conversation happens, the stale record persists until the next agent interaction.

### State Loss Fallback

When a file has changed but has no recordId in state (state file deleted/corrupted, or first sync after migration), create a new record. No attempt to find existing records via listing — state loss is exceptional, and a brief duplicate is acceptable.

### Trigger: agent_end Hook

```
agent_end handler:
  1. file sync (independent, needs only actorId)
       fileSync.syncAll(actorId)

  2. capture (existing logic, needs sessionId)
       if autoCaptureEnabled && sessionId:
         noise filter -> min length -> createEvent
```

File sync runs first, independent of capture. Only requires `actorId` (from `ctx.sessionKey` or `"default"`). The `actorId: "default"` case is not skipped — writes to `/agents/default`.

### CLI

`agentcore-sync` command calls `fileSync.syncAll(actorId)`. Signature drops `sessionId` parameter. Same code path as the hook.

### No Chunking

`CHUNK_SIZE` constant and `chunkContent()` method are removed. Each file is stored as a single record regardless of size.

## Files Changed

- `src/file-sync.ts` — rewrite sync logic to use `batchCreateRecords`/`batchUpdateRecords`/`batchDeleteRecords`, new state format, remove chunking
- `src/index.ts` — decouple file sync from capture in `agent_end` hook, update CLI `agentcore-sync` call signature

## Migration

Existing `.agentcore-sync.json` files with old format (`{ hashes }`) are handled gracefully — treated as empty state, triggering fresh creates for all files on next sync.
