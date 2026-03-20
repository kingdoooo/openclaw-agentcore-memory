import { resolveConfig, type PluginConfig } from "./config.js";
import { AgentCoreClient } from "./client.js";
import {
  parseScope,
  scopeToNamespace,
  resolveAccessibleNamespaces,
  buildEpisodicNamespace,
} from "./scopes.js";
import { parseAgentIdFromSessionKey } from "./identity.js";
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
      createSearchTool(client),
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

    // --- Hook: Auto-Recall (before_agent_start) ---
    if (config.autoRecallTopK > 0) {
      api.on("before_agent_start", async (event: any) => {
        if (!client || !ready) return;

        try {
          const prompt =
            event.prompt ??
            event.messages?.[event.messages.length - 1]?.content ??
            "";
          const promptStr =
            typeof prompt === "string" ? prompt : String(prompt);
          if (!promptStr.trim()) return;

          // Adaptive retrieval gating
          if (config.adaptiveRetrievalEnabled) {
            const gate = shouldRetrieve(promptStr);
            if (!gate.shouldRetrieve) {
              api.logger.debug(
                `[agentcore] Auto-recall skipped: ${gate.reason}`,
              );
              return;
            }
          }

          // Resolve actor and namespaces
          const actorId = event.sessionKey
            ? parseAgentIdFromSessionKey(event.sessionKey)
            : "default";
          const namespaces = resolveAccessibleNamespaces(
            actorId,
            config.scopes,
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

          const allRecords = results
            .filter(
              (r): r is PromiseFulfilledResult<MemoryRecordResult[]> =>
                r.status === "fulfilled",
            )
            .flatMap((r) => r.value);

          if (allRecords.length === 0) return;

          // Sort by score, take top K, then apply score gap filter
          allRecords.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
          const topK = allRecords.slice(0, config.autoRecallTopK);
          const topRecords = filterByScoreGap(topK, config);

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

          return { prependContext: lines.join("\n") };
        } catch (err) {
          api.logger.warn(`[agentcore] Auto-recall error: ${err}`);
          return;
        }
      });
    }

    // --- Hook: Auto-Capture (agent_end) - fire-and-forget ---
    if (config.autoCaptureEnabled) {
      api.on("agent_end", async (event: any) => {
        if (!client || !ready) return;
        if (!event.success) return;

        void (async () => {
          try {
            const messages = (event.messages ?? []) as Array<{ role?: string; content?: string }>;
            if (messages.length === 0) return;

            // Only capture last user+assistant pair (not full history)
            // AgentCore strategies handle extraction from each event
            const lastUser = [...messages].reverse().find((m) => m.role === "user");
            const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
            const lastPair = [lastUser, lastAssistant].filter(Boolean) as typeof messages;
            if (lastPair.length === 0) return;

            // Noise filter
            const noiseConfig = {
              noisePatterns: config.noisePatterns,
              bypassPatterns: config.bypassPatterns,
            };
            const filtered = config.noiseFilterEnabled
              ? lastPair.filter((m) => !isNoise(m.content ?? "", noiseConfig))
              : lastPair;

            // Min length check
            const userLen = lastUser?.content?.length ?? 0;
            const totalLen = lastPair.reduce(
              (sum, m) => sum + (m.content?.length ?? 0),
              0,
            );
            if (userLen < 20 || totalLen < config.autoCaptureMinLength) return;

            const actorId = event.sessionKey
              ? parseAgentIdFromSessionKey(event.sessionKey)
              : "default";
            const sessionId =
              event.sessionId ?? `session-${Date.now()}`;

            await client!.createEvent({
              actorId,
              sessionId,
              messages: filtered.map((m: any) => ({
                role: m.role ?? "user",
                text:
                  typeof m.content === "string"
                    ? m.content
                    : JSON.stringify(m.content),
              })),
            });

            api.logger.debug(
              `[agentcore] Auto-captured ${filtered.length} messages`,
            );

            // File sync
            if (fileSync) {
              const synced = await fileSync.syncAll(
                sessionId,
                actorId,
              );
              if (synced > 0) {
                api.logger.debug(
                  `[agentcore] File-synced ${synced} files`,
                );
              }
            }
          } catch (err) {
            api.logger.warn(`[agentcore] Auto-capture error: ${err}`);
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
            console.log(`  Ready: ${ready}`);

            if (!client) {
              console.log("  Connection: NOT INITIALIZED");
              return;
            }

            try {
              await client.listMemoryRecords({
                namespace: "/global",
                maxResults: 1,
              });
              console.log("  Connection: OK");
            } catch (err) {
              console.log(`  Connection: FAILED (${err})`);
            }

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
            const namespace = buildEpisodicNamespace(o.actor);
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
