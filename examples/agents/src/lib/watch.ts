// The cheap check: did the pages this agent follows change since it last looked? A source is read
// with a conditional GET, its text is normalised so that noise (script nonces, timestamps, markup)
// does not count, and the result is compared with the fingerprint saved from the previous check.
// No model is involved; `decideUpdate` turns the result into "analyse" or "carry forward".
import { keccak256, type Hex } from "viem";
import {
  MAX_URL_BYTES,
  isCanonicalHttpsUrl,
  isEtag,
  isLastModified,
  mediaTypeOf,
  jsonBytes,
  type SourceFetcher,
  type Validators,
} from "./fetcher.ts";
import type { WatchRecord } from "./state.ts";

/** What one check found for one URL. `since` is set only for CHANGED: the time of the previous successful check. */
export type SourceCheck = {
  url: string;
  status: "NEW" | "CHANGED" | "UNCHANGED" | "UNREACHABLE";
  since: number | null;
  /** Unix seconds: the `now` of the check. */
  observedAt: number;
  /**
   * The fingerprint of what was read now. For an UNREACHABLE source it is the fingerprint saved from
   * the last successful check, and null only when there is none (the first check failed). A URL
   * whose first check failed gets no entry in `next`, so its first successful read is NEW.
   */
  fingerprint: Hex | null;
  /** The bytes that were read, for NEW and CHANGED only, so that the caller can archive them. */
  raw?: Uint8Array;
  mediaType?: string;
  /** The failure code of an UNREACHABLE source. */
  code?: string;
};

// -- Normalisation ----------------------------------------------------------------------------

const collapse = (value: string) => value.replace(/\s+/g, " ").trim();
const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
/** One pass, so `&amp;lt;` becomes the text `&lt;` and not `<`. A code point that does not exist becomes U+FFFD. */
function decodeEntities(value: string): string {
  return value.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));/g, (whole, dec?: string, hex?: string, name?: string) => {
    if (name !== undefined) return Object.hasOwn(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name]! : whole;
    const code = dec !== undefined ? Number(dec) : parseInt(hex!, 16);
    return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "�" : String.fromCodePoint(code);
  });
}

// Elements whose content is never page text.
const OPAQUE = ["script", "style", "noscript"];
const OPAQUE_START = new RegExp(`^<(${OPAQUE.join("|")})(?=[\\s/>])`, "i");

/**
 * Page text without markup: drops `script`, `style`, `noscript`, comments, tags and attributes. One
 * pass over the input with no backtracking, so hostile markup (an unterminated comment, tag or
 * quote repeated thousands of times) costs time in proportion to its size.
 */
function htmlText(html: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));
    // "<!-->" and "<!--->" are complete, empty comments: the text after them is page text.
    if (html.startsWith("<!-->", lt) || html.startsWith("<!--->", lt)) {
      out.push(" ");
      i = lt + (html[lt + 4] === ">" ? 5 : 6);
      continue;
    }
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      if (end === -1) break;
      out.push(" ");
      i = end + 3;
      continue;
    }
    const next = html[lt + 1] ?? "";
    if (!/[A-Za-z/!?]/.test(next)) {
      // A "<" that opens nothing is text.
      out.push("<");
      i = lt + 1;
      continue;
    }
    const opaque = OPAQUE_START.exec(html.slice(lt, lt + 12));
    if (opaque) {
      const closing = new RegExp(`</${opaque[1]}(?=[\\s/>])`, "gi");
      closing.lastIndex = lt;
      const found = closing.exec(html);
      if (!found) break;
      const close = html.indexOf(">", found.index);
      if (close === -1) break;
      out.push(" ");
      i = close + 1;
      continue;
    }
    // A tag ends at the first ">" outside a quoted attribute value; a quote opens one only right
    // after "=", so a stray apostrophe in a tag cannot swallow the rest of the page.
    let quote = "";
    let last = "";
    let j = lt + 1;
    for (; j < html.length; j++) {
      const c = html[j]!;
      if (quote) {
        if (c === quote) quote = "";
      } else if ((c === '"' || c === "'") && last === "=") quote = c;
      else if (c === ">") break;
      if (!/\s/.test(c)) last = c;
    }
    if (j >= html.length) break;
    out.push(" ");
    i = j + 1;
  }
  return out.join("");
}

