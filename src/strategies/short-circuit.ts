export function shortCircuit(text: string, isErrorCtx: boolean): string | null {
  if (isErrorCtx) return null;

  try {
    const parsed = JSON.parse(text);
    if (parsed.status === "ok" || parsed.success === true) {
      return "[ok]";
    }
  } catch {
    // not JSON, continue
  }

  const testMatch = text.match(/(\d+)\s+passed/);
  if (testMatch) {
    return `[tests: ${testMatch[1]} passed]`;
  }

  if (text.includes("Already up to date")) {
    return "[git: up to date]";
  }

  if (/file written/i.test(text) || /^\[ok:\s*file.*written/i.test(text)) {
    return "[file written]";
  }

  return null;
}
