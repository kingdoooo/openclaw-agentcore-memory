import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildEpisodicNamespace,
  buildSessionNamespaces,
  buildStrategyNamespaces,
  resolveAccessibleNamespaces,
  scopeToSearchNamespaces,
  parseScope,
  scopeToNamespace,
} from "./scopes.js";

describe("parseScope", () => {
  it("parses global", () => {
    assert.deepEqual(parseScope("global"), { kind: "global" });
  });
  it("parses agent scope", () => {
    assert.deepEqual(parseScope("agent:bija"), { kind: "agent", id: "bija" });
  });
  it("parses project scope", () => {
    assert.deepEqual(parseScope("project:ecommerce"), { kind: "project", id: "ecommerce" });
  });
  it("falls back to global for unknown kind", () => {
    assert.deepEqual(parseScope("unknown:foo"), { kind: "global" });
  });
  it("falls back to global for no colon", () => {
    assert.deepEqual(parseScope("something"), { kind: "global" });
  });
});

describe("scopeToNamespace", () => {
  it("global", () => {
    assert.equal(scopeToNamespace({ kind: "global" }), "/global");
  });
  it("agent", () => {
    assert.equal(scopeToNamespace({ kind: "agent", id: "bija" }), "/agents/bija");
  });
  it("project", () => {
    assert.equal(scopeToNamespace({ kind: "project", id: "dash" }), "/projects/dash");
  });
  it("user", () => {
    assert.equal(scopeToNamespace({ kind: "user", id: "alice" }), "/users/alice");
  });
  it("custom", () => {
    assert.equal(scopeToNamespace({ kind: "custom", id: "team-x" }), "/custom/team-x");
  });
});

describe("buildStrategyNamespaces", () => {
  it("per-agent mode", () => {
    const ns = buildStrategyNamespaces("bija", "per-agent");
    assert.deepEqual(ns, ["/semantic/bija", "/episodic/bija", "/preferences/bija", "/summary/bija"]);
  });
  it("shared mode", () => {
    const ns = buildStrategyNamespaces("bija", "shared");
    assert.deepEqual(ns, ["/semantic", "/episodic", "/preferences", "/summary"]);
  });
});

describe("buildEpisodicNamespace", () => {
  it("per-agent with actor+session", () => {
    assert.equal(buildEpisodicNamespace("bija", "s1", "per-agent"), "/episodic/bija/s1");
  });
  it("per-agent with actor only", () => {
    assert.equal(buildEpisodicNamespace("bija", undefined, "per-agent"), "/episodic/bija");
  });
  it("per-agent no args", () => {
    assert.equal(buildEpisodicNamespace(undefined, undefined, "per-agent"), "/episodic");
  });
  it("shared with actor+session", () => {
    assert.equal(buildEpisodicNamespace("bija", "s1", "shared"), "/episodic/s1");
  });
  it("shared no args", () => {
    assert.equal(buildEpisodicNamespace(undefined, undefined, "shared"), "/episodic");
  });
  it("defaults to per-agent when mode omitted", () => {
    assert.equal(buildEpisodicNamespace("bija", "s1"), "/episodic/bija/s1");
  });
  it("sanitizes special chars", () => {
    assert.equal(buildEpisodicNamespace("bot/a", "s:1", "per-agent"), "/episodic/bot_a/s_1");
  });
});

describe("buildSessionNamespaces", () => {
  it("per-agent mode", () => {
    assert.deepEqual(
      buildSessionNamespaces("bija", "s1", "per-agent"),
      ["/summary/bija/s1", "/episodic/bija/s1"],
    );
  });
  it("shared mode", () => {
    assert.deepEqual(
      buildSessionNamespaces("bija", "s1", "shared"),
      ["/summary/s1", "/episodic/s1"],
    );
  });
  it("sanitizes special chars", () => {
    assert.deepEqual(
      buildSessionNamespaces("bot/a", "s:1", "per-agent"),
      ["/summary/bot_a/s_1", "/episodic/bot_a/s_1"],
    );
  });
});

describe("scopeToSearchNamespaces", () => {
  it("global returns only primary", () => {
    assert.deepEqual(scopeToSearchNamespaces({ kind: "global" }, "per-agent"), ["/global"]);
  });
  it("agent scope expands to include strategies", () => {
    const ns = scopeToSearchNamespaces({ kind: "agent", id: "bija" }, "per-agent");
    assert.ok(ns.includes("/agents/bija"));
    assert.ok(ns.includes("/semantic/bija"));
    assert.ok(ns.includes("/episodic/bija"));
    assert.ok(ns.includes("/preferences/bija"));
    assert.ok(ns.includes("/summary/bija"));
  });
  it("project scope does not expand", () => {
    assert.deepEqual(
      scopeToSearchNamespaces({ kind: "project", id: "dash" }, "per-agent"),
      ["/projects/dash"],
    );
  });
});

describe("resolveAccessibleNamespaces", () => {
  const emptyCfg = { agentAccess: {}, writeAccess: {} };

  it("always includes /global and agent primary", () => {
    const ns = resolveAccessibleNamespaces("bija", emptyCfg, "per-agent");
    assert.ok(ns.includes("/global"));
    assert.ok(ns.includes("/agents/bija"));
  });

  it("includes strategy namespaces in per-agent mode", () => {
    const ns = resolveAccessibleNamespaces("bija", emptyCfg, "per-agent");
    assert.ok(ns.includes("/semantic/bija"));
    assert.ok(ns.includes("/episodic/bija"));
    assert.ok(ns.includes("/preferences/bija"));
    assert.ok(ns.includes("/summary/bija"));
  });

  it("shared mode uses flat strategy paths", () => {
    const ns = resolveAccessibleNamespaces("bija", emptyCfg, "shared");
    assert.ok(ns.includes("/semantic"));
    assert.ok(ns.includes("/episodic"));
  });

  it("cross-agent access expands strategy namespaces", () => {
    const cfg = { agentAccess: { bija: ["agent:sales"] }, writeAccess: {} };
    const ns = resolveAccessibleNamespaces("bija", cfg, "per-agent");
    assert.ok(ns.includes("/agents/sales"));
    assert.ok(ns.includes("/semantic/sales"));
    assert.ok(ns.includes("/episodic/sales"));
    assert.ok(ns.includes("/preferences/sales"));
    assert.ok(ns.includes("/summary/sales"));
  });

  it("deduplicates namespaces", () => {
    const cfg = { agentAccess: { bija: ["agent:bija"] }, writeAccess: {} };
    const ns = resolveAccessibleNamespaces("bija", cfg, "per-agent");
    const dupes = ns.filter((v, i) => ns.indexOf(v) !== i);
    assert.equal(dupes.length, 0);
  });
});
