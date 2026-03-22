import { resolveConfig, type PluginConfig } from "./config.js";
import { AgentCoreClient } from "./client.js";
import {
  parseScope,
  scopeToNamespace,
  resolveAccessibleNamespaces,
  buildEpisodicNamespace,
  buildSessionNamespaces,
} from "./scopes.js";
import { parseAgentIdFromSessionKey, parseSessionIdFromSessionKey } from "./identity.js";
import { isNoise } from "./noise-filter.js";
import { shouldRetrieve } from "./adaptive-retrieval.js";
import { filterByScoreGap } from "./score-filter.js";
import { FileSync } from "./file-sync.js";
import { createRecallTool } from "./tools/recall.js";
import { createStoreTool } from "./tools/store.js";
import { createForgetTool } from "./tools/forget.js";
import { createCorrectTool } from "./tools/correct.js";
import { createSearchTool } from "./tools/search.js";
import { createStatsTool } from "./tools/stats.js";
import { createEpisodesTool } from "./tools/episodes.js";
import { createShareTool } from "./tools/share.js";
import type { MemoryRecordResult } from "./client.js";

/** Extract text from content that may be string or [{type,text}] array (OpenClaw format) */
function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part: any) => part?.type === "text" && typeof part?.text === "string")
      .map((part: any) => part.text)
      .join("\n");
  }
  return typeof content === "object" ? JSON.stringify(content) : String(content ?? "");
}

const NOT_READY_RESPONSE = {
  content: [
    {
      type: "text" as const,
      text: JSON.stringify({
        error: "AgentCore plugin not ready. Check config and connection.",
      }),
    },
  ],
  details: { error: "not_ready" },
};

let client: AgentCoreClient | null = null;
let fileSync: FileSync | null = null;
let ready = false;

