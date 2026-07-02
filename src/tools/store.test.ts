import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createStoreTool } from "./store.js";
import { resolveConfig } from "../config.js";
import type { AgentCoreClient } from "../client.js";
import type { MetadataConfig, PluginConfig } from "../config.js";

// A fake AgentCoreClient that captures the metadata handed to batchCreateRecords
// so tests can assert exactly what the store tool would persist. No network I/O.
function makeCapturingClient() {
  const captured: Array<Record<string, string>> = [];
  const client = {
    async batchCreateRecords(
      records: Array<{ content: string; namespaces: string[]; metadata?: Record<string, string> }>,
    ) {
      captured.push(records[0]?.metadata ?? {});
      return { successful: ["rec-1"], failed: [] as string[] };
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

async function runStore(
  config: PluginConfig,
  params: Record<string, unknown>,
) {
  const { client, captured } = makeCapturingClient();
  const tool = createStoreTool(client, config, () => "bija");
  const result = await tool.execute("call-1", params);
  return { result, metadata: captured[0], captured };
}

describe("agentcore_store metadata merging", () => {
  it("disabled: base metadata is unchanged and user/strict metadata is ignored", async () => {
    const config = makeConfig({ enabled: false });
    const { metadata } = await runStore(config, {
      content: "hello world",
      category: "fact",
      importance: 0.7,
      tags: ["a", "b"],
      metadata: { priority: "high" },
      strictMetadata: { department: "billing" },
    });

    assert.deepEqual(metadata, {
      category: "fact",
      importance: "0.7",
      scope: "global",
      source: "manual",
      tags: JSON.stringify(["a", "b"]),
    });
    // The exact deepEqual above already proves user/strict keys (priority,
    // department) did not leak through when the feature is off.
  });

  it("enabled with no extra metadata: base metadata parity with disabled mode", async () => {
    const enabled = makeConfig({
      enabled: true,
      indexedKeys: [{ key: "priority", type: "STRING" }],
    });
    const disabled = makeConfig({ enabled: false });

    const params = {
      content: "hello world",
      category: "decision",
      importance: 0.5,
      tags: ["x"],
    };

    const enabledRun = await runStore(enabled, { ...params });
    const disabledRun = await runStore(disabled, { ...params });

    assert.deepEqual(enabledRun.metadata, disabledRun.metadata);
  });

  it("enabled: strict-key value passes through verbatim", async () => {
    const config = makeConfig({
      enabled: true,
      indexedKeys: [{ key: "department", type: "STRING" }],
      strictKeys: ["department"],
    });
    const { metadata } = await runStore(config, {
      content: "route this ticket",
      strictMetadata: { department: "billing" },
    });

    assert.equal(metadata.department, "billing");
    // Base keys are still present.
    assert.equal(metadata.category, "other");
    assert.equal(metadata.source, "manual");
  });

  it("enabled: unknown free-metadata key is dropped, known key retained", async () => {
    const config = makeConfig({
      enabled: true,
      indexedKeys: [{ key: "priority", type: "STRING" }],
    });
    const { metadata } = await runStore(config, {
      content: "note",
      metadata: { priority: "high", mystery: "value" },
    });

    assert.equal(metadata.priority, "high");
    assert.equal(metadata.mystery, undefined);
  });

  it("enabled: value rejected by allowedValues is dropped while other keys are stored", async () => {
    const config = makeConfig({
      enabled: true,
      indexedKeys: [
        { key: "priority", type: "STRING" },
        { key: "channel", type: "STRING" },
      ],
      schemaByStrategy: {
        SEMANTIC: [
          { key: "priority", type: "STRING", allowedValues: ["low", "high"] },
        ],
      },
    });
    const { result, metadata } = await runStore(config, {
      content: "note",
      metadata: { priority: "bogus", channel: "email" },
    });

    // Invalid allowedValues member dropped, but the store still succeeds and
    // retains the other valid key (Requirement 16.2).
    assert.equal(metadata.priority, undefined);
    assert.equal(metadata.channel, "email");
    assert.equal(result.details.stored, true);
  });
});
