import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { CREATION_GROUND, parseMarketSpec, type MarketSpecV02 } from "@blink/client";
import { ROLE_NAMES, type RoleName } from "./env.ts";

export type Belief = {
  outcome?: "YES" | "NO";
  probabilityBps?: number;
  objection?: { ground: keyof typeof CREATION_GROUND; evidence: string };
  appeal?: boolean;
};
export type WorldQuestion = {
  spec: MarketSpecV02;
  closeInSeconds: number;
  maxPairs: number;
  /** https source URL -> file, relative to the world file; what an agent "fetches" for that URL. */
  sources?: Record<string, string>;
};
export type WorldAgent = {
  roles: RoleName[];
  creates?: string[];
  claimsSuggestions?: boolean;
  beliefs: Record<string, Belief>;
};
/** The scripted world every fixture model reads: questions, suggestions and what each agent believes. */
export type World = {
  /** The directory of the world file; source files resolve against it. */
  dir: string;
  questions: Record<string, WorldQuestion>;
  suggestions: Record<string, string>;
  agents: Record<string, WorldAgent>;
};

const invalid = (path: string, reason: string) =>
  new Error(`WORLD_INVALID: ${path}: ${reason}`);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
function record(v: unknown, path: string): Record<string, unknown> {
  if (!isRecord(v)) throw invalid(path, "must be an object");
  return v;
}
function only(obj: Record<string, unknown>, path: string, allowed: readonly string[]) {
  for (const key of Object.keys(obj))
    if (!allowed.includes(key)) throw invalid(`${path}.${key}`, "unknown field");
}
function integer(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max)
    throw invalid(path, `must be an integer from ${min} to ${max}`);
  return v;
}

function parseQuestion(raw: unknown, path: string): WorldQuestion {
  const q = record(raw, path);
  only(q, path, ["spec", "closeInSeconds", "maxPairs", "sources"]);
  // The spec is checked by the same parser the platform uses, on the bytes it will be frozen as.
  const parsed = parseMarketSpec(new TextEncoder().encode(JSON.stringify(q.spec)));
  if (!parsed.ok) throw invalid(`${path}.spec`, parsed.reason);
  const sources: Record<string, string> = {};
  if (q.sources !== undefined)
    for (const [url, file] of Object.entries(record(q.sources, `${path}.sources`))) {
      if (!/^https:\/\//.test(url)) throw invalid(`${path}.sources.${url}`, "key must be an https URL");
      if (typeof file !== "string" || file === "")
        throw invalid(`${path}.sources.${url}`, "must be a file name");
      sources[url] = file;
    }
  return {
    spec: parsed.spec,
    closeInSeconds: integer(q.closeInSeconds, `${path}.closeInSeconds`, 1, 31_536_000),
    maxPairs: integer(q.maxPairs, `${path}.maxPairs`, 1, 1_000_000_000),
    ...(q.sources === undefined ? {} : { sources }),
  };
}

function parseBelief(raw: unknown, path: string): Belief {
  const b = record(raw, path);
  only(b, path, ["outcome", "probabilityBps", "objection", "appeal"]);
  const belief: Belief = {};
  if (b.outcome !== undefined) {
    if (b.outcome !== "YES" && b.outcome !== "NO") throw invalid(`${path}.outcome`, "must be YES or NO");
    belief.outcome = b.outcome;
  }
  if (b.probabilityBps !== undefined)
    belief.probabilityBps = integer(b.probabilityBps, `${path}.probabilityBps`, 0, 10_000);
  if (b.objection !== undefined) {
    const o = record(b.objection, `${path}.objection`);
    only(o, `${path}.objection`, ["ground", "evidence"]);
    if (typeof o.ground !== "string" || !Object.hasOwn(CREATION_GROUND, o.ground))
      throw invalid(`${path}.objection.ground`, "must be a creation ground");
    if (typeof o.evidence !== "string")
      throw invalid(`${path}.objection.evidence`, "must be a string");
    belief.objection = { ground: o.ground as keyof typeof CREATION_GROUND, evidence: o.evidence };
  }
  if (b.appeal !== undefined) {
    if (typeof b.appeal !== "boolean") throw invalid(`${path}.appeal`, "must be a boolean");
    belief.appeal = b.appeal;
  }
  return belief;
}

/** Validates a parsed world file. Hand written: an example cannot import the schema package. */
export function parseWorld(json: unknown, dir: string): World {
  const root = record(json, "world");
  only(root, "world", ["questions", "suggestions", "agents"]);
  const questions: Record<string, WorldQuestion> = {};
  const titles = new Set<string>();
  for (const [key, raw] of Object.entries(record(root.questions, "questions"))) {
    const question = parseQuestion(raw, `questions.${key}`);
    // Markets are matched to questions by title.
    if (titles.has(question.spec.title))
      throw invalid(`questions.${key}.spec.title`, "titles must be unique in a world");
    titles.add(question.spec.title);
    for (const file of Object.values(question.sources ?? {})) {
      const inside = relative(resolve(dir), resolve(dir, file));
      if (isAbsolute(file) || inside.startsWith("..") || isAbsolute(inside))
        throw invalid(`questions.${key}.sources`, `${file} is outside the world directory`);
    }
    questions[key] = question;
  }
  const known = (key: string, path: string) => {
    if (!Object.hasOwn(questions, key)) throw invalid(path, `unknown question ${key}`);
  };
  const suggestions: Record<string, string> = {};
  for (const [text, key] of Object.entries(record(root.suggestions, "suggestions"))) {
    if (typeof key !== "string") throw invalid(`suggestions.${text}`, "must be a question key");
    known(key, `suggestions.${text}`);
    suggestions[text] = key;
  }
  const agents: Record<string, WorldAgent> = {};
  for (const [name, raw] of Object.entries(record(root.agents, "agents"))) {
    const path = `agents.${name}`;
    const a = record(raw, path);
    only(a, path, ["roles", "creates", "claimsSuggestions", "beliefs"]);
    if (!Array.isArray(a.roles) || a.roles.some((r) => !ROLE_NAMES.includes(r as RoleName)))
      throw invalid(`${path}.roles`, "must list role names");
    const agent: WorldAgent = { roles: a.roles as RoleName[], beliefs: {} };
    if (a.creates !== undefined) {
      if (!Array.isArray(a.creates) || a.creates.some((k) => typeof k !== "string"))
        throw invalid(`${path}.creates`, "must list question keys");
      for (const key of a.creates as string[]) known(key, `${path}.creates`);
      agent.creates = a.creates as string[];
    }
    if (a.claimsSuggestions !== undefined) {
      if (typeof a.claimsSuggestions !== "boolean")
        throw invalid(`${path}.claimsSuggestions`, "must be a boolean");
      agent.claimsSuggestions = a.claimsSuggestions;
    }
    for (const [key, belief] of Object.entries(record(a.beliefs, `${path}.beliefs`))) {
      known(key, `${path}.beliefs.${key}`);
      agent.beliefs[key] = parseBelief(belief, `${path}.beliefs.${key}`);
    }
    agents[name] = agent;
  }
  return { dir, questions, suggestions, agents };
}

export async function loadWorld(path: string): Promise<World> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("WORLD_UNREADABLE");
  }
  return parseWorld(json, dirname(resolve(path)));
}
