export interface PlannedWindow {
  horizonType: "DAILY" | "PRE_CLOSE";
  scheduledAt: Date;
  openAt: Date;
  deadline: Date;
}

/**
 * When the PRE_CLOSE window ends before a market closes and how long it stays open. This is a
 * platform scheduling setting, not a protocol parameter: short alpha markets need a PRE_CLOSE
 * window inside a few minutes. DAILY windows always close at UTC midnight and open 30 minutes before.
 */
export interface WindowSchedule {
  preCloseLeadSeconds: number;
  openSeconds: number;
}
export const DEFAULT_WINDOW_SCHEDULE: WindowSchedule = {
  preCloseLeadSeconds: 3600,
  openSeconds: 1800,
};
const DAILY_OPEN_SECONDS = 1800;
const DAY_MS = 86_400_000;

/** Both positive integers, and a window is no longer than the lead before the close. */
export function assertWindowSchedule(schedule: WindowSchedule): void {
  const { preCloseLeadSeconds: lead, openSeconds: open } = schedule;
  if (
    !Number.isSafeInteger(lead) ||
    !Number.isSafeInteger(open) ||
    lead <= 0 ||
    open <= 0 ||
    open > lead
  )
    throw new Error("INVALID_FORECAST_WINDOW_SCHEDULE");
}

export function plannedWindows(input: {
  closeAt: Date;
  now: Date;
  schedule?: WindowSchedule;
}): PlannedWindow[] {
  const schedule = input.schedule ?? DEFAULT_WINDOW_SCHEDULE;
  assertWindowSchedule(schedule);
  const now = input.now.getTime(),
    close = input.closeAt.getTime();
  const result: PlannedWindow[] = [];
  const add = (
    horizonType: PlannedWindow["horizonType"],
    time: number,
    openSeconds: number,
  ) => {
    result.push({
      horizonType,
      scheduledAt: new Date(time),
      openAt: new Date(time - openSeconds * 1000),
      deadline: new Date(time),
    });
  };
  for (
    let time = (Math.floor(now / DAY_MS) + 1) * DAY_MS;
    time < close;
    time += DAY_MS
  )
    add("DAILY", time, DAILY_OPEN_SECONDS);
  const preClose = close - schedule.preCloseLeadSeconds * 1000;
  if (now < preClose) add("PRE_CLOSE", preClose, schedule.openSeconds);
  return result.sort(
    (a, b) =>
      a.scheduledAt.getTime() - b.scheduledAt.getTime() ||
      a.horizonType.localeCompare(b.horizonType),
  );
}
