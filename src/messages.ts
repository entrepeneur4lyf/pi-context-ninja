import type { TextContent, ImageContent } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

/**
 * Extracts text content from an AgentMessage.
 * Handles TextContent[], raw string content, or empty/missing content.
 */
export function extractTextContent(msg: AgentMessage): string {
  const content = msg.content as unknown;
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: unknown) => {
        if (c && typeof c === "object" && "type" in c && (c as TextContent).type === "text") {
          return (c as TextContent).text ?? "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Checks if a message has role "toolResult".
 */
export function isToolResultMessage(msg: AgentMessage): boolean {
  return msg.role === "toolResult";
}

/**
 * Returns the tool name from a message, or empty string if not present.
 */
export function getToolName(msg: AgentMessage): string {
  return (msg as any).toolName ?? "";
}

/**
 * Returns whether a tool result message represents an error.
 */
export function isError(msg: AgentMessage): boolean {
  return (msg as any).isError ?? false;
}

/**
 * Shallow-clone the message and replace its content with new content.
 * If newContent is a string, it is wrapped in a TextContent array.
 */
export function replaceToolContent(
  msg: AgentMessage,
  newContent: string | (TextContent | ImageContent)[],
): AgentMessage {
  const resolvedContent: (TextContent | ImageContent)[] =
    typeof newContent === "string" ? [{ type: "text", text: newContent }] : newContent;
  return { ...msg, content: resolvedContent };
}
