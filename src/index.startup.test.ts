import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import plugin from "./index.js";
import { AgentCoreClient } from "./client.js";
import type { SearchOptions } from "./client.js";

/**
 * Task 9.2 — startup validation of indexed keys (read-only).
 *
 * These tests drive the real `agentcore-memory` service `start()` lifecycle in
 * `index.ts`. Only the AWS boundary is stubbed on the `AgentCoreClient`
 * prototype: the data-plane connection check (`listMemoryRecords`), the recall
 * path (`retrieveMemoryRecords`), and the read-only control-plane description
 * call (`describeMemoryIndexedKeys`).
 *
 * They assert:
 *  - a warning is logged for each configured indexed key missing from the
 *    provisioned memory (Requirement 13.2),
 *  - an invalid metadata config fails safe by disabling filtering at runtime
 *    (Requirement 12.7), and
 *  - NO provisioning/mutating command is ever issued (Requirement 13.4).
 *
 * _Requirements: 12.7, 13.2, 13.4_
 */

interface MockApi {
  pluginConfig: Record<string, unknown>;
  workspaceDir: string;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
  };
  on: (name: string, handler: Function) => void;
  registerTool: (tool: unknown) => void;
  registerService: (svc: any) => void;
  registerCli: (...args: unknown[]) => void;
  _hooks: Record<string, Function>;
  _services: any[];
  _logs: { info: string[]; warn: string[]; error: string[]; debug: string[] };
}

function makeMockApi(pluginConfig: Record<string, unknown>): MockApi {
  const hooks: Record<string, Function> = {};
  const services: any[] = [];
  const logs = { info: [] as string[], warn: [] as string[], error: [] as string[], debug: [] as string[] };
  const noop = () => {};
  return {
    pluginConfig,
    workspaceDir: "/tmp/openclaw-agentcore-startup-test",
    logger: {
      info: (...a: unknown[]) => logs.info.push(a.join(" ")),
      warn: (...a: unknown[]) => logs.warn.push(a.join(" ")),
      error: (...a: unknown[]) => logs.error.push(a.join(" ")),
      debug: (...a: unknown[]) => logs.debug.push(a.join(" ")),
    },
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
    _logs: logs,
  };
}

function basePluginConfig(metadata: Record<string, unknown>): Record<string, unknown> {
  return {
    memoryId: "mem-test-123",
    autoRecallTopK: 5,
    autoCaptureEnabled: false,
    noiseFilterEnabled: false,
    adaptiveRetrievalEnabled: false,
    fileSyncEnabled: false,
    metadata,
  };
}

// --- Prototype stubs capturing the AWS boundary ---
let describeCalls: number;
let describeReturn: string[] | null;
let retrieveCalls: SearchOptions[];
let origList: any;
let origRetrieve: any;
let origDescribe: any;

beforeEach(() => {
  describeCalls = 0;
  describeReturn = null;
  retrieveCalls = [];
  origList = AgentCoreClient.prototype.listMemoryRecords;
  origRetrieve = AgentCoreClient.prototype.retrieveMemoryRecords;
  origDescribe = AgentCoreClient.prototype.describeMemoryIndexedKeys;

  AgentCoreClient.prototype.listMemoryRecords = async () => ({ records: [] });
  AgentCoreClient.prototype.retrieveMemoryRecords = async function (opts: SearchOptions) {
    retrieveCalls.push(opts);
    return [];
  };
  AgentCoreClient.prototype.describeMemoryIndexedKeys = async function () {
    describeCalls++;
    return describeReturn;
  };
});

afterEach(() => {
  AgentCoreClient.prototype.listMemoryRecords = origList;
  AgentCoreClient.prototype.retrieveMemoryRecords = origRetrieve;
  AgentCoreClient.prototype.describeMemoryIndexedKeys = origDescribe;
});

