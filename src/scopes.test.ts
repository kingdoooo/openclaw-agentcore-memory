import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildEpisodicNamespace,
  buildSessionNamespaces,
  buildStrategyNamespaces,
  resolveAccessibleNamespaces,
  resolveWritableNamespaces,
  resolveWildcardPrefixes,
  isScopeReadable,
  isScopeWritable,
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
    assert.deepEqual(ns, ["/semantic/bija", "/episodic/bija", "/preferences/bija"]);
  });
  it("shared mode", () => {
    const ns = buildStrategyNamespaces("bija", "shared");
    assert.deepEqual(ns, ["/semantic", "/episodic", "/preferences"]);
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
      ["/summary/bija/s1"],
    );
  });
  it("shared mode", () => {
    assert.deepEqual(
      buildSessionNamespaces("bija", "s1", "shared"),
      ["/summary/s1"],
    );
  });
  it("sanitizes special chars", () => {
    assert.deepEqual(
      buildSessionNamespaces("bot/a", "s:1", "per-agent"),
      ["/summary/bot_a/s_1"],
    );
  });
});

describe("scopeToSearchNamespaces", () => {
  it("global returns only primary", () => {
    assert.deepEqual(scopeToSearchNamespaces({ kind: "global" }, "per-agent"), ["/global"]);
  });
  it("agent scope expands to include strategies and summary", () => {
    const ns = scopeToSearchNamespaces({ kind: "agent", id: "bija" }, "per-agent");
    assert.ok(ns.includes("/agents/bija"));
    assert.ok(ns.includes("/semantic/bija"));
    assert.ok(ns.includes("/episodic/bija"));
    assert.ok(ns.includes("/preferences/bija"));
    assert.ok(ns.includes("/summary/bija"), "actor-level summary included");
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

  it("includes actor-level strategy namespaces in per-agent mode", () => {
    const ns = resolveAccessibleNamespaces("bija", emptyCfg, "per-agent");
    assert.ok(ns.includes("/semantic/bija"));
    assert.ok(ns.includes("/episodic/bija"));
    assert.ok(ns.includes("/preferences/bija"));
    assert.ok(ns.includes("/summary/bija"), "actor-level summary included");
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
    assert.ok(ns.includes("/summary/sales"), "cross-agent summary included");
  });

  it("deduplicates namespaces", () => {
    const cfg = { agentAccess: { bija: ["agent:bija"] }, writeAccess: {} };
    const ns = resolveAccessibleNamespaces("bija", cfg, "per-agent");
    const dupes = ns.filter((v, i) => ns.indexOf(v) !== i);
    assert.equal(dupes.length, 0);
  });

  it("combined with buildSessionNamespaces produces expected namespaces", () => {
    const ns = resolveAccessibleNamespaces("bija", emptyCfg, "per-agent");
    const sessionNs = buildSessionNamespaces("bija", "s1", "per-agent");
    const combined = [...new Set([...ns, ...sessionNs])];
    assert.equal(combined.length, 7);
    assert.deepEqual(combined.sort(), [
      "/agents/bija", "/episodic/bija", "/global",
      "/preferences/bija", "/semantic/bija", "/summary/bija", "/summary/bija/s1",
    ]);
  });

  it("with peerId + agentId: includes /users/ primary AND /agents/{agentId} readable", () => {
    const ns = resolveAccessibleNamespaces("+86138xxx", emptyCfg, "per-agent", "+86138xxx", "agama");
    assert.ok(ns.includes("/users/_86138xxx"), "/users/ primary for customer");
    assert.ok(ns.includes("/agents/agama"), "/agents/{agentId} readable for shared knowledge");
    assert.ok(ns.includes("/semantic/_86138xxx"), "strategy ns uses actorId=peerId");
    assert.ok(ns.includes("/global"));
  });

  it("with peerId but no agentId: /agents/ not included", () => {
    const ns = resolveAccessibleNamespaces("+86138xxx", emptyCfg, "per-agent", "+86138xxx");
    assert.ok(ns.includes("/users/_86138xxx"), "/users/ primary");
    assert.ok(!ns.some(n => n.startsWith("/agents/")), "no /agents/ without agentId");
  });

  it("with peerId: actorId=peerId generates user-scoped strategy namespaces", () => {
    const ns = resolveAccessibleNamespaces("+86138xxx", emptyCfg, "per-agent", "+86138xxx", "agama");
    assert.ok(ns.includes("/semantic/_86138xxx"), "semantic strategy for customer");
    assert.ok(ns.includes("/episodic/_86138xxx"), "episodic strategy for customer");
    assert.ok(ns.includes("/preferences/_86138xxx"), "preferences strategy for customer");
  });

  it("without peerId (undefined) uses /agents/ primary as before", () => {
    const ns = resolveAccessibleNamespaces("bija", emptyCfg, "per-agent", undefined);
    assert.ok(ns.includes("/agents/bija"));
    assert.ok(!ns.some(n => n.startsWith("/users/")));
  });

  it("agentAccess '*' wildcard key works as fallback", () => {
    const cfg = { agentAccess: { "*": ["project:shared"] }, writeAccess: {} };
    const ns = resolveAccessibleNamespaces("+86138xxx", cfg, "per-agent", "+86138xxx", "agama");
    assert.ok(ns.includes("/projects/shared"), "wildcard grants project access");
  });

  it("specific actorId key takes priority over '*' wildcard", () => {
    const cfg = {
      agentAccess: { "+86138xxx": ["project:vip"], "*": ["project:basic"] },
      writeAccess: {},
    };
    const ns = resolveAccessibleNamespaces("+86138xxx", cfg, "per-agent", "+86138xxx", "agama");
    assert.ok(ns.includes("/projects/vip"), "specific key matched");
    assert.ok(!ns.includes("/projects/basic"), "wildcard not used when specific key exists");
  });
});

describe("resolveWritableNamespaces with peerId", () => {
  const emptyCfg = { agentAccess: {}, writeAccess: {} };

  it("with peerId uses /users/ primary", () => {
    const ns = resolveWritableNamespaces("+86138xxx", emptyCfg, "per-agent", "+86138xxx");
    assert.ok(ns.includes("/users/_86138xxx"));
    assert.ok(!ns.includes("/agents/_86138xxx"));
  });

  it("without peerId uses /agents/ primary", () => {
    const ns = resolveWritableNamespaces("bija", emptyCfg, "per-agent");
    assert.ok(ns.includes("/agents/bija"));
  });
});

describe("resolveWritableNamespaces includes strategy namespaces", () => {
  const emptyCfg = { agentAccess: {}, writeAccess: {} };

  it("per-agent + peerId: includes strategy namespaces for peerId", () => {
    const ns = resolveWritableNamespaces("+86138xxx", emptyCfg, "per-agent", "+86138xxx");
    assert.ok(ns.includes("/semantic/_86138xxx"), "semantic");
    assert.ok(ns.includes("/episodic/_86138xxx"), "episodic");
    assert.ok(ns.includes("/preferences/_86138xxx"), "preferences");
    assert.ok(ns.includes("/summary/_86138xxx"), "summary");
  });

  it("per-agent without peerId: includes strategy namespaces for actorId", () => {
    const ns = resolveWritableNamespaces("bija", emptyCfg, "per-agent");
    assert.ok(ns.includes("/semantic/bija"), "semantic");
    assert.ok(ns.includes("/episodic/bija"), "episodic");
    assert.ok(ns.includes("/preferences/bija"), "preferences");
    assert.ok(ns.includes("/summary/bija"), "summary");
  });

  it("shared mode: includes flat strategy namespaces", () => {
    const ns = resolveWritableNamespaces("bija", emptyCfg, "shared");
    assert.ok(ns.includes("/semantic"), "semantic");
    assert.ok(ns.includes("/episodic"), "episodic");
    assert.ok(ns.includes("/preferences"), "preferences");
    assert.ok(ns.includes("/summary"), "summary");
  });

  it("isScopeWritable allows own strategy namespace", () => {
    assert.ok(isScopeWritable("ou_xxx", "/semantic/ou_xxx", emptyCfg, "per-agent", "ou_xxx"));
    assert.ok(isScopeWritable("ou_xxx", "/episodic/ou_xxx", emptyCfg, "per-agent", "ou_xxx"));
    assert.ok(isScopeWritable("ou_xxx", "/preferences/ou_xxx", emptyCfg, "per-agent", "ou_xxx"));
    assert.ok(isScopeWritable("ou_xxx", "/summary/ou_xxx", emptyCfg, "per-agent", "ou_xxx"));
  });

  it("cross-actor: cannot write to another actor's strategy namespace", () => {
    assert.ok(!isScopeWritable("actorA", "/semantic/actorB", emptyCfg, "per-agent"));
    assert.ok(!isScopeWritable("actorA", "/episodic/actorB", emptyCfg, "per-agent"));
  });

  it("no duplicates when writeAccess also includes a strategy ns", () => {
    const cfg = { agentAccess: {}, writeAccess: { bija: ["user:bija:semantic"] } };
    const ns = resolveWritableNamespaces("bija", cfg, "per-agent");
    const semanticCount = ns.filter(n => n === "/semantic/bija").length;
    assert.equal(semanticCount, 1, "no duplicate /semantic/bija");
  });
});

describe("resolveWildcardPrefixes", () => {
  it("returns /users/ prefix for user:* scope", () => {
    const cfg = { agentAccess: { employee: ["user:*"] }, writeAccess: {} };
    const prefixes = resolveWildcardPrefixes(cfg, "employee");
    assert.deepEqual(prefixes, ["/users/"]);
  });

  it("returns empty for no wildcard", () => {
    const cfg = { agentAccess: { employee: ["agent:sales"] }, writeAccess: {} };
    const prefixes = resolveWildcardPrefixes(cfg, "employee");
    assert.deepEqual(prefixes, []);
  });

  it("returns empty for unknown actor", () => {
    const cfg = { agentAccess: {}, writeAccess: {} };
    const prefixes = resolveWildcardPrefixes(cfg, "nobody");
    assert.deepEqual(prefixes, []);
  });
});

describe("isScopeReadable with peerId and wildcards", () => {
  it("customer can read own /users/ namespace", () => {
    const cfg = { agentAccess: {}, writeAccess: {} };
    const result = isScopeReadable("+86138xxx", ["/users/_86138xxx"], cfg, "per-agent", "+86138xxx");
    assert.ok(result.allowed);
    assert.deepEqual(result.filteredNamespaces, ["/users/_86138xxx"]);
  });

  it("customer cannot read other customer namespace", () => {
    const cfg = { agentAccess: {}, writeAccess: {} };
    const result = isScopeReadable("+86138xxx", ["/users/_86139xxx"], cfg, "per-agent", "+86138xxx");
    assert.ok(!result.allowed);
  });

  it("employee with user:* wildcard can read any /users/ namespace", () => {
    const cfg = { agentAccess: { employee: ["user:*"] }, writeAccess: {} };
    const result = isScopeReadable("employee", ["/users/_86138xxx", "/users/_86139xxx"], cfg, "per-agent");
    assert.ok(result.allowed);
    assert.equal(result.filteredNamespaces.length, 2);
  });

  it("employee without user:* cannot read /users/ namespaces", () => {
    const cfg = { agentAccess: {}, writeAccess: {} };
    const result = isScopeReadable("employee", ["/users/_86138xxx"], cfg, "per-agent");
    assert.ok(!result.allowed);
  });
});

describe("user scope strategy expansion in agentAccess", () => {
  it("user:ou_xxx expands to primary + 4 strategy namespaces", () => {
    const cfg = { agentAccess: { employee: ["user:ou_xxx"] }, writeAccess: {} };
    const ns = resolveAccessibleNamespaces("employee", cfg, "per-agent");
    assert.ok(ns.includes("/users/ou_xxx"), "primary");
    assert.ok(ns.includes("/semantic/ou_xxx"), "semantic");
    assert.ok(ns.includes("/episodic/ou_xxx"), "episodic");
    assert.ok(ns.includes("/preferences/ou_xxx"), "preferences");
    assert.ok(ns.includes("/summary/ou_xxx"), "summary");
  });

  it("user:ou_xxx:semantic gives only /semantic/ou_xxx", () => {
    const cfg = { agentAccess: { employee: ["user:ou_xxx:semantic"] }, writeAccess: {} };
    const ns = resolveAccessibleNamespaces("employee", cfg, "per-agent");
    assert.ok(ns.includes("/semantic/ou_xxx"), "semantic granted");
    assert.ok(!ns.includes("/users/ou_xxx"), "primary NOT granted");
    assert.ok(!ns.includes("/episodic/ou_xxx"), "episodic NOT granted");
  });

  it("user:ou_xxx:primary gives /users/ou_xxx (not /agents/)", () => {
    const cfg = { agentAccess: { employee: ["user:ou_xxx:primary"] }, writeAccess: {} };
    const ns = resolveAccessibleNamespaces("employee", cfg, "per-agent");
    assert.ok(ns.includes("/users/ou_xxx"), "user primary");
    assert.ok(!ns.includes("/agents/ou_xxx"), "not agent primary");
  });

  it("user:* wildcard does NOT expand to strategy namespaces", () => {
    const cfg = { agentAccess: { employee: ["user:*"] }, writeAccess: {} };
    const ns = resolveAccessibleNamespaces("employee", cfg, "per-agent");
    // user:* is handled by resolveWildcardPrefixes, not by scope expansion
    assert.ok(!ns.includes("/semantic/ou_xxx"), "no specific user strategy ns");
  });

  it("regression: agent:bot-a expansion unchanged after user scope support", () => {
    const cfg = { agentAccess: { bija: ["agent:sales"] }, writeAccess: {} };
    const ns = resolveAccessibleNamespaces("bija", cfg, "per-agent");
    assert.ok(ns.includes("/agents/sales"), "agent primary");
    assert.ok(ns.includes("/semantic/sales"), "semantic");
    assert.ok(ns.includes("/episodic/sales"), "episodic");
    assert.ok(ns.includes("/preferences/sales"), "preferences");
    assert.ok(ns.includes("/summary/sales"), "summary");
  });

  it("isScopeReadable allows user strategy namespaces via user: scope", () => {
    const cfg = { agentAccess: { employee: ["user:ou_xxx"] }, writeAccess: {} };
    const result = isScopeReadable("employee", ["/semantic/ou_xxx", "/episodic/ou_xxx"], cfg, "per-agent");
    assert.ok(result.allowed);
    assert.equal(result.filteredNamespaces.length, 2);
  });

  it("isScopeWritable allows user:ou_xxx:semantic in writeAccess", () => {
    const cfg = { agentAccess: {}, writeAccess: { employee: ["user:ou_xxx:semantic"] } };
    assert.ok(isScopeWritable("employee", "/semantic/ou_xxx", cfg, "per-agent"));
    assert.ok(!isScopeWritable("employee", "/episodic/ou_xxx", cfg, "per-agent"));
  });
});
