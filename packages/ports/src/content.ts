import type { CONTENT_MEDIA_TYPES } from "@blink/schemas";

export type ContentMediaType = (typeof CONTENT_MEDIA_TYPES)[number];

export interface ContentObject {
  hash: string;
  size: number;
  mediaType: ContentMediaType;
}
export interface ContentStore {
  /**
   * Stores the bytes at `hash` (the caller computed keccak256(bytes)). Storing the same bytes again
   * returns the first record. A `suggestionId` that exists is linked to the hash in the same step.
   */
  put(input: {
    hash: string;
    bytes: Uint8Array;
    mediaType: ContentMediaType;
    uploader: string;
    suggestionId: string | null;
  }): Promise<ContentObject>;
  /** The record and its exact bytes, or null for an unknown hash. Throws if the stored bytes are damaged. */
  get(
    hash: string,
  ): Promise<{ object: ContentObject; bytes: Uint8Array } | null>;
}

export type SuggestionRecord = {
  id: string;
  text: string;
  sourceUrls: string[];
  createdAt: Date;
  /** Spec hashes whose bytes name this suggestion. */
  specHashes: string[];
  claimCount: number;
};
export interface SuggestionStore {
  add(input: { id: string; text: string; sourceUrls: string[] }): Promise<void>;
  get(id: string): Promise<SuggestionRecord | null>;
  /** Newest first. `after` is the `seq` of the last row already seen. */
  list(input: {
    after: string | null;
    limit: number;
  }): Promise<Array<SuggestionRecord & { seq: string }>>;
  /** false when this creator already claimed it; null when the suggestion is unknown. */
  claim(id: string, creator: string): Promise<boolean | null>;
}
