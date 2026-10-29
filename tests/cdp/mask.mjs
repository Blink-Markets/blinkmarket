// Masks the CDP credential values in one line of output. Plain string search only: no pattern is
// ever built from a value, so a value cannot slow the search down or change how it matches.
export const CREDENTIAL_NAMES = ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET"];
const MIN_LINE_LENGTH = 16;

/**
 * Returns `(line) => maskedLine`. The literals are each non-empty credential value of `env`, plus each
 * line of a multi-line value that is 16 or more characters long after trimming. In a line, every
 * occurrence of every literal is found (overlaps included), overlapping and touching occurrences are
 * merged, and each merged span becomes one `[REDACTED:<NAME>]`, named after the literal that starts
 * first in it (the longer one on a tie). Nothing of a value therefore survives in part.
 */
export function createMasker(env) {
  const literals = CREDENTIAL_NAMES.flatMap((name) => {
    const value = env[name];
    if (!value) return [];
    const lines = value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length >= MIN_LINE_LENGTH);
    return [...new Set([value, ...(value.includes("\n") ? lines : [])])].map((text) => ({ text, name }));
  });
  if (literals.length === 0) return (line) => line;

  return (line) => {
    const found = [];
    for (const { text, name } of literals)
      for (let at = line.indexOf(text); at !== -1; at = line.indexOf(text, at + 1))
        found.push({ start: at, end: at + text.length, name });
    if (found.length === 0) return line;
    found.sort((a, b) => a.start - b.start || b.end - a.end);
    let out = "";
    let cursor = 0;
    for (let i = 0; i < found.length; ) {
      const { start, name } = found[i];
      let end = found[i].end;
      for (i++; i < found.length && found[i].start <= end; i++) end = Math.max(end, found[i].end);
      out += line.slice(cursor, start) + `[REDACTED:${name}]`;
      cursor = end;
    }
    return out + line.slice(cursor);
  };
}
