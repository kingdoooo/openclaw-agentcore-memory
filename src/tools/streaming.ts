import type { MemoryStreamConsumer } from "../streaming.js";

export function createStreamingTool(
  getConsumer: () => MemoryStreamConsumer | null,
) {
  return {
    name: "agentcore_streaming",
    label: "AgentCore Streaming",
    description:
      "Manage and monitor the AgentCore Memory streaming consumer. View status, recent events, or pause/resume the stream.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description:
            "Action to perform: status (show connection state), recent_events (show last N events), pause (pause consumer), resume (resume consumer)",
          enum: ["status", "recent_events", "pause", "resume"],
        },
        count: {
          type: "number",
          description: "Number of recent events to return (default: 10, max: 50). Only used with recent_events action.",
        },
      },
      required: ["action"],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const consumer = getConsumer();
      if (!consumer) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "Streaming consumer is not configured or not available.",
              }),
            },
          ],
          details: { error: "not_configured" },
        };
      }

      const action = params.action as string;

      switch (action) {
        case "status": {
          const status = consumer.getStatus();
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(status, null, 2),
              },
            ],
            details: { action: "status" },
          };
        }

        case "recent_events": {
          const count = Math.min(
            Math.max(1, Number(params.count) || 10),
            50,
          );
          const events = consumer.recentEvents.slice(-count);
          const data = {
            totalEvents: consumer.eventCount,
            returned: events.length,
            events,
          };
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(data, null, 2),
              },
            ],
            details: { action: "recent_events", count: events.length },
          };
        }

        case "pause": {
          consumer.pause();
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  message: "Streaming consumer paused.",
                  isPaused: true,
                }),
              },
            ],
            details: { action: "pause" },
          };
        }

        case "resume": {
          consumer.resume();
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  message: "Streaming consumer resumed.",
                  isPaused: false,
                }),
              },
            ],
            details: { action: "resume" },
          };
        }

        default:
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: `Unknown action: ${action}. Use status, recent_events, pause, or resume.`,
                }),
              },
            ],
            details: { error: "unknown_action" },
          };
      }
    },
  };
}
