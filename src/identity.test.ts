import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAgentIdFromSessionKey, parseSessionIdFromSessionKey } from "./identity.js";

describe("parseAgentIdFromSessionKey", () => {
  it("standard format", () => {
    assert.equal(parseAgentIdFromSessionKey("agent:bija:session:abc123"), "bija");
  });
  it("agent only (no session)", () => {
    assert.equal(parseAgentIdFromSessionKey("agent:bija"), "bija");
  });
  it("returns default for empty string", () => {
    assert.equal(parseAgentIdFromSessionKey(""), "default");
  });
  it("returns default for unknown format", () => {
    assert.equal(parseAgentIdFromSessionKey("something:else"), "default");
  });
});

describe("parseSessionIdFromSessionKey", () => {
  it("standard format", () => {
    assert.equal(parseSessionIdFromSessionKey("agent:bija:session:abc123"), "abc123");
  });
  it("no session segment", () => {
    assert.equal(parseSessionIdFromSessionKey("agent:bija"), undefined);
  });
  it("empty string", () => {
    assert.equal(parseSessionIdFromSessionKey(""), undefined);
  });
  it("sessionId with colons (greedy match)", () => {
    assert.equal(parseSessionIdFromSessionKey("agent:bija:session:a:b:c"), "a:b:c");
  });
});