describe("startup validation — indexed-key comparison (Req 13.2)", () => {
  it("logs a warning for each configured indexed key missing from the memory", async () => {
    const api = makeMockApi(
      basePluginConfig({
        enabled: true,
        indexedKeys: [
          { key: "agentId", type: "STRING" },
          { key: "userId", type: "STRING" },
          { key: "department", type: "STRING" },
        ],
        strictKeys: ["agentId"],
        defaultRecallFilters: [],
        dropUnindexedFilters: true,
        schemaByStrategy: {},
      }),
    );
    // Provisioned memory declares only two of the three configured keys.
    describeReturn = ["agentId", "userId"];

    plugin.register(api);
    await api._services[0].start();

    assert.equal(describeCalls, 1, "read-only description should be called once");
    const missingWarn = api._logs.warn.filter((w) => w.includes("department"));
    assert.equal(missingWarn.length, 1, "expected exactly one missing-key warning for 'department'");
    // No warning for keys that ARE present.
    assert.ok(!api._logs.warn.some((w) => w.includes('"agentId"') && w.includes("not declared")));
  });

  it("continues (no crash) and warns when the description is unavailable", async () => {
    const api = makeMockApi(
      basePluginConfig({
        enabled: true,
        indexedKeys: [{ key: "agentId", type: "STRING" }],
        strictKeys: [],
        defaultRecallFilters: [],
        dropUnindexedFilters: true,
        schemaByStrategy: {},
      }),
    );
    describeReturn = null; // control-plane unavailable / GetMemory failed

    plugin.register(api);
    await api._services[0].start();

    assert.equal(describeCalls, 1);
    assert.ok(
      api._logs.warn.some((w) => w.includes("could not read")),
      "expected a graceful-degradation warning",
    );
    // Startup still completed the data-plane connection check.
    assert.ok(api._logs.info.some((i) => i.includes("connection verified")));
  });
});

describe("startup validation — fail-safe on invalid config (Req 12.7)", () => {
  it("disables metadata filtering and skips the indexed-key comparison", async () => {
    const api = makeMockApi(
      basePluginConfig({
        enabled: true,
        // Invalid: strict key "missingKey" is not among the indexed keys.
        indexedKeys: [{ key: "agentId", type: "STRING" }],
        strictKeys: ["missingKey"],
        defaultRecallFilters: [
          { key: "agentId", operator: "EQUALS_TO", value: "bija" },
        ],
        dropUnindexedFilters: true,
        schemaByStrategy: {},
      }),
    );

    plugin.register(api);
    await api._services[0].start();

    // Fail-safe: enumerated errors logged, comparison skipped.
    assert.ok(
      api._logs.warn.some((w) => w.includes("invalid configuration")),
      "expected an invalid-config fail-safe warning",
    );
    assert.equal(describeCalls, 0, "indexed-key comparison must be skipped when config is invalid");

    // Runtime disable propagates to the auto-recall hook: no filters applied.
    await api._hooks["before_prompt_build"](
      { prompt: "what is my billing status" },
      { sessionKey: "agent:bija:direct:ou_alice", sessionId: "sess-1" },
    );
    assert.ok(retrieveCalls.length > 0, "expected recall calls");
    for (const call of retrieveCalls) {
      assert.equal(
        call.metadataFilters,
        undefined,
        "no metadata filters should be applied after fail-safe disable",
      );
    }
  });
});

describe("startup validation — never provisions (Req 13.4)", () => {
  it("uses only the read-only description and issues no create/update memory command", async () => {
    const api = makeMockApi(
      basePluginConfig({
        enabled: true,
        indexedKeys: [{ key: "agentId", type: "STRING" }],
        strictKeys: [],
        defaultRecallFilters: [],
        dropUnindexedFilters: true,
        schemaByStrategy: {},
      }),
    );
    describeReturn = ["agentId"];

    plugin.register(api);
    await api._services[0].start();

    assert.equal(describeCalls, 1, "read-only description used");
    // Structural guarantee: the client exposes no memory-provisioning methods.
    const proto = AgentCoreClient.prototype as unknown as Record<string, unknown>;
    assert.equal(typeof proto.createMemory, "undefined");
    assert.equal(typeof proto.updateMemory, "undefined");
    // All configured keys present → success log, no missing-key warnings.
    assert.ok(api._logs.info.some((i) => i.includes("configured indexed key(s) present")));
  });
});
