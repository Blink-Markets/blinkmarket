import { readFile } from "node:fs/promises";
import { keccak256, toBytes } from "viem";
import {
  ModelCallError,
  type ModelGateway,
  type ModelRate,
} from "@blink/ports";
import { fixtureModelGateway } from "./fixture-model-gateway.js";

// A JSON file of canned model answers (REPLAY and local runs; no network, no provider). The format
// is documented in fixtures/replay/models/README.md.
const EVIDENCE_IDS = '"$EVIDENCE_IDS"';
const EVIDENCE_LINE =
  /^EVIDENCE_ID: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/gim;
const invalid = () => new Error("INVALID_MODEL_FIXTURES");

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (isObject(value) || Array.isArray(value)) return JSON.stringify(value);
  throw invalid();
};
const micros = (value: unknown): bigint => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
    throw invalid();
  return BigInt(value);
};
const hex32 = (value: unknown): string => {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value))
    throw invalid();
  return value.toLowerCase();
};

export function modelFixtureGateway(file: unknown): ModelGateway {
  if (!isObject(file) || !isObject(file["rates"])) throw invalid();
  const rates: Record<string, ModelRate> = {};
  for (const [model, rate] of Object.entries(file["rates"])) {
    if (!isObject(rate)) throw invalid();
    rates[model] = {
      inputUsdMicrosPerMillionTokens: micros(
        rate["inputUsdMicrosPerMillionTokens"],
      ),
      outputUsdMicrosPerMillionTokens: micros(
        rate["outputUsdMicrosPerMillionTokens"],
      ),
      perRequestUsdMicros: micros(rate["perRequestUsdMicros"]),
    };
  }
  const defaults = new Map<string, string>();
  if (file["defaults"] !== undefined) {
    if (!isObject(file["defaults"])) throw invalid();
    for (const [model, output] of Object.entries(file["defaults"]))
      defaults.set(model, text(output));
  }
  const exact = new Map<string, string>();
  if (file["outputs"] !== undefined) {
    if (!Array.isArray(file["outputs"])) throw invalid();
    for (const entry of file["outputs"] as unknown[]) {
      if (!isObject(entry) || typeof entry["model"] !== "string")
        throw invalid();
      exact.set(
        [
          entry["model"],
          hex32(entry["promptHash"]),
          hex32(entry["inputHash"]),
        ].join("|"),
        text(entry["output"]),
      );
    }
  }
  return fixtureModelGateway({
    provider: "fixture",
    rates,
    respond(request) {
      const key = [
        request.model,
        request.promptHash.toLowerCase(),
        keccak256(toBytes(request.input)),
      ].join("|");
      const output = exact.get(key) ?? defaults.get(request.model);
      if (output === undefined) return new ModelCallError("NOT_SENT");
      // Evidence ids are runtime uuids no static file can know; the answer cites those it was shown.
      const shown = [...request.input.matchAll(EVIDENCE_LINE)].map((m) =>
        JSON.stringify(m[1]),
      );
      return output.replaceAll(EVIDENCE_IDS, shown.join(","));
    },
  });
}

export async function loadModelFixtureGateway(
  path: string,
): Promise<ModelGateway> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw invalid();
  }
  return modelFixtureGateway(parsed);
}
