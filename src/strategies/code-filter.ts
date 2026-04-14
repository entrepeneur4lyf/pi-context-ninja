export function detectLanguage(text: string): string | null {
  if (/^\s*(def |class |import |from )/m.test(text)) return "python";
  if (/^\s*(function |const \w+\s*[:=]|let |var |export |interface |type )/m.test(text)) return "typescript";
  if (/^\s*(fn |pub |struct |impl |enum |trait )/m.test(text)) return "rust";
  if (/^\s*(func |package |type .+ struct|var )/m.test(text)) return "go";
  return null;
}

export function codeFilter(
  text: string,
  lang: string,
  keepDocstrings = false,
): string | null {
  if (lang === "python") {
    return filterPython(text, keepDocstrings);
  }
  if (["typescript", "javascript", "rust", "go"].includes(lang)) {
    return filterBraceLang(text);
  }
  return null;
}

function filterPython(text: string, keepDocstrings: boolean): string | null {
  const lines = text.split("\n");
  const result: string[] = [];
  let inFunction = false;
  let indentThreshold: number | null = null;
  let inDocstring = false;
  let docstringQuote = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for docstring boundaries
    if (inDocstring) {
      if (line.includes(docstringQuote)) {
        inDocstring = false;
        if (keepDocstrings) result.push(line);
      }
      continue;
    }

    // Detect start of a function def
    const fnMatch = line.match(/^\s*(\s*)def\s+\w+/);
    if (fnMatch && !inFunction) {
      inFunction = true;
      indentThreshold = fnMatch[1].length;
      result.push(line);

      // Check if docstring starts on next or same line
      if (/"""/.test(line) || /'''/.test(line)) {
        const q = /'''''/.test(line) ? "'''" : '"""';
        if (keepDocstrings) {
          result.push(line);
        }
        // Check if docstring closes on same line
        if ((line.split(q).length - 1) >= 2) {
          // docstring opened and closed on same line
        } else {
          inDocstring = true;
          docstringQuote = q;
        }
      }
      continue;
    }

    if (inFunction) {
      const indentMatch = line.match(/^(\s*)/);
      const currentIndent = indentMatch ? indentMatch[1].length : 0;

      // Blank line: keep it
      if (line.trim() === "") {
        result.push(line);
        continue;
      }

      // Dedent means function ended
      if (currentIndent <= (indentThreshold ?? 0) && line.trim().length > 0) {
        inFunction = false;
        indentThreshold = null;
        // Check for docstring
        if (/^(\s*)(?:"""|''')/.test(line)) {
          const q = /'''/.test(line) ? "'''" : '"""';
          if (keepDocstrings) {
            result.push(line);
          }
          if ((line.split(q).length - 1) < 2) {
            inDocstring = true;
            docstringQuote = q;
          }
        } else {
          result.push(line);
        }
        continue;
      }

      // Inside function body - check for docstring
      if (/^\s*(?:"""|''')/.test(line)) {
        const q = /'''''/.test(line) ? "'''" : '"""';
        if (keepDocstrings) {
          result.push(line);
        }
        if ((line.split(q).length - 1) < 2) {
          inDocstring = true;
          docstringQuote = q;
        }
        continue;
      }

      // Skip body lines (don't add to result)
      continue;
    }

    // Not in a function
    result.push(line);
  }

  const filtered = result.join("\n");
  if (filtered.length >= text.length * 0.95) return null;
  return filtered;
}

function filterBraceLang(text: string): string | null {
  const lines = text.split("\n");
  const result: string[] = [];
  let inFunction = false;
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (inFunction) {
      // Count braces
      for (const ch of line) {
        if (ch === "{") depth++;
        if (ch === "}") depth--;
      }
      if (depth <= 0) {
        inFunction = false;
        depth = 0;
      }
      continue;
    }

    // Detect function start
    if (/^\s*(?:export\s+)?(?:async\s+)?(?:function|fn)\s+/.test(line)) {
      inFunction = true;
      // Count braces on this line
      for (const ch of line) {
        if (ch === "{") depth++;
        if (ch === "}") depth--;
      }
      if (depth <= 0) {
        inFunction = false;
        depth = 0;
      }
      result.push(line);
      continue;
    }

    result.push(line);
  }

  const filtered = result.join("\n");
  if (filtered.length >= text.length * 0.95) return null;
  return filtered;
}