// JSON nested deeper than this, or with more structure than this, is compared as text. The limits
// are fixed numbers so that the answer never depends on how much stack or memory is left, and they
// bound the work and the memory of the canonical walk (which holds every value) below.
const MAX_JSON_DEPTH = 256;
const MAX_JSON_TOKENS = 100_000; // arrays, objects, commas and colons outside strings
/** The nesting and the amount of structure of JSON text, found without parsing it. */
function jsonShape(json: string): { depth: number; tokens: number } {
  let depth = 0;
  let max = 0;
  let tokens = 0;
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (inString) {
      if (c === 92) i++;
      else if (c === 34) inString = false;
      continue;
    }
    if (c === 34) inString = true;
    else if (c === 91 || c === 123) {
      max = Math.max(max, ++depth);
      tokens++;
    } else if (c === 93 || c === 125) depth--;
    else if (c === 44 || c === 58) tokens++;
  }
  return { depth: max, tokens };
}

/** A JSON number kept as its source text, so that digits beyond double precision still count. */
class RawNumber {
  constructor(readonly source: string) {}
}
// Sorted keys, no whitespace, one output buffer. Written out so that a key such as "__proto__" is just a key.
function canonicalJson(root: unknown): string {
  const out: string[] = [];
  const write = (value: unknown): void => {
    if (value instanceof RawNumber) out.push(value.source);
    else if (Array.isArray(value)) {
      out.push("[");
      value.forEach((item, i) => {
        if (i) out.push(",");
        write(item);
      });
      out.push("]");
    } else if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      out.push("{");
      Object.keys(record)
        .sort()
        .forEach((key, i) => {
          if (i) out.push(",");
          out.push(JSON.stringify(key), ":");
          write(record[key]);
        });
      out.push("}");
    } else out.push(JSON.stringify(value));
  };
  write(root);
  return out.join("");
}
// The text of each number comes from the parser (`context.source`); where it is not offered, the value is used.
const keepNumberText = (_key: string, value: unknown, context?: { source?: string }) =>
  typeof value === "number" && typeof context?.source === "string" ? new RawNumber(context.source) : value;

/**
 * The text two reads of a source are compared by. A text body is decoded with its declared `charset`
 * (UTF-8 when none is given). If the label is not known or the bytes do not decode, the body is read
 * as windows-1252, which gives every byte value its own character: a changed byte is still a changed
 * character, and the markup noise below is still removed. Then: markup and noise removed for
 * `text/html`, keys sorted and numbers kept verbatim for `application/json` (nesting past 256 levels,
 * more than 100,000 structural tokens, or text that does not parse, is compared as
 * whitespace-collapsed text), whitespace collapsed for `text/plain` and `text/csv`. Anything that is
 * not text, such as `application/pdf`, is compared as the hash of its raw bytes.
 */
export function normalizeForFingerprint(bytes: Uint8Array, mediaType: string, charset?: string): string {
  const type = mediaType.split(";")[0]!.trim().toLowerCase();
  if (type !== "text/html" && type !== "application/json" && type !== "text/plain" && type !== "text/csv")
    return `raw:${keccak256(bytes)}`;
  let decoded: string;
  try {
    decoded = new TextDecoder(charset ?? "utf-8", { fatal: true }).decode(bytes);
  } catch {
    decoded = new TextDecoder("windows-1252").decode(bytes);
  }
  if (type === "text/html") return collapse(decodeEntities(htmlText(decoded)));
  if (type === "application/json") {
    const shape = jsonShape(decoded);
    if (shape.depth > MAX_JSON_DEPTH || shape.tokens > MAX_JSON_TOKENS) return collapse(decoded);
    try {
      return canonicalJson(JSON.parse(decoded, keepNumberText as Parameters<typeof JSON.parse>[1]));
    } catch {
      // Not JSON after all: compare it as text.
      return collapse(decoded);
    }
  }
  return collapse(decoded);
}

