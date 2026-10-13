export interface PlannedWindow {
  horizonType: "DAILY" | "PRE_CLOSE";
  scheduledAt: Date;
  openAt: Date;
  deadline: Date;
}

export function plannedWindows(input: {
  closeAt: Date;
  now: Date;
}): PlannedWindow[] {
  const now = input.now.getTime(),
    close = input.closeAt.getTime();
  const result: PlannedWindow[] = [];
  const add = (horizonType: PlannedWindow["horizonType"], time: number) => {
    result.push({
      horizonType,
      scheduledAt: new Date(time),
      openAt: new Date(time - 1_800_000),
      deadline: new Date(time),
    });
  };
  for (
    let time = (Math.floor(now / 86_400_000) + 1) * 86_400_000;
    time < close;
    time += 86_400_000
  )
    add("DAILY", time);
  if (now < close - 3_600_000) add("PRE_CLOSE", close - 3_600_000);
  return result.sort(
    (a, b) =>
      a.scheduledAt.getTime() - b.scheduledAt.getTime() ||
      a.horizonType.localeCompare(b.horizonType),
  );
}

export function snapshotPriceBase(input: {
  probabilitySumMillionths: number;
  side: "YES" | "NO";
}): number {
  const sum = input.probabilitySumMillionths;
  if (!Number.isInteger(sum) || sum < 0 || sum > 2_000_000)
    throw new Error("INVALID_PROBABILITY_SUM");
  return Math.ceil((input.side === "YES" ? sum : 2_000_000 - sum) / 200);
}
