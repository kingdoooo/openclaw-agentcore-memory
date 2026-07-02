import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createRecallTool } from "./recall.js";
import { resolveConfig } from "../config.js";
import type { AgentCoreClient, SearchOptions } from "../client.js";
import type { MetadataConfig, PluginConfig } from "../config.js";

// A fake AgentCoreClient that records every SearchOptions handed to
// retrieveMemoryRecords so tests can assert exactly what the recall tool
// forwarded (filters included/omitted). No network I/O.
function makeCapturingClient() {
  const captured: SearchOptions[] = [];
  const client = {
    async retrieveMemoryRecords(options: SearchOptions) {
      captured.push(options);
      // Return a single deterministic record; dedup collapses the per-namespace
      // fan-out to one result.
      return [
        {
          memoryRecordId: "rec-1",
          content: "hello",
          memoryStrategyId: "SEMANTIC",
          namespaces: [options.namespace],
          score: 0.9,
          createdAt: new Date("2026-01-02T00:00:00Z"),
        },
      ];
    },
  };
  return { client: client as unknown as AgentCoreClient, captured };
}

// Build a PluginConfig off the resolved defaults (metadata disabled), overriding
// only the metadata block for the scenario under test.
function makeConfig(metadata: Partial<MetadataConfig>): PluginConfig {
  const base = resolveConfig({}, {});
  return { ...base, metadata: { ...base.metadata, ...metadata } };
}

async function runRecall(config: PluginConfig, params: Record<string, unknown>) {
  const { client, captured } = makeCapturingClient();
  const tool = createRecallTool(client, config, () => "bija");
  const result = await tool.execute("call-1", params);
  return { result, captured };
}

describe("agentcore_recall filter wiring", () => {
  it("enabled: user filters are built and forwarded to the client on every namespace", async () => {
    const config = makeConfig({
      enabled: true,
      indexedKeys: [{ key: "priority", type: "STRING" }],
    });
    const { captured } = await runRecall(config, {
      query: "billing question",
      filters: [{ key: "priority", operator: "EQUALS_TO", value: "high" }],
    });

    assert.ok(captured.length > 0, "client should be called at least once");
    for (const opts of captured) {
      assert.deepEqual(opts.metadataFilters, [
        {
          left: { metadataKey: "priority" },
          operator: "EQUALS_TO",
          right: { metadataValue: { stringValue: "high" } },
        },
      ]);
    }
  });

  it("enabled: created_after is forwarded as a createdAt AFTER timestamp filter", async () => {
    const config = makeConfig({ enabled: true });
    const { captured } = await runRecall(config, {
      query: "recent",
      created_after: "2026-01-01T00:00:00Z",
    });

    assert.ok(captured.length > 0);
    assert.deepEqual(captured[0].metadataFilters, [
      {
        left: { metadataKey: "x-amz-agentcore-memory-createdAt" },
        operator: "AFTER",
        right: { metadataValue: { dateTimeValue: "2026-01-01T00:00:00.000Z" } },
      },
    ]);
  });

  it("enabled: dropped filters are surfaced in details with reasons", async () => {
    const config = makeConfig({
      enabled: true,
      indexedKeys: [{ key: "priority", type: "STRING" }],
      dropUnindexedFilters: true,
    });
    const { result, captured } = await runRecall(config, {
      query: "q",
      filters: [{ key: "not_indexed_key", value: "x" }],
    });

    // The unindexed key is dropped, so no filter is forwarded...
    for (const opts of captured) {
      assert.equal(opts.metadataFilters, undefined);
    }
    // ...and the drop is surfaced (with its reason) in the tool details payload.
    const dropped = (result.details as { dropped?: Array<{ reason: string }> }).dropped;
    assert.ok(Array.isArray(dropped) && dropped.length === 1);
    assert.equal(dropped[0].reason, "key_not_indexed");
  });

  it("disabled: no filters are forwarded even when params supply them (result parity)", async () => {
    const config = makeConfig({ enabled: false });
    const { result, captured } = await runRecall(config, {
      query: "q",
      filters: [{ key: "priority", operator: "EQUALS_TO", value: "high" }],
      created_after: "2026-01-01T00:00:00Z",
    });

    assert.ok(captured.length > 0);
    for (const opts of captured) {
      assert.equal(opts.metadataFilters, undefined);
    }
    // Disabled mode never surfaces a dropped list.
    assert.equal((result.details as { dropped?: unknown }).dropped, undefined);
    assert.equal((result.details as { count: number }).count, 1);
  });
});
