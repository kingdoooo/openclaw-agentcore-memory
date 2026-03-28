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
  // DM session keys contain :dm:<peerId> at the end:
  // "agent:support:dm:+8613800138000" → "+8613800138000"
  // "agent:support:telegram:dm:123456789" → "123456789"
  // "agent:support:feishu:dm:ou_alice123" → "ou_alice123"
  // Non-DM keys return undefined:
  // "agent:bija:session:abc123" → undefined
  // "agent:bot:telegram:group:-100xxx" → undefined
  const match = sessionKey.match(/:dm:([^:]+)$/);
  return match?.[1] || undefined;
}