/** keccak256 of the UTF-8 text. */
export function fingerprint(text: string): Hex {
  return keccak256(new TextEncoder().encode(text));
}

// -- The check --------------------------------------------------------------------------------

const MAX_SOURCES = 20;
const MAX_CONCURRENT_FETCHES = 5;

/**
 * The form of a source URL that `checkSources` accepts, saves and puts into a note: `new URL(raw).href`
 * when the URL is https and that form takes at most 2048 bytes once JSON-encoded; null for anything
 * else. A watch list is built with this, and a URL that gives null is dropped and logged.
 */
export function watchableUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  return isCanonicalHttpsUrl(url.href) ? url.href : null;
}

/**
 * Reads every URL once (a URL listed twice is read once) and compares it with `record`. It does not
 * change `record`: `next` is the sources table as it would be after this check, and the caller saves
 * it only after the answer it led to was submitted, so a change that no answer reflected is seen
 * again. `next` holds only the URLs of this check: one that was dropped from the list and is added
 * again is NEW. A source that could not be read is UNREACHABLE and keeps its old entry, so one failed
 * fetch cannot fake a change later; if it never had one, it has none (its first success is NEW).
 *
 * The caller owns the watch list, so input it should have filtered is a bug and throws a
 * `RangeError`: a `now` that is not a whole number of seconds, more than 20 URLs once repeats are
 * removed, a URL that is not https, a URL that is not its own `new URL(u).href` (the form that is
 * keyed, saved and put into a note), and a URL of more than 2048 bytes once JSON-encoded; build the
 * list with `watchableUrl`. At most five fetches run at once, and every fetch has settled before the
 * first body is fingerprinted, so that the work on one page cannot use up another fetch's deadline.
 * Between two sources the event loop is yielded to, so that timers and socket callbacks are not held
 * up for the whole phase. It does not let another role's tick run: `runAgent` runs one tick at a
 * time, so the other roles wait for the whole check.
 */
