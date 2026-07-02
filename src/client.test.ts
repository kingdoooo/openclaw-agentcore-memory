import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { AgentCoreClient } from "./client.js";
import type { PluginConfig } from "./config.js";
import type { MetadataFilter } from "./metadata-filter.js";

// A minimal PluginConfig sufficient for AgentCoreClient construction. The SDK
// `send` is stubbed below, so no network / credentials are ever exercised.
function makeConfig(): PluginConfig {
  return {
    memoryId: "mem-test",
    statsCacheTtlMs: 60_000,
    awsRegion: "us-east-1",
    awsProfile: undefined,
    maxRetries: 1,
    timeoutMs: 1000,
  } as unknown as PluginConfig;
}

interface CapturedCommand {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: any;
}

// Build a client whose underlying SDK `send` is replaced by a spy that records
// each command's constructor name + `.input` and returns an empty result.
function makeClientWithSpy(): { client: AgentCoreClient; sent: CapturedCommand[] } {
  const client = new AgentCoreClient(makeConfig());
  const sent: CapturedCommand[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).client.send = async (command: any) => {
    sent.push({ name: command.constructor.name, input: command.input });
    return { memoryRecordSummaries: [], nextToken: undefined };
  };
  return { client, sent };
}

const SAMPLE_FILTERS: MetadataFilter[] = [
  {
    left: { metadataKey: "priority" },
    operator: "EQUALS_TO",
    right: { metadataValue: { stringValue: "high" } },
  },
];

describe("AgentCoreClient.retrieveMemoryRecords metadataFilters emission", () => {
  let ctx: ReturnType<typeof makeClientWithSpy>;
  beforeEach(() => {
    ctx = makeClientWithSpy();
  });

  it("attaches metadataFilters under searchCriteria when non-empty", async () => {
    await ctx.client.retrieveMemoryRecords({
      query: "q",
      namespace: "/semantic/a",
      metadataFilters: SAMPLE_FILTERS,
    });
    assert.equal(ctx.sent.length, 1);
    assert.equal(ctx.sent[0].name, "RetrieveMemoryRecordsCommand");
    assert.deepEqual(ctx.sent[0].input.searchCriteria.metadataFilters, SAMPLE_FILTERS);
  });

  it("omits metadataFilters when absent (byte-identical to pre-feature command)", async () => {
    await ctx.client.retrieveMemoryRecords({ query: "q", namespace: "/semantic/a" });
    const input = ctx.sent[0].input;
    assert.ok(!("metadataFilters" in input.searchCriteria));
    // Byte-identical assertion: command matches the exact pre-feature shape.
    assert.equal(
      JSON.stringify(input),
      JSON.stringify({
        memoryId: "mem-test",
        namespace: "/semantic/a",
        searchCriteria: { searchQuery: "q" },
      }),
    );
  });

  it("omits metadataFilters when given an empty array (byte-identical)", async () => {
    const empty = makeClientWithSpy();
    await empty.client.retrieveMemoryRecords({
      query: "q",
      namespace: "/semantic/a",
      metadataFilters: [],
    });
    await ctx.client.retrieveMemoryRecords({ query: "q", namespace: "/semantic/a" });
    assert.ok(!("metadataFilters" in empty.sent[0].input.searchCriteria));
    assert.equal(
      JSON.stringify(empty.sent[0].input),
      JSON.stringify(ctx.sent[0].input),
    );
  });
});

describe("AgentCoreClient.listMemoryRecords metadataFilters emission", () => {
  let ctx: ReturnType<typeof makeClientWithSpy>;
  beforeEach(() => {
    ctx = makeClientWithSpy();
  });

  it("attaches top-level metadataFilters when non-empty", async () => {
    await ctx.client.listMemoryRecords({
      namespace: "/users/a",
      metadataFilters: SAMPLE_FILTERS,
    });
    assert.equal(ctx.sent.length, 1);
    assert.equal(ctx.sent[0].name, "ListMemoryRecordsCommand");
    assert.deepEqual(ctx.sent[0].input.metadataFilters, SAMPLE_FILTERS);
  });

  it("preserves nextToken pagination alongside filters", async () => {
    await ctx.client.listMemoryRecords({
      namespace: "/users/a",
      nextToken: "tok-1",
      maxResults: 20,
      metadataFilters: SAMPLE_FILTERS,
    });
    const input = ctx.sent[0].input;
    assert.equal(input.nextToken, "tok-1");
    assert.equal(input.maxResults, 20);
    assert.deepEqual(input.metadataFilters, SAMPLE_FILTERS);
  });

  it("omits metadataFilters when absent (byte-identical to pre-feature command)", async () => {
    await ctx.client.listMemoryRecords({ namespace: "/users/a" });
    const input = ctx.sent[0].input;
    assert.ok(!("metadataFilters" in input));
    assert.equal(
      JSON.stringify(input),
      JSON.stringify({ memoryId: "mem-test", namespace: "/users/a" }),
    );
  });

  it("omits metadataFilters when given an empty array (byte-identical)", async () => {
    const empty = makeClientWithSpy();
    await empty.client.listMemoryRecords({ namespace: "/users/a", metadataFilters: [] });
    await ctx.client.listMemoryRecords({ namespace: "/users/a" });
    assert.ok(!("metadataFilters" in empty.sent[0].input));
    assert.equal(
      JSON.stringify(empty.sent[0].input),
      JSON.stringify(ctx.sent[0].input),
    );
  });
});
