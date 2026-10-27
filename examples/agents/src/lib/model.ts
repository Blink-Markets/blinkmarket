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

/** What a role asks its judgement. A real model implements this; CI uses `fixtureModel`. */
export interface Model {
  questions(): Promise<QuestionDraft[]>;
  fromSuggestion(text: string): Promise<QuestionDraft | null>;
  probabilityBps(m: MarketView): Promise<number | null>;
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
 * never by a stated outcome. With no belief and no source the answer is null.
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
    async probabilityBps(m) {
      const found = questionOf(m);
      return (found && beliefs[found[0]]?.probabilityBps) ?? null;
    },
    async outcome(m) {
      const found = questionOf(m);
      if (!found) return null;
      if (m.spec.class === "A") {
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
