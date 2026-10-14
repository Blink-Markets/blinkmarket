export type GrossMarginResult =
  | {
      valueBps: number;
      locator: { start: number; end: number; excerpt: string };
    }
  | {
      ambiguous: true;
      reason: "NONE" | "MULTIPLE_VALUES" | "PRECISION" | "NON_GAAP_ONLY";
    };

export function parseGrossMargin(text: string): GrossMarginResult {
  const values: {
    valueBps: number;
    locator: { start: number; end: number; excerpt: string };
  }[] = [];
  let nonGaap = false,
    gaap = false,
    precision = false;
  const phrases = [
    ...text.matchAll(/\b(?:non[-\s\u2010-\u2014]+)?GAAP\s+gross\s+margin\b/gi),
  ];
  for (let i = 0; i < phrases.length; i++) {
    const phrase = phrases[i]!;
    if (/^non/i.test(phrase[0])) {
      nonGaap = true;
      continue;
    }
    gaap = true;
    const start = phrase.index!,
      after = start + phrase[0].length;
    // Do not borrow a percentage from a following GAAP/non-GAAP phrase.
    const tail = text.slice(after, phrases[i + 1]?.index);
    for (const percent of tail.matchAll(
      /(?<![\d.,])(-?\d+(?:\.\d+)?)\s*(?:%|％|percent\b)/gi,
    )) {
      if (percent.index > 80) break;
      const [whole, fraction = ""] = percent[1]!.split(".");
      if (fraction.length > 2) {
        precision = true;
        continue;
      }
      const magnitude =
        Math.abs(Number(whole)) * 100 + Number(fraction.padEnd(2, "0"));
      const valueBps = percent[1]!.startsWith("-") ? -magnitude : magnitude;
      // Suggestions persist integer basis points; unrepresentable input needs review.
      if (
        !Number.isSafeInteger(valueBps) ||
        valueBps < -2147483648 ||
        valueBps > 2147483647
      ) {
        precision = true;
        continue;
      }
      const end = after + percent.index + percent[0].length;
      values.push({
        valueBps,
        locator: { start, end, excerpt: text.slice(start, end) },
      });
    }
  }
  if (precision) return { ambiguous: true, reason: "PRECISION" };
  if (new Set(values.map((v) => v.valueBps)).size > 1)
    return { ambiguous: true, reason: "MULTIPLE_VALUES" };
  return (
    values[0] ?? {
      ambiguous: true,
      reason: nonGaap && !gaap ? "NON_GAAP_ONLY" : "NONE",
    }
  );
}
