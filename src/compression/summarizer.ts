import type { AgentMessage } from "@mariozechner/pi-agent-core";
export function extractTopicFromRange(messages: AgentMessage[]): string {
  const texts: string[] = [];
  for (const m of messages) {
    const c = (m as any).content;
    if (typeof c === "string") texts.push(c);
    else if (Array.isArray(c)) for (const p of c) if (p.type === "text") texts.push(p.text);
  }
  const f = texts.slice(0, 3).join(" ").split("\n")[0];
  if (f.length > 100) return f.slice(0, 100) + "...";
  return f || "no content";
}
