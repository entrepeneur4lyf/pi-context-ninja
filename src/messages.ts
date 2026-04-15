import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TextContent, ToolResultMessage } from "@mariozechner/pi-ai";

type ToolResultBlock = ToolResultMessage["content"][number];
type ToolResultContent = ToolResultMessage["content"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTextContent(block: unknown): block is TextContent {
  return isRecord(block) && block.type === "text" && typeof block.text === "string";
}

function countTextBlocks(content: ToolResultBlock[]): number {
  return content.reduce((count, block) => count + (isTextContent(block) ? 1 : 0), 0);
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
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
 * Extracts text only when the tool result content is a single text block.
 * Mixed-content results return null to avoid destructive rewrites.
 */
export function extractExclusiveToolText(content: ToolResultContent | undefined): string | null {
  if (!content || content.length !== 1) {
    return null;
  }

  return isTextContent(content[0]) ? content[0].text : null;
}

/**
 * Builds a replacement content array for single-text tool results.
 * Mixed-content results return undefined to signal "leave unchanged".
 */
export function replaceExclusiveToolText(
  content: ToolResultContent | undefined,
  newText: string,
): ToolResultContent | undefined {
  return extractExclusiveToolText(content) === null ? undefined : [{ type: "text", text: newText }];
}

/**
 * Estimates tool-result tokens from visible text blocks only.
 */
export function estimateToolContentTokens(content: ToolResultContent | undefined): number {
  if (!content) {
    return 0;
  }

  let total = 0;
  for (const block of content) {
    if (isTextContent(block)) {
      total += estimateTokens(block.text);
    }
  }
  return total;
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
