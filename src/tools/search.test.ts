import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createSearchTool } from "./search.js";
import { resolveConfig } from "../config.js";
import type { AgentCoreClient, ListRecordsOptions, MemoryRecordResult } from "../client.js";
import type { MetadataConfig, PluginConfig } from "../config.js";

// A fake AgentCoreClient that captures the ListRecordsOptions passed to
// listMemoryRecords (per namespace) so tests can assert exactly which filters
// the search tool forwards. Returns one canned record per call. No network I/O.
function makeCapturingClient() {
  const captured: ListRecordsOptions[] = [];
  const client = {
    async listMemoryRecords(options: ListRecordsOptions) {
      captured.push(options);
      const record: MemoryRecordResult = {
        memoryRecordId: `rec-${captured.length}`,
        content: "some stored content",
        memoryStrategyId: "SEMANTIC",
        namespaces: [options.namespace],
        createdAt: new Date("2026-01-02T00:00:00Z"),
      };
      return { records: [record], nextToken: undefined };
    },
  };
  return { client: client as unknown as AgentCoreClient, captured };
}

// Build a PluginConfig off the resolved defaults (metadata disabled), overriding
// only the metadata block for the scenario under test. Scopes are left empty so
// the actor can read its own resolved namespaces.
function makeConfig(metadata: Partial<MetadataConfig>): PluginConfig {
  const base = resolveConfig({}, {});
  return { ...base, metadata: { ...base.metadata, ...metadata } };
}

async function runSearch(config: PluginConfig, params: Record<string, unknown>) {
  const { client, captured } = makeCapturingClient();
  const tool = createSearchTool(client, config, () => "bija");
  const result = await tool.execute("call-1", params);
  return { result, captured };
}

describe("agentcore_search filter wiring", () => {
  it("enabled: valid filters are forwarded to the client on every namespace call", async () => {
    const config = makeConfig({
      enabled: true,
      indexedKeys: [{ key: "priority", type: "STRING" }],
    });

    const { captured } = await runSearch(config, {
      scope: "agent:bija",
      filters: [{ key: "priority", operator: "EQUALS_TO", value: "high" }],
    });

    assert.ok(captured.length > 0, "expected at least one namespace call");
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

  it("enabled: dropped filters are surfaced in details", async () => {
    const config = makeConfig({
      enabled: true,
      indexedKeys: [{ key: "priority", type: "STRING" }],
      dropUnindexedFilters: true,
    });

    const { result, captured } = await runSearch(config, {
      scope: "agent:bija",
      filters: [
        { key: "priority", operator: "EQUALS_TO", value: "high" },
        // Not an indexed key → dropped with reason key_not_indexed.
        { key: "unknown_key", operator: "EQUALS_TO", value: "x" },
      ],
    });

    const dropped = (result.details as { dropped?: Array<{ reason: string }> }).dropped;
    assert.ok(Array.isArray(dropped), "expected dropped filters in details");
    assert.equal(dropped!.length, 1);
    assert.equal(dropped![0].reason, "key_not_indexed");

    // Only the valid filter is forwarded to the client.
    for (const opts of captured) {
      assert.equal(opts.metadataFilters?.length, 1);
      assert.equal(opts.metadataFilters?.[0].left.metadataKey, "priority");
    }
  });

  it("disabled: no filters forwarded and no dropped surfaced (pre-feature result set)", async () => {
    const config = makeConfig({ enabled: false });

    const { result, captured } = await runSearch(config, {
      scope: "agent:bija",
      filters: [{ key: "priority", operator: "EQUALS_TO", value: "high" }],
    });

    assert.ok(captured.length > 0, "expected at least one namespace call");
    for (const opts of captured) {
      assert.equal(opts.metadataFilters, undefined);
    }
    assert.equal((result.details as { dropped?: unknown }).dropped, undefined);
    // Pre-feature result set is still returned (one record per namespace call).
    assert.ok((result.details as { count: number }).count > 0);
  });
});
