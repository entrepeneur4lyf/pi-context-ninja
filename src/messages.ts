import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TextContent, ToolResultMessage } from "@mariozechner/pi-ai";

type ToolResultBlock = ToolResultMessage["content"][number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTextContent(block: unknown): block is TextContent {
  return isRecord(block) && block.type === "text" && typeof block.text === "string";
}

/**
 * Checks whether a message is a Pi tool result message.
 */
export function isToolResultMessage(msg: AgentMessage): msg is ToolResultMessage {
  return isRecord(msg) && msg.role === "toolResult";
}

/**
 * Extracts text content from a tool result message.
 * Custom agent messages and non-tool messages are treated as opaque.
 */
export function extractTextContent(msg: AgentMessage): string {
  if (!isToolResultMessage(msg)) {
    return "";
  }

  return msg.content.filter(isTextContent).map((block) => block.text).join("\n");
}

/**
 * Returns the tool name from a tool result message, or empty string if not present.
 */
export function getToolName(msg: AgentMessage): string {
  return isToolResultMessage(msg) && typeof msg.toolName === "string" ? msg.toolName : "";
}

/**
 * Returns whether a tool result message represents an error.
 */
export function isError(msg: AgentMessage): boolean {
  return isToolResultMessage(msg) && typeof msg.isError === "boolean" ? msg.isError : false;
}

function replaceToolTextBlocks(content: ToolResultBlock[], newText: string): ToolResultBlock[] {
  const next: ToolResultBlock[] = [];
  for (const block of content) {
    if (isTextContent(block)) {
      next.push({ type: "text", text: newText });
      continue;
    }

    if (
      isRecord(block) &&
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      next.push(block);
      continue;
    }

    next.push(block);
  }

  return next;
}

/**
 * Replaces the text content inside a tool result while preserving non-text blocks.
 */
export function replaceToolTextContent(msg: ToolResultMessage, newText: string): ToolResultMessage {
  return {
    ...msg,
    content: replaceToolTextBlocks(msg.content, newText),
  };
}

/**
 * Compatibility helper for older callers.
 * String replacements preserve non-text blocks; explicit arrays are passed through.
 */
export function replaceToolContent(
  msg: AgentMessage,
  newContent: string | ToolResultMessage["content"],
): AgentMessage {
  if (!isToolResultMessage(msg)) {
    return msg;
  }

  if (typeof newContent === "string") {
    return replaceToolTextContent(msg, newContent);
  }

  return {
    ...msg,
    content: newContent,
  };
}