const plugin = {
  id: "memory-agentcore",
  name: "AgentCore Memory",
  kind: "general" as const,

  register(api: any) {
    const raw = (api.pluginConfig ?? {}) as Record<string, unknown>;
    const config = resolveConfig(process.env, raw);

    // Global toggle
    if (!config.enabled) {
      api.logger.info("[agentcore] Plugin disabled via config");
      return;
    }

    if (!config.memoryId) {
      api.logger.warn(
        "[agentcore] No memoryId configured, plugin will not activate",
      );
      return;
    }

    // Initialize client
    client = new AgentCoreClient(config);

    const workspaceDir =
      api.workspaceDir ||
      process.env.OPENCLAW_WORKSPACE ||
      process.env.HOME + "/.openclaw/workspace";

    // Initialize file sync
    if (config.fileSyncEnabled) {
      fileSync = new FileSync(config, client, workspaceDir, api.logger);
    }

    // Register service lifecycle with startup validation
    api.registerService({
      id: "agentcore-memory",
      async start() {
        try {
          await client!.listMemoryRecords({
            namespace: "/global",
            maxResults: 1,
          });
          ready = true;
          api.logger.info(
            `[agentcore] Service started, connection verified (memory=${config.memoryId}, region=${config.awsRegion})`,
          );
        } catch (err) {
          ready = false;
          api.logger.error(
            `[agentcore] Startup validation failed: ${err}. Tools/hooks disabled, CLI still available.`,
          );
        }
      },
      async stop() {
        ready = false;
        client?.dispose();
        client = null;
        api.logger.info("[agentcore] Service stopped");
      },
    });

    // --- Register all 8 tools (direct objects per OpenClaw convention) ---

    const toolDefs = [
      createRecallTool(client, config),
      createStoreTool(client),
      createForgetTool(client),
      createCorrectTool(client),
      createSearchTool(client, config),
      createStatsTool(client, config),
      createEpisodesTool(client, config),
      createShareTool(client),
    ];

    for (const tool of toolDefs) {
      const originalExecute = tool.execute;
      api.registerTool({
        ...tool,
        async execute(toolCallId: string, params: Record<string, unknown>) {
          if (!client || !ready) return NOT_READY_RESPONSE;
          return originalExecute(toolCallId, params);
        },
      });
    }

    // --- Hook: Auto-Recall (before_prompt_build) ---
    if (config.autoRecallTopK > 0) {
      api.on("before_prompt_build", async (event: any, ctx: any) => {
        if (!client || !ready) return;

        try {
          const recallStart = Date.now();
          const promptStr = extractText(event.prompt).trim();
          if (!promptStr) return;

          // Adaptive retrieval gating
          if (config.adaptiveRetrievalEnabled) {
            const gate = shouldRetrieve(promptStr);
            if (!gate.shouldRetrieve) {
              api.logger.debug(
                `[agentcore] [recall] gated: reason="${gate.reason}"`,
              );
              return;
            }
          }

          // Resolve actor and namespaces
          const actorId = ctx.sessionKey
            ? parseAgentIdFromSessionKey(ctx.sessionKey)
            : "default";
          const namespaces = resolveAccessibleNamespaces(
            actorId,
            config.scopes,
            config.namespaceMode,
          );

          // Add current session's summary/episodic namespaces
          const sessionId = ctx.sessionId
            ?? (ctx.sessionKey ? parseSessionIdFromSessionKey(ctx.sessionKey) : undefined);
          if (sessionId) {
            const sessionNs = buildSessionNamespaces(actorId, sessionId, config.namespaceMode);
            for (const ns of sessionNs) namespaces.push(ns);
          }

          const sid = sessionId ? sessionId.slice(0, 8) : "none";
          api.logger.debug(
            `[agentcore] [recall] start: actorId=${actorId}, sessionId=${sid}, promptLen=${promptStr.length}, namespaces=${namespaces.length} [${namespaces.join(", ")}]`,
          );

          // Parallel search across all accessible namespaces
          const results = await Promise.allSettled(
            namespaces.map((ns) =>
              client!.retrieveMemoryRecords({
                query: promptStr,
                namespace: ns,
                topK: config.autoRecallTopK,
              }),
            ),
          );

          // Log per-namespace results
          let namespacesWithResults = 0;
          const allRecords: MemoryRecordResult[] = [];
          for (let i = 0; i < results.length; i++) {
            const r = results[i];
            const ns = namespaces[i];
            if (r.status === "fulfilled") {
              const count = r.value.length;
              if (count > 0) {
                namespacesWithResults++;
                const scores = r.value.map((v) => (v.score ?? 0).toFixed(3)).join(", ");
                api.logger.debug(`[agentcore] [recall] ns=${ns}: ${count} results (scores: ${scores})`);
                for (const v of r.value) {
                  const preview = v.content.replace(/\n/g, " ").slice(0, 120);
                  api.logger.debug(`[agentcore] [recall]   [${(v.score ?? 0).toFixed(3)}] strategy=${v.memoryStrategyId} ns=[${v.namespaces.join(",")}] → ${preview}...`);
                }
              } else {
                api.logger.debug(`[agentcore] [recall] ns=${ns}: 0 results`);
              }
              allRecords.push(...r.value);
            } else {
              api.logger.debug(`[agentcore] [recall] ns=${ns}: FAILED (${r.reason})`);
            }
          }

          if (allRecords.length === 0) {
            api.logger.info(
              `[agentcore] [recall] done: 0 records from ${namespaces.length} namespaces, skipped injection, latencyMs=${Date.now() - recallStart}`,
            );
            return;
          }

          // Sort by score, take top K, then apply score gap filter
          allRecords.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
          const topK = allRecords.slice(0, config.autoRecallTopK);
          const topRecords = filterByScoreGap(topK, config);

          api.logger.debug(
            `[agentcore] [recall] merged: ${allRecords.length} total → topK=${topK.length} → afterScoreGap=${topRecords.length}`,
          );

          // Format as XML block
          const lines: string[] = ["<agentcore_memory>"];
          for (const r of topRecords) {
            const attrs: string[] = [];
            if (config.showScores && r.score != null) {
              attrs.push(`score="${r.score.toFixed(3)}"`);
            }
            attrs.push(
              `date="${r.createdAt.toISOString().split("T")[0]}"`,
            );
            attrs.push(`strategy="${r.memoryStrategyId}"`);
            lines.push(`<memory ${attrs.join(" ")}>`);
            lines.push(r.content);
            lines.push("</memory>");
          }
          lines.push("</agentcore_memory>");

          const topScore = topRecords.length > 0 ? (topRecords[0].score ?? 0).toFixed(3) : "N/A";
          api.logger.info(
            `[agentcore] [recall] done: injected ${topRecords.length} records from ${namespaces.length} namespaces (${namespacesWithResults}/${namespaces.length} had results), topScore=${topScore}, latencyMs=${Date.now() - recallStart}`,
          );

          return { prependContext: lines.join("\n") };
        } catch (err) {
          api.logger.warn(`[agentcore] [recall] error: ${err}`);
          return;
        }
      });
    }

    // --- Hook: Auto-Capture (agent_end) - fire-and-forget ---
    if (config.autoCaptureEnabled) {
      api.on("agent_end", async (event: any, ctx: any) => {
        if (!client || !ready) {
          api.logger.debug(`[agentcore] [capture] skipped: reason="not ready" (client=${!!client}, ready=${ready})`);
          return;
        }
        if (!event.success) {
          api.logger.debug(`[agentcore] [capture] skipped: reason="event not successful"`);
          return;
        }

        void (async () => {
          try {
            const captureStart = Date.now();
            const messages = (event.messages ?? []) as Array<{ role?: string; content?: any }>;
            if (messages.length === 0) { api.logger.debug(`[agentcore] [capture] skipped: reason="no messages"`); return; }

            // Only capture last user+assistant pair (not full history)
            // AgentCore strategies handle extraction from each event
            const lastUser = [...messages].reverse().find((m) => m.role === "user");
            const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
            const lastPair = [lastUser, lastAssistant].filter(Boolean) as typeof messages;
            if (lastPair.length === 0) return;

            // Extract text content for length checks and noise filtering
            const userText = extractText(lastUser?.content);
            const assistantText = extractText(lastAssistant?.content);

            // Noise filter (use extracted text)
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

            // Min length check (use extracted text lengths)
            const userLen = userText.length;
            const totalLen = userText.length + assistantText.length;
            if (userLen < 20 || totalLen < config.autoCaptureMinLength) {
              api.logger.debug(`[agentcore] [capture] skipped: userLen=${userLen}, totalLen=${totalLen}, minLength=${config.autoCaptureMinLength}`);
              return;
            }

            const actorId = ctx.sessionKey
              ? parseAgentIdFromSessionKey(ctx.sessionKey)
              : "default";
            const sessionId =
              ctx.sessionId
              ?? (ctx.sessionKey ? parseSessionIdFromSessionKey(ctx.sessionKey) : undefined)
              ?? `session-${Date.now()}`;

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

            // File sync
            if (fileSync) {
              const synced = await fileSync.syncAll(
                sessionId,
                actorId,
              );
              if (synced > 0) {
                api.logger.debug(
                  `[agentcore] [capture] file-synced: ${synced} files`,
                );
              }
            }
          } catch (err) {
            api.logger.warn(`[agentcore] [capture] error: ${err}`);
          }
        })();
      });
    }

    // --- CLI commands ---
    api.registerCli(
      (cliCtx: any) => {
        const prog = cliCtx.program;

        prog
          .command("agentcore-status")
          .description("Connection check and config display")
          .action(async () => {
            console.log("AgentCore Memory Status");
            console.log(`  Memory ID: ${config.memoryId}`);
            console.log(`  Region:    ${config.awsRegion}`);
            console.log(
              `  Strategies: ${config.strategies.join(", ")}`,
            );
            console.log(
              `  Auto-recall: top ${config.autoRecallTopK}`,
            );
            console.log(
              `  Auto-capture: ${config.autoCaptureEnabled}`,
            );
            console.log(
              `  Noise filter: ${config.noiseFilterEnabled}`,
            );
            console.log(`  File sync: ${config.fileSyncEnabled}`);

            if (!client) {
              console.log("  Ready: false");
              console.log("  Connection: NOT INITIALIZED");
              return;
            }

            try {
              await client.listMemoryRecords({
                namespace: "/global",
                maxResults: 1,
              });
              ready = true;
              console.log("  Connection: OK");
            } catch (err) {
              ready = false;
              console.log(`  Connection: FAILED (${err})`);
            }

            console.log(`  Ready: ${ready}`);

            if (fileSync) {
              const state = fileSync.getState();
              console.log(
                `  Synced files: ${Object.keys(state.hashes).length}`,
              );
              if (state.lastSyncAt) {
                console.log(`  Last sync: ${state.lastSyncAt}`);
              }
            }
          });

        prog
          .command("agentcore-search <query>")
          .description("Semantic search with scores")
          .option(
            "-s, --scope <scope>",
            "Scope (default: global)",
            "global",
          )
          .option("-k, --top-k <n>", "Top K results", "5")
          .action(async (query: unknown, opts: unknown) => {
            if (!client) {
              console.error("Client not initialized.");
              return;
            }
            const q = (query as string).trim();
            if (!q) {
              console.error("Query must not be empty.");
              return;
            }
            const o = opts as { scope: string; topK: string };
            const namespace = scopeToNamespace(parseScope(o.scope));
            const records = await client.retrieveMemoryRecords({
              query: q,
              namespace,
              topK: Number(o.topK),
            });

            if (records.length === 0) {
              console.log("No records found.");
              return;
            }

            for (const r of records) {
              const score =
                r.score != null
                  ? ` (score: ${r.score.toFixed(3)})`
                  : "";
              console.log(`\n[${r.memoryRecordId}]${score}`);
              console.log(`  Strategy: ${r.memoryStrategyId}`);
              console.log(
                `  Date: ${r.createdAt.toISOString().split("T")[0]}`,
              );
              console.log(`  ${r.content.slice(0, 200)}`);
            }
          });

        prog
          .command("agentcore-list")
          .description("List/filter records")
          .option(
            "-s, --scope <scope>",
            "Scope (default: global)",
            "global",
          )
          .option("--strategy <strategy>", "Filter by strategy")
          .option("-n, --max <n>", "Max results", "20")
          .action(async (opts: unknown) => {
            if (!client) {
              console.error("Client not initialized.");
              return;
            }
            const o = opts as {
              scope: string;
              strategy?: string;
              max: string;
            };
            const namespace = scopeToNamespace(parseScope(o.scope));
            const result = await client.listMemoryRecords({
              namespace,
              strategyId: o.strategy,
              maxResults: Number(o.max),
            });

            if (result.records.length === 0) {
              console.log("No records found.");
              return;
            }

            for (const r of result.records) {
              console.log(
                `[${r.memoryRecordId}] ${r.memoryStrategyId} | ${r.createdAt.toISOString().split("T")[0]}`,
              );
              console.log(`  ${r.content.slice(0, 150)}`);
            }

            if (result.nextToken) {
              console.log("\n(more records available)");
            }
          });

        prog
          .command("agentcore-forget <id>")
          .description("Delete a specific record")
          .action(async (id: unknown) => {
            if (!client) {
              console.error("Client not initialized.");
              return;
            }
            await client.deleteMemoryRecord(id as string);
            console.log(`Deleted record: ${id}`);
          });

        prog
          .command("agentcore-purge <scope>")
          .description(
            "Purge ALL records in a scope. Irreversible! Requires --confirm.",
          )
          .option("--confirm", "Actually delete (dry-run without this)")
          .action(async (scope: unknown, opts: unknown) => {
            if (!client) {
              console.error("Client not initialized.");
              return;
            }
            const namespace = scopeToNamespace(
              parseScope(scope as string),
            );
            const o = opts as { confirm?: boolean };

            // List all records
            const allIds: string[] = [];
            let nextToken: string | undefined;
            do {
              const page = await client.listMemoryRecords({
                namespace,
                maxResults: 100,
                nextToken,
              });
              allIds.push(
                ...page.records.map((r) => r.memoryRecordId),
              );
              nextToken = page.nextToken;
            } while (nextToken);

            if (!o.confirm) {
              console.log(
                `[DRY RUN] Would delete ${allIds.length} records in ${namespace}`,
              );
              console.log("Add --confirm to actually delete.");
              return;
            }

            let deleted = 0;
            for (let i = 0; i < allIds.length; i += 25) {
              const chunk = allIds.slice(i, i + 25);
              await client.batchDeleteRecords(chunk);
              deleted += chunk.length;
            }
            console.log(
              `Purged ${deleted} records from ${namespace}`,
            );
          });

        prog
          .command("agentcore-episodes <query>")
          .description("Search episodic memory")
          .option("-k, --top-k <n>", "Top K results", "5")
          .option("--actor <actorId>", "Filter by actor ID")
          .action(async (query: unknown, opts: unknown) => {
            if (!client) {
              console.error("Client not initialized.");
              return;
            }
            const q = query as string;
            const o = opts as { topK: string; actor?: string };
            const namespace = buildEpisodicNamespace(o.actor, undefined, config.namespaceMode);
            const records = await client.retrieveMemoryRecords({
              query: q,
              namespace,
              topK: Number(o.topK),
              strategyId: "EPISODIC",
            });

            if (records.length === 0) {
              console.log("No episodes found.");
              return;
            }

            for (const r of records) {
              const score =
                r.score != null
                  ? ` (score: ${r.score.toFixed(3)})`
                  : "";
              console.log(`\n[${r.memoryRecordId}]${score}`);
              console.log(`  ${r.content.slice(0, 200)}`);
            }
          });

        prog
          .command("agentcore-stats")
          .description("Memory statistics")
          .option(
            "-s, --scope <scope>",
            "Scope (default: global)",
            "global",
          )
          .action(async (opts: unknown) => {
            if (!client) {
              console.error("Client not initialized.");
              return;
            }
            const o = opts as { scope: string };
            const namespace = scopeToNamespace(parseScope(o.scope));
            console.log(`Memory Stats for ${namespace}`);

            for (const strategy of config.strategies) {
              try {
                const result = await client.listMemoryRecords({
                  namespace,
                  strategyId: strategy,
                  maxResults: 1,
                });
                const indicator =
                  result.records.length > 0
                    ? "has records"
                    : "empty";
                console.log(`  ${strategy}: ${indicator}`);
              } catch {
                console.log(`  ${strategy}: error`);
              }
            }
          });

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

        prog
          .command("agentcore-remember <fact>")
          .description("Store a fact directly to AgentCore memory")
          .option(
            "-s, --scope <scope>",
            "Scope (default: global)",
            "global",
          )
          .option(
            "-c, --category <cat>",
            "Category (default: fact)",
            "fact",
          )
          .action(async (fact: unknown, opts: unknown) => {
            if (!client) {
              console.error("Client not initialized.");
              return;
            }
            const f = fact as string;
            const o = opts as { scope: string; category: string };
            const namespace = scopeToNamespace(parseScope(o.scope));
            try {
              const result = await client.batchCreateRecords([
                {
                  content: f,
                  namespaces: [namespace],
                  metadata: {
                    category: o.category,
                    source: "cli-remember",
                  },
                },
              ]);
              if (result.successful.length > 0) {
                console.log(`Stored: ${f}`);
              } else {
                console.log(
                  `Failed to store: ${result.failed.join(", ")}`,
                );
              }
            } catch (err) {
              console.error(`Error: ${err}`);
            }
          });
      },
      {
        commands: [
          "agentcore-status",
          "agentcore-search",
          "agentcore-list",
          "agentcore-forget",
          "agentcore-purge",
          "agentcore-episodes",
          "agentcore-stats",
          "agentcore-sync",
          "agentcore-remember",
        ],
      },
    );

    api.logger.info(
      `[agentcore] Plugin loaded (memory=${config.memoryId}, region=${config.awsRegion}, strategies=${config.strategies.join(",")})`,
    );
  },
};

export default plugin;