export async function checkSources(
  fetcher: SourceFetcher,
  record: WatchRecord,
  urls: readonly string[],
  now: number,
): Promise<{ items: SourceCheck[]; next: WatchRecord["sources"] }> {
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("NOW_NOT_UNIX_SECONDS");
  const unique = [...new Set(urls)];
  if (unique.length > MAX_SOURCES) throw new RangeError("TOO_MANY_SOURCES");
  for (const url of unique) {
    let href: string;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") throw new RangeError("SOURCE_NOT_HTTPS");
      href = parsed.href;
    } catch (error) {
      throw error instanceof RangeError ? error : new RangeError("SOURCE_URL_INVALID");
    }
    if (href !== url) throw new RangeError("SOURCE_URL_NOT_CANONICAL");
    if (jsonBytes(href) > MAX_URL_BYTES) throw new RangeError("SOURCE_URL_TOO_LONG");
  }
  const earlier = (url: string) => (Object.hasOwn(record.sources, url) ? record.sources[url] : undefined);

  // Phase 1: read. Only waiting happens here; nothing is fingerprinted yet.
  const answers: (Awaited<ReturnType<SourceFetcher>> | "threw")[] = new Array(unique.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < unique.length) {
      const index = cursor++;
      const url = unique[index]!;
      const before = earlier(url);
      const validators: Validators =
        before?.finalUrl === undefined
          ? {}
          : {
              ...(before.etag !== undefined ? { etag: before.etag } : {}),
              ...(before.lastModified !== undefined ? { lastModified: before.lastModified } : {}),
              finalUrl: before.finalUrl,
            };
      try {
        answers[index] = await fetcher(url, validators);
      } catch {
        // A fetcher should not throw; if it does, the message is not kept (it could name a secret).
        answers[index] = "threw";
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_FETCHES, unique.length) }, worker));

  // Phase 2: compare, one source after the other.
  const next: WatchRecord["sources"] = {};
  const items: SourceCheck[] = [];
  const compare = (url: string, index: number): SourceCheck => {
    const before = earlier(url);
    if (before) next[url] = before;
    const unreachable = (code: string): SourceCheck => ({
      url,
      status: "UNREACHABLE",
      since: null,
      observedAt: now,
      fingerprint: before?.fingerprint ?? null,
      code,
    });
    const result = answers[index]!;
    if (result === "threw") return unreachable("FETCHER_FAILED");
    if (result.status === "error") return unreachable(result.code);
    if (result.status === 304) {
      if (!before) return unreachable("UNEXPECTED_304");
      next[url] = { ...before, checkedAt: now };
      return { url, status: "UNCHANGED", since: null, observedAt: now, fingerprint: before.fingerprint };
    }
    // A custom fetcher's media type must be one that loadState will accept when Task 3 saves it.
    const mediaType = mediaTypeOf(result.mediaType);
    const print = fingerprint(normalizeForFingerprint(result.bytes, mediaType, result.charset));
    next[url] = {
      fingerprint: print,
      // Only what loadState will accept again: a custom fetcher's unquoted ETag must not make the next start fail.
      ...(isEtag(result.etag) ? { etag: result.etag } : {}),
      ...(isLastModified(result.lastModified) ? { lastModified: result.lastModified } : {}),
      ...(isCanonicalHttpsUrl(result.finalUrl) ? { finalUrl: result.finalUrl } : {}),
      checkedAt: now,
    };
    if (!before) return { url, status: "NEW", since: null, observedAt: now, fingerprint: print, raw: result.bytes, mediaType };
    if (before.fingerprint === print) return { url, status: "UNCHANGED", since: null, observedAt: now, fingerprint: print, mediaType };
    return {
      url,
      status: "CHANGED",
      // Never after the observation, even if the saved time came from a clock that has since stepped back.
      since: Math.min(before.checkedAt, now),
      observedAt: now,
      fingerprint: print,
      raw: result.bytes,
      mediaType,
    };
  };
  for (const [index, url] of unique.entries()) {
    items.push(compare(url, index));
    // Fingerprinting one page can take a while; let pending timers and I/O run before the next. No other role's tick runs here.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return { items, next };
}

// -- The decision -----------------------------------------------------------------------------

/**
 * Whether this window needs the expensive step. It analyses when the agent has no earlier forecast
 * of the market, when a source changed (or a source is new to an agent that already has a forecast:
 * a URL was added), or when the last analysis is at least `heartbeatSeconds` old, or lies in the
 * future (a clock that was wrong when it was saved must not switch the heartbeat off); otherwise it
 * carries the earlier forecast forward. A source that could not be read never triggers an analysis.
 * It has no "skip": a caller that has no model view handles that itself. A `heartbeatSeconds` that
 * is not a finite positive number is a bug in the caller and throws a `RangeError`.
 */
export function decideUpdate(input: {
  prior: WatchRecord["prior"];
  items: readonly Pick<SourceCheck, "status">[];
  now: number;
  heartbeatSeconds: number;
}): { action: "analyse"; reason: "cold_start" | "change" | "heartbeat" } | { action: "carry_forward" } {
  const { prior, items, now, heartbeatSeconds } = input;
  if (!Number.isFinite(heartbeatSeconds) || heartbeatSeconds <= 0) throw new RangeError("HEARTBEAT_NOT_POSITIVE");
  if (!prior) return { action: "analyse", reason: "cold_start" };
  if (items.some((item) => item.status === "CHANGED" || item.status === "NEW")) return { action: "analyse", reason: "change" };
  if (now < prior.analysedAt || now - prior.analysedAt >= heartbeatSeconds) return { action: "analyse", reason: "heartbeat" };
  return { action: "carry_forward" };
}
