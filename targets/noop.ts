import type { TargetConfig } from "./types";

export const noopTarget: TargetConfig = {
  appTools: [],
  execute: async () => ({ error: "no API tools configured for this target" }),
};
