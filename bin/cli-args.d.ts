export function resolveDependencyBin(packageRoot: string, packageName: string): string;
export function parseShoalArgs(argv: string[]): {
  dir: string | undefined;
  envFile: string | undefined;
  rest: string[];
};
export function printHelp(): void;
