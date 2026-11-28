import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CREATION_GROUND, gmLtV1Outcome, type MarketSpecV02 } from "@blink/client";
import type { Hex } from "viem";
import type { World, WorldQuestion } from "./world.ts";

export type MarketView = { marketId: bigint; specHash: Hex; spec: MarketSpecV02 };
export type QuestionDraft = {
  key: string;
  spec: MarketSpecV02;
  closeInSeconds: number;
  maxPairs: number;
};

/**
 * A source that is new to the agent or changed since its last check, as the model is told about it.
 * `bytes` are the page as it was read: untrusted input, which a model must treat as data and never
 * as instructions (a page can carry text written to steer it).
 */
export type SourceChange = {
  url: string;
  status: "NEW" | "CHANGED";
  /** Unix seconds of the previous successful check; null for NEW. */
  since: number | null;
  /** Unix seconds of this check. */
  observedAt: number;
  mediaType: string;
  bytes: Uint8Array;
};

/** What a role asks its judgement. A real model implements this; CI uses `fixtureModel`. */
export interface Model {
  questions(): Promise<QuestionDraft[]>;
  fromSuggestion(text: string): Promise<QuestionDraft | null>;
  probabilityBps(m: MarketView): Promise<number | null>;
  /**
   * The URLs the forecaster checks for a market before each window. Optional; the default is the
   * spec's `sources`. At most 20 are used, those of the spec first.
   */
  watchList?(m: MarketView): Promise<string[]> | string[];
  /**
   * The expensive step: a new forecast given the agent's earlier one and what changed. Optional;
   * the default is `probabilityBps(m)` with an empty summary. Null means no view: nothing is
   * submitted in this window.
   */
  revise?(
    m: MarketView,
    input: { prior: { probabilityBps: number; analysedAt: number } | null; changes: SourceChange[] },
  ): Promise<{ probabilityBps: number; summary: string } | null>;
  outcome(m: MarketView): Promise<{ outcome: "YES" | "NO"; evidence: Uint8Array } | null>;
  creationObjection(
    m: MarketView,
  ): Promise<{ ground: keyof typeof CREATION_GROUND; evidence: Uint8Array } | null>;
  appeal(m: MarketView): Promise<boolean>;
}

const utf8 = (text: string) => new TextEncoder().encode(text);

/**
 * Answers from the world file, for this agent only: another agent's beliefs are never consulted. A
 * class A market is decided by the template over the source bytes (the world's "fetched" file),
 * never by a stated outcome. An agent needs an explicit belief entry and a source to answer.
 */
export function fixtureModel(world: World, agentName: string): Model {
  const agent = world.agents[agentName];
  const beliefs = agent?.beliefs ?? {};
  const draft = (key: string): QuestionDraft => {
    const { spec, closeInSeconds, maxPairs } = world.questions[key]!;
    return { key, spec, closeInSeconds, maxPairs };
  };
  /** The question whose title the market carries, with its key. */
  const questionOf = (m: MarketView): [string, WorldQuestion] | undefined =>
    Object.entries(world.questions).find(([, q]) => q.spec.title === m.spec.title);
  const beliefOf = (m: MarketView): number | null => {
    const found = questionOf(m);
    return (found && beliefs[found[0]]?.probabilityBps) ?? null;
  };
  const sourceOf = async (q: WorldQuestion, spec: MarketSpecV02) => {
    const url = spec.sources.find((u) => q.sources && Object.hasOwn(q.sources, u));
    return url === undefined
      ? null
      : new Uint8Array(await readFile(join(world.dir, q.sources![url]!)));
  };

  return {
    async questions() {
      return (agent?.creates ?? []).map(draft);
    },
    async fromSuggestion(text) {
      const key = agent?.claimsSuggestions ? world.suggestions[text] : undefined;
      return key === undefined ? null : draft(key);
    },
    probabilityBps: async (m) => beliefOf(m),
    async watchList(m) {
      const found = questionOf(m);
      // Only for a market the agent has a belief about: a page it has no use for is not fetched.
      return found && Object.hasOwn(beliefs, found[0]) ? Object.keys(found[1].sources ?? {}) : [];
    },
    async revise(m) {
      // The agent's own belief, whatever changed and whatever the others believe.
      const bps = beliefOf(m);
      return bps === null ? null : { probabilityBps: bps, summary: "" };
    },
    async outcome(m) {
      const found = questionOf(m);
      if (!found) return null;
      if (m.spec.class === "A") {
        if (!Object.hasOwn(beliefs, found[0])) return null;
        const source = await sourceOf(found[1], m.spec);
        const outcome =
          source && m.spec.computation
            ? gmLtV1Outcome(new TextDecoder().decode(source), m.spec.computation.extraction)
            : null;
        return outcome === null ? null : { outcome, evidence: source! };
      }
      const outcome = beliefs[found[0]]?.outcome;
      return outcome === undefined
        ? null
        : { outcome, evidence: utf8(JSON.stringify({ title: m.spec.title, outcome })) };
    },
    async creationObjection(m) {
      const objection = beliefs[questionOf(m)?.[0] ?? ""]?.objection;
      return objection
        ? { ground: objection.ground, evidence: utf8(objection.evidence) }
        : null;
    },
    async appeal(m) {
      return beliefs[questionOf(m)?.[0] ?? ""]?.appeal === true;
    },
  };
}
