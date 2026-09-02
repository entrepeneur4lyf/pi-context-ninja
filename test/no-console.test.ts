import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";

function listSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listSourceFiles(full) : full.endsWith(".ts") ? [full] : [];
  });
}

describe("runtime silence (PCN-001)", () => {
  it("has no console calls anywhere under src/", () => {
    const offenders = listSourceFiles(path.join(import.meta.dir, "..", "src"))
      .filter((file) => /\bconsole\.(log|error|warn|info|debug)\(/.test(fs.readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("no listener and no host UI library at runtime (DASH-034, 04 acceptance)", () => {
  it("imports no node:http, node:https, node:net, or @oh-my-pi/pi-tui value under src/", () => {
    const offenders = listSourceFiles(path.join(import.meta.dir, "..", "src")).filter((file) => {
      const source = fs.readFileSync(file, "utf8");
      const valueImports = source
        .split("\n")
        .filter((line) => /^\s*import\s/.test(line) && !/^\s*import\s+type\s/.test(line));
      return valueImports.some((line) => /["'](node:)?(http|https|net)["']/.test(line) || /@oh-my-pi\/pi-tui/.test(line));
    });
    expect(offenders).toEqual([]);
  });
});
