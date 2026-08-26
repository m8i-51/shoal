import type { Express } from "express";
import * as path from "path";
import { fileURLToPath } from "url";
import { createBenchApp } from "./app";
import { createFormsBenchApp } from "./forms-app";

const benchDir = path.dirname(fileURLToPath(import.meta.url));

export interface BenchVariant {
  id: string;
  description: string;
  defaultPort: number;
  labelsFile: string;
  createApp: () => Express;
}

export const BENCH_VARIANTS: Record<string, BenchVariant> = {
  store: {
    id: "store",
    description: "Store app with cart, admin, and navigation bugs",
    defaultPort: 4319,
    labelsFile: "labels.json",
    createApp: createBenchApp,
  },
  forms: {
    id: "forms",
    description: "Support forms app with validation and error-handling bugs",
    defaultPort: 4320,
    labelsFile: "labels-forms.json",
    createApp: createFormsBenchApp,
  },
};

export function resolveBenchVariant(variantId = process.env.BENCH_VARIANT ?? "store"): BenchVariant {
  const variant = BENCH_VARIANTS[variantId];
  if (!variant) {
    const available = Object.keys(BENCH_VARIANTS).join(", ");
    throw new Error(`Unknown BENCH_VARIANT "${variantId}". Available: ${available}`);
  }
  return variant;
}

export function labelsPathForVariant(variant: BenchVariant): string {
  return path.join(benchDir, variant.labelsFile);
}
