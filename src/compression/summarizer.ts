import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { extractTextContent } from "../messages.js";

export function extractTopicFromRange(messages: AgentMessage[]): string {
  const texts = messages.map((message) => extractTextContent(message)).filter((text) => text.length > 0);
  const firstLine = texts.slice(0, 3).join(" ").split("\n")[0] ?? "";

  if (firstLine.length > 100) {
    return `${firstLine.slice(0, 100)}...`;
  }

  return firstLine || "no content";
}
