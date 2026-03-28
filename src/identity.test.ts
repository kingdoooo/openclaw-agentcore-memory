import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAgentIdFromSessionKey, parseSessionIdFromSessionKey, parsePeerIdFromSessionKey } from "./identity.js";

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

describe("parsePeerIdFromSessionKey", () => {
  it("per-peer DM (phone number)", () => {
    assert.equal(parsePeerIdFromSessionKey("agent:support:dm:+8613800138000"), "+8613800138000");
  });
  it("per-channel-peer DM (Telegram ID)", () => {
    assert.equal(parsePeerIdFromSessionKey("agent:support:telegram:dm:123456789"), "123456789");
  });
  it("per-channel-peer DM (Feishu Open ID)", () => {
    assert.equal(parsePeerIdFromSessionKey("agent:support:feishu:dm:ou_alice123"), "ou_alice123");
  });
  it("per-channel-peer DM (Discord ID)", () => {
    assert.equal(parsePeerIdFromSessionKey("agent:support:discord:dm:987654321012345678"), "987654321012345678");
  });
  it("no peerId in Mode A session key", () => {
    assert.equal(parsePeerIdFromSessionKey("agent:bija:session:abc123"), undefined);
  });
  it("no peerId in main session key", () => {
    assert.equal(parsePeerIdFromSessionKey("agent:main:main"), undefined);
  });
  it("no peerId in group chat", () => {
    assert.equal(parsePeerIdFromSessionKey("agent:bot:telegram:group:-1001234567890"), undefined);
  });
  it("empty string", () => {
    assert.equal(parsePeerIdFromSessionKey(""), undefined);
  });

  // :direct: — OpenClaw actual format (buildAgentPeerSessionKey)
  it("per-peer direct (Feishu Open ID)", () => {
    assert.equal(
      parsePeerIdFromSessionKey("agent:agama:direct:ou_fd063e9461d60c03d72425a080786d18"),
      "ou_fd063e9461d60c03d72425a080786d18",
    );
  });
  it("per-channel-peer direct (Telegram ID)", () => {
    assert.equal(
      parsePeerIdFromSessionKey("agent:support:telegram:direct:123456789"),
      "123456789",
    );
  });
  it("per-account-channel-peer direct", () => {
    assert.equal(
      parsePeerIdFromSessionKey("agent:support:feishu:default:direct:ou_alice123"),
      "ou_alice123",
    );
  });
});
