import { QUESTION_CLASS, templateIdFor } from "../protocol-constants.ts";

// keccak256 of the exact bytes of ./gm-lt-v1.ts, parser and outcome function included.
// tests/client-agent-kit.test.ts recomputes it. The parser is part of the template: a change to
// it is a new template (a new file, a new hash, a new templateId), never an edit of this one.
const GM_LT_V1_PARSER_HASH =
  "0x0eced6cdcd4c8bf1f4a69799383467615b9eb3992e446c5e6ee4cde2f33a4f80";
// The parser bytes uploaded to the content store, which names content by its keccak256, so this
// path resolves against whichever API an agent uses.
const GM_LT_V1_URI = `/v1/content/${GM_LT_V1_PARSER_HASH}`;

/** The first class A template: the GAAP gross margin is below a threshold in basis points. */
export const GM_LT_V1 = {
  cls: QUESTION_CLASS.A_COMPUTABLE,
  parserHash: GM_LT_V1_PARSER_HASH,
  uri: GM_LT_V1_URI,
  templateId: templateIdFor(
    QUESTION_CLASS.A_COMPUTABLE,
    GM_LT_V1_PARSER_HASH,
    GM_LT_V1_URI,
  ),
} as const;

export {
  gmLtV1Outcome,
  parseGrossMargin,
  type GrossMarginResult,
} from "./gm-lt-v1.ts";
