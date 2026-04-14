/**
 * Normalizes content by replacing variable patterns (timestamps, UUIDs, hashes)
 * with stable tokens for consistent comparison.
 */

export function normalizeContent(text: string): string {
  let result = text.replace(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g,
    "__TS__",
  );

  result = result.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi,
    "__UUID__",
  );

  result = result.replace(
    /\b[0-9a-f]{40}\b/g,
    "__HASH__",
  );

  return result;
}
