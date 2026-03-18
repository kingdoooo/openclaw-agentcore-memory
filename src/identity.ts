export function parseAgentIdFromSessionKey(sessionKey: string): string {
  // OpenClaw session keys: "agent:<agentId>:session:<sessionId>"
  const match = sessionKey.match(/^agent:([^:]+):/);
  if (match) return match[1];

  // Fallback: try extracting from other patterns
  const parts = sessionKey.split(":");
  if (parts.length >= 2 && parts[0] === "agent") return parts[1];

  return "default";
}
