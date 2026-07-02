import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import plugin from "./index.js";
import { AgentCoreClient } from "./client.js";
import type { EventInput, SearchOptions } from "./client.js";

/**
 * Task 8.3 — hook metadata/filter wiring tests.
 *
 * These tests exercise the real auto-capture (`agent_end`) and auto-recall
 * (`before_prompt_build`) hook logic wired in `index.ts`. Only the AWS network
 * boundary (the `AgentCoreClient` methods that call the SDK) is stubbed via the
 * prototype so the tests validate the plugin's own strict-key mapping and
 * default-filter construction without hitting AWS.
 *
 * _Requirements: 3.1, 3.2, 4.1_
 */

interface MockApi {
  pluginConfig: Record<string, unknown>;
  workspaceDir: string;
  logger: Record<string, (...args: unknown[]) => void>;
  on: (name: string, handler: Function) => void;
  registerTool: (tool: unknown) => void;
  registerService: (svc: any) => void;
  registerCli: (...args: unknown[]) => void;
  _hooks: Record<string, Function>;
  _services: any[];
}

function makeMockApi(pluginConfig: Record<string, unknown>): MockApi {
  const hooks: Record<string, Function> = {};
  const services: any[] = [];
  const noop = () => {};
  return {
    pluginConfig,
    workspaceDir: "/tmp/openclaw-agentcore-test",
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    on(name: string, handler: Function) {
      hooks[name] = handler;
    },
    registerTool: noop,
    registerService(svc: any) {
      services.push(svc);
    },
    registerCli: noop,
    _hooks: hooks,
    _services: services,
  };
}

const SESSION_KEY = "agent:bija:direct:ou_alice";
const CTX = { sessionKey: SESSION_KEY, sessionId: "sess-1" };

function metadataConfig(enabled: boolean) {
  return {
    enabled,
    indexedKeys: [
      { key: "agentId", type: "STRING" },
      { key: "userId", type: "STRING" },
      { key: "sessionId", type: "STRING" },
    ],
    strictKeys: ["agentId", "userId", "sessionId"],
    defaultRecallFilters: [
      { key: "agentId", operator: "EQUALS_TO", value: "bija" },
    ],
    dropUnindexedFilters: true,
    schemaByStrategy: {},
  };
}

function basePluginConfig(enabled: boolean): Record<string, unknown> {
  return {
    memoryId: "mem-test-123",
    autoRecallTopK: 5,
    autoCaptureEnabled: true,
    autoCaptureMinLength: 1,
    noiseFilterEnabled: false,
    adaptiveRetrievalEnabled: false,
    fileSyncEnabled: false,
    metadata: metadataConfig(enabled),
  };
}

// --- Prototype stubs capturing the AWS network boundary ---
let retrieveCalls: SearchOptions[] = [];
let createCalls: EventInput[] = [];
let origList: any;
let origRetrieve: any;
let origCreate: any;
let origDescribe: any;

beforeEach(() => {
  retrieveCalls = [];
  createCalls = [];
  origList = AgentCoreClient.prototype.listMemoryRecords;
  origRetrieve = AgentCoreClient.prototype.retrieveMemoryRecords;
  origCreate = AgentCoreClient.prototype.createEvent;
  origDescribe = AgentCoreClient.prototype.describeMemoryIndexedKeys;

  AgentCoreClient.prototype.listMemoryRecords = async () => ({ records: [] });
  AgentCoreClient.prototype.retrieveMemoryRecords = async function (opts: SearchOptions) {
    retrieveCalls.push(opts);
    return [];
  };
  AgentCoreClient.prototype.createEvent = async function (input: EventInput) {
    createCalls.push(input);
    return "evt-1";
  };
  // Stub the read-only control-plane description used by startup validation so
  // these hook-focused tests never touch the network. All configured indexed
  // keys are reported present, so startup validation is a clean no-op.
  AgentCoreClient.prototype.describeMemoryIndexedKeys = async () => [
    "agentId",
    "userId",
    "sessionId",
  ];
});

afterEach(() => {
  AgentCoreClient.prototype.listMemoryRecords = origList;
  AgentCoreClient.prototype.retrieveMemoryRecords = origRetrieve;
  AgentCoreClient.prototype.createEvent = origCreate;
  AgentCoreClient.prototype.describeMemoryIndexedKeys = origDescribe;
});

async function registerAndStart(enabled: boolean): Promise<MockApi> {
  const api = makeMockApi(basePluginConfig(enabled));
  plugin.register(api);
  // Drive the service lifecycle so `ready` becomes true.
  await api._services[0].start();
  return api;
}

// Allow the fire-and-forget auto-capture closure to complete.
const flush = () => new Promise((r) => setTimeout(r, 50));

describe("auto-recall hook — default metadata filters (Req 4.1)", () => {
  it("applies configured defaultRecallFilters to fanned-out recall calls when enabled", async () => {
    const api = await registerAndStart(true);
    await api._hooks["before_prompt_build"](
      { prompt: "what is my billing status" },
      CTX,
    );

    assert.ok(retrieveCalls.length > 0, "expected at least one recall call");
    for (const call of retrieveCalls) {
      assert.ok(call.metadataFilters, "metadataFilters should be present");
      assert.equal(call.metadataFilters!.length, 1);
      assert.equal(call.metadataFilters![0].left.metadataKey, "agentId");
      assert.equal(call.metadataFilters![0].operator, "EQUALS_TO");
    }
  });

  it("passes no metadataFilters when disabled (unchanged behavior)", async () => {
    const api = await registerAndStart(false);
    await api._hooks["before_prompt_build"](
      { prompt: "what is my billing status" },
      CTX,
    );

    assert.ok(retrieveCalls.length > 0, "expected at least one recall call");
    for (const call of retrieveCalls) {
      assert.equal(
        call.metadataFilters,
        undefined,
        "metadataFilters should be absent when disabled",
      );
    }
  });
});

describe("auto-capture hook — strict-key metadata (Req 3.1, 3.2)", () => {
  const messages = [
    { role: "user", content: "Hello there, this is a sufficiently long user message." },
    { role: "assistant", content: "Hi, here is a sufficiently long assistant reply." },
  ];

  it("attaches configured strictKeys mapped to runtime identity values when enabled", async () => {
    const api = await registerAndStart(true);
    await api._hooks["agent_end"]({ success: true, messages }, CTX);
    await flush();

    assert.equal(createCalls.length, 1, "expected exactly one createEvent call");
    const meta = createCalls[0].metadata ?? {};
    // agentId -> "bija", userId -> peerId "ou_alice", sessionId -> "sess-1"
    assert.equal(meta.agentId, "bija");
    assert.equal(meta.userId, "ou_alice");
    assert.equal(meta.sessionId, "sess-1");
  });

  it("attaches only today's metadata (userId/agentId) when disabled", async () => {
    const api = await registerAndStart(false);
    await api._hooks["agent_end"]({ success: true, messages }, CTX);
    await flush();

    assert.equal(createCalls.length, 1, "expected exactly one createEvent call");
    const meta = createCalls[0].metadata ?? {};
    assert.deepEqual(meta, { userId: "ou_alice", agentId: "bija" });
  });
});
