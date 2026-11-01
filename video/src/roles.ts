export type RoleId = "creator" | "maker" | "trader" | "forecaster" | "proposer" | "challenger" | "juror" | "keeper";
export const ROLES: readonly { id: RoleId; color: string; accessory: "antenna" | "bars" | "coin" | "goggles" | "flag" | "brows" | "cap" | "clock"; aspect: number; pitch: number }[] = [
  { id: "creator", color: "#2148b8", accessory: "antenna", aspect: 1, pitch: 523 },
  { id: "maker", color: "#7a5cd6", accessory: "bars", aspect: 1.3, pitch: 440 },
  { id: "trader", color: "#d4562f", accessory: "coin", aspect: 1, pitch: 659 },
  { id: "forecaster", color: "#2f9fd0", accessory: "goggles", aspect: 1, pitch: 784 },
  { id: "proposer", color: "#1d1c1a", accessory: "flag", aspect: 1, pitch: 587 },
  { id: "challenger", color: "#e3a62a", accessory: "brows", aspect: 1, pitch: 494 },
  { id: "juror", color: "#2f9e6e", accessory: "cap", aspect: 1, pitch: 392 },
  { id: "keeper", color: "#e0679a", accessory: "clock", aspect: 1, pitch: 698 },
];
