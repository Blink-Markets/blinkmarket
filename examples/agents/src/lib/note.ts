// The forecast note: the JSON document that a signed forecast's contentHash names. This file builds
// its bytes (a fresh salt, the limits of the schema) and decides which changed sources may be
// archived. The platform never reads a note; a reader parses it with `parseForecastNote`.
import { randomBytes } from "node:crypto";
import {
  FORECAST_NOTE_MAX_BYTES,
  FORECAST_NOTE_MAX_EVIDENCE,
  FORECAST_NOTE_MAX_ITEM_NOTE_CHARS,
  FORECAST_NOTE_MAX_SUMMARY_CHARS,
  FORECAST_NOTE_SCHEMA,
  ForecastNoteItem,
  parseForecastNote,
} from "@blink/client";
import type { Hex } from "viem";

/** The media types `/v1/content` stores; any other gets `415`. */
export const SNAPSHOT_MEDIA_TYPES = ["application/json", "text/plain", "text/csv", "text/html", "application/pdf"] as const;
/** The largest object `/v1/content` stores: 1 MiB. */
export const SNAPSHOT_MAX_BYTES = 1_048_576;

/** Why a changed source's bytes are not archived, or null when they may be. */
export function snapshotRefusal(mediaType: string, size: number): "MEDIA_TYPE" | "TOO_LARGE" | "EMPTY" | null {
  if (!(SNAPSHOT_MEDIA_TYPES as readonly string[]).includes(mediaType)) return "MEDIA_TYPE";
  if (size === 0) return "EMPTY";
  return size > SNAPSHOT_MAX_BYTES ? "TOO_LARGE" : null;
}

/** 32 random bytes, new for every note: the note's hash is then not guessable from the previous note. */
export const newSalt = (): Hex => ("0x" + randomBytes(32).toString("hex")) as Hex;

export type NoteItem = {
  url: string;
  status: "NEW" | "CHANGED" | "UNCHANGED" | "UNREACHABLE";
  since: number | null;
  observedAt: number;
  fingerprint: Hex | null;
  snapshot: Hex | null;
  note: string;
};

export type NoteInput = {
  kind: "analysis" | "carry_forward";
  /** The fields of the signed Forecast that identify the answer. */
  subject: { marketId: string; markets: string; forecaster: string; horizon: number; scheduledAt: number };
  salt: Hex;
  checkedAt: number;
  priorDigest: Hex | null;
  summary: string;
  items: readonly NoteItem[];
};

/** The first `max` code points of `value`. */
const clip = (value: string, max: number) => {
  const points = Array.from(value);
  return points.length <= max ? value : points.slice(0, max).join("");
};

/** Items that may be dropped to make the note fit, least informative first. A CHANGED item never is. */
const DROP_ORDER: NoteItem["status"][] = ["UNCHANGED", "UNREACHABLE", "NEW"];

/**
 * The bytes of a note. It keeps the note within 20 items and 64 KiB by dropping UNCHANGED items
 * first, then UNREACHABLE, then NEW ones (the last of each kind first), then shortening the item
 * notes, then the summary. It never drops a CHANGED item for size: at most 20 URLs of at most 2048
 * bytes once JSON-encoded are watched, and with empty item notes such a note is far below the limit.
 * An item that is not CHANGED and that the note schema refuses is dropped at the start, so that
 * one odd source never costs the window its answer.
 * The result is checked with `parseForecastNote`; a note that does not parse is a bug and throws.
 */
export function buildNote(input: NoteInput): Uint8Array {
  // An item that the schema refuses is dropped unless it is CHANGED; a CHANGED one that fails is a bug (see the end).
  let items = input.items
    .map((item) => ({ ...item, note: clip(item.note, FORECAST_NOTE_MAX_ITEM_NOTE_CHARS) }))
    .filter((item) => item.status === "CHANGED" || ForecastNoteItem.safeParse(item).success);
  let summary = clip(input.summary, FORECAST_NOTE_MAX_SUMMARY_CHARS);
  const encode = () =>
    new TextEncoder().encode(
      JSON.stringify({
        schema: FORECAST_NOTE_SCHEMA,
        kind: input.kind,
        marketId: input.subject.marketId,
        markets: input.subject.markets,
        forecaster: input.subject.forecaster,
        horizon: input.subject.horizon,
        scheduledAt: input.subject.scheduledAt,
        salt: input.salt,
        checkedAt: input.checkedAt,
        prior: input.priorDigest === null ? null : { digest: input.priorDigest },
        summary,
        evidence: items,
        detail: null,
      }),
    );
  const dropOne = (): boolean => {
    for (const status of DROP_ORDER) {
      let at = -1;
      items.forEach((item, i) => {
        if (item.status === status) at = i;
      });
      if (at !== -1) {
        items = items.filter((_, i) => i !== at);
        return true;
      }
    }
    return false;
  };
  while (items.length > FORECAST_NOTE_MAX_EVIDENCE) if (!dropOne()) break;
  let bytes = encode();
  while (bytes.length > FORECAST_NOTE_MAX_BYTES && dropOne()) bytes = encode();
  // Item notes, then the summary, are cut by halves until the note fits.
  for (let limit = FORECAST_NOTE_MAX_ITEM_NOTE_CHARS; bytes.length > FORECAST_NOTE_MAX_BYTES && limit > 0; ) {
    limit = Math.floor(limit / 2);
    items = items.map((item) => ({ ...item, note: clip(item.note, limit) }));
    bytes = encode();
  }
  for (let limit = FORECAST_NOTE_MAX_SUMMARY_CHARS; bytes.length > FORECAST_NOTE_MAX_BYTES && limit > 0; ) {
    limit = Math.floor(limit / 2);
    summary = clip(summary, limit);
    bytes = encode();
  }
  const parsed = parseForecastNote(bytes);
  if (!parsed.ok) throw new Error("NOTE_INVALID");
  return bytes;
}
