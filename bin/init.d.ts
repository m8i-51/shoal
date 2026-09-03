export interface ProviderOption {
  value: string;
  label: string;
  hint?: string;
  defaultModel: string | null;
}
export const PROVIDERS: ProviderOption[];
export function renderWeeklyWorkflow(stagingUrl: string): string;
export function parseEnv(content: string): Record<string, string>;
export function updateEnvFile(
  envPath: string,
  newKeys: Record<string, string>,
  removeKeys: readonly string[],
): void;
export function runInit(cwd: string): Promise<void>;
export function runConfig(cwd: string): Promise<void>;
