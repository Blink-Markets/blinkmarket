export type RunRecord = {
  schema: "blink.video-run/1";
  source: "pnpm alpha:autonomous";
  commit: string;
  capturedOn: string;
  chainId: 84532;
  durationSeconds: number;
  scenarios: readonly { name: string; status: "pass"; durationSeconds: number }[];
  roster: readonly { agent: string; roles: readonly string[] }[];
  events: readonly { t: number; agent: string; event: string; market?: string }[];
};
