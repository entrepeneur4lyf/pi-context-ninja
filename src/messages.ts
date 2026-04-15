import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TextContent, ToolResultMessage } from "@mariozechner/pi-ai";

type ToolResultBlock = ToolResultMessage["content"][number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTextContent(block: unknown): block is TextContent {
  return isRecord(block) && block.type === "text" && typeof block.text === "string";
}

function countTextBlocks(content: ToolResultBlock[]): number {
  return content.reduce((count, block) => count + (isTextContent(block) ? 1 : 0), 0);
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

/**
 * Replaces the text content inside a tool result when the result has exactly one text block.
 */
export function replaceToolTextContent(msg: ToolResultMessage, newText: string): ToolResultMessage {
  return replaceSingleToolTextContent(msg, newText);
}

/**
 * Replaces a single text block inside a tool result when exactly one is present.
 * Mixed tool results with multiple text blocks are left unchanged to preserve semantics.
 */
export function replaceSingleToolTextContent(msg: ToolResultMessage, newText: string): ToolResultMessage {
  if (countTextBlocks(msg.content) !== 1) {
    return msg;
  }

  return {
    ...msg,
    content: msg.content.map((block) => (isTextContent(block) ? { ...block, text: newText } : block)),
  };
}

/**
 * Replaces a tool result with a single text block.
 * Use this when the semantics intentionally collapse the full tool result, such as tombstoning.
 */
export function replaceToolContentWithText(msg: ToolResultMessage, newText: string): ToolResultMessage {
  return {
    ...msg,
    content: [{ type: "text", text: newText }],
  };
}

/**
 * Returns the number of text blocks in a tool result message.
 */
export function countToolTextBlocks(msg: AgentMessage): number {
  if (!isToolResultMessage(msg)) {
    return 0;
  }

  return countTextBlocks(msg.content);
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
    return replaceSingleToolTextContent(msg, newContent);
  }

  return {
    ...msg,
    content: newContent,
  };
}
