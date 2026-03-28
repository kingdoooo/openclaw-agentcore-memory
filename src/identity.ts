export function parseAgentIdFromSessionKey(sessionKey: string): string {
  // OpenClaw session keys: "agent:<agentId>:session:<sessionId>"
  const match = sessionKey.match(/^agent:([^:]+):/);
  if (match) return match[1];

  // Fallback: try extracting from other patterns
  const parts = sessionKey.split(":");
  if (parts.length >= 2 && parts[0] === "agent") return parts[1];

  return "default";
}

export function parseSessionIdFromSessionKey(sessionKey: string): string | undefined {
  // "agent:bija:session:abc123" → "abc123"
  const match = sessionKey.match(/:session:(.+)$/);
  return match?.[1] || undefined;
}

export function parsePeerIdFromSessionKey(sessionKey: string): string | undefined {
  // OpenClaw uses :direct: in actual session keys (buildAgentPeerSessionKey).
  // :dm: is kept for backward compatibility (OpenClaw's parse side also accepts both).
  //
  // :direct: (actual OpenClaw format):
  //   "agent:agama:direct:ou_fd063e94..."           → per-peer
  //   "agent:support:telegram:direct:123456789"     → per-channel-peer
  //   "agent:support:feishu:default:direct:ou_xxx"  → per-account-channel-peer
  //
  // :dm: (legacy/compat):
  //   "agent:support:dm:+8613800138000"             → per-peer
  //
  // Non-DM keys return undefined:
  //   "agent:bija:session:abc123"                   → undefined
  //   "agent:bot:telegram:group:-100xxx"            → undefined
  const match = sessionKey.match(/:(?:dm|direct):([^:]+)$/);
  return match?.[1] || undefined;
}
