import type { TargetConfig } from "./types";
import { exampleConfig } from "./example";
import { noopTarget } from "./noop";

const TARGETS: Record<string, TargetConfig> = {
  "example": exampleConfig,
  "none": noopTarget,
};

export function loadTarget(name: string): TargetConfig {
  const target = TARGETS[name];
  if (!target) {
    console.warn(`[target] "${name}" not found, falling back to noop`);
    return noopTarget;
  }
  return target;
}
