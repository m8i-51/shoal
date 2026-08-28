/**
 * load-env.ts
 * カレントディレクトリ（または --env-file / SHOAL_ENV_FILE）の .env を読み、
 * どのファイルを読んだか（読めなかったか）を起動時に明示する。
 */
import { config as loadDotenv } from "dotenv";
import * as fs from "fs";
import * as path from "path";

const EMPTY_AWS_KEYS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"] as const;

export interface LoadShoalEnvOptions {
  envFile?: string;
  cwd?: string;
  override?: boolean;
  logger?: (message: string) => void;
  quiet?: boolean;
}

export interface LoadShoalEnvResult {
  cwd: string;
  path: string;
  loaded: boolean;
  injected: number;
  strippedAwsKeys: string[];
}

function log(opts: LoadShoalEnvOptions, message: string): void {
  if (opts.quiet) return;
  (opts.logger ?? console.log)(message);
}

export function resolveEnvPath(opts: LoadShoalEnvOptions = {}): string {
  const cwd = opts.cwd ?? process.cwd();
  if (opts.envFile && opts.envFile.trim()) {
    return path.resolve(cwd, opts.envFile.trim());
  }
  const fromEnv = process.env.SHOAL_ENV_FILE?.trim();
  if (fromEnv) return path.resolve(cwd, fromEnv);
  return path.join(cwd, ".env");
}

/** 空文字の AWS キーは認証チェーンを壊すので削除する */
export function stripEmptyAwsCredentials(
  env: NodeJS.ProcessEnv = process.env,
): Array<(typeof EMPTY_AWS_KEYS)[number]> {
  const stripped: Array<(typeof EMPTY_AWS_KEYS)[number]> = [];
  for (const key of EMPTY_AWS_KEYS) {
    if (typeof env[key] === "string" && env[key]!.trim() === "") {
      delete env[key];
      stripped.push(key);
    }
  }
  return stripped;
}

function warnMissingLlmCredentials(opts: LoadShoalEnvOptions): void {
  const provider = (process.env.LLM_PROVIDER ?? "anthropic").trim().toLowerCase() || "anthropic";
  switch (provider) {
    case "bedrock":
    case "ollama":
    case "lm-studio":
    case "codex":
    case "claude-cli":
      return;
    case "anthropic":
      if (process.env.ANTHROPIC_API_KEY?.trim()) return;
      break;
    default:
      if (process.env.LLM_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim()) return;
  }
  log(
    opts,
    `[env] warning: no API key found for provider "${provider}". Requests will fail until credentials are set in .env`,
  );
}

export function loadShoalEnv(opts: LoadShoalEnvOptions = {}): LoadShoalEnvResult {
  const cwd = opts.cwd ?? process.cwd();
  const envPath = resolveEnvPath({ ...opts, cwd });
  const exists = fs.existsSync(envPath);

  log(opts, `[env] working directory: ${cwd}`);

  const awsSnapshot: Partial<Record<(typeof EMPTY_AWS_KEYS)[number], string | undefined>> = {};
  for (const key of EMPTY_AWS_KEYS) awsSnapshot[key] = process.env[key];

  let loaded = false;
  let injected = 0;

  if (!exists) {
    log(opts, `[env] no .env found at ${envPath} (0 variables injected)`);
    log(
      opts,
      "[env] hint: run shoal from the directory that contains .env, or pass --dir <path> / --env-file <path>",
    );
  } else {
    const result = loadDotenv({ path: envPath, override: opts.override ?? true });
    if (result.error && !result.parsed) {
      log(opts, `[env] failed to load ${envPath}: ${result.error.message}`);
    } else {
      injected = Object.keys(result.parsed ?? {}).length;
      loaded = true;
      log(opts, `[env] loaded ${envPath} (${injected} variable${injected === 1 ? "" : "s"})`);
      if (path.resolve(path.dirname(envPath)) !== path.resolve(cwd)) {
        log(
          opts,
          "[env] note: logs, findings, and test-accounts are resolved from the working directory, not the .env location",
        );
      }
    }
  }

  const strippedAwsKeys = stripEmptyAwsCredentials();
  for (const key of strippedAwsKeys) {
    const prev = awsSnapshot[key];
    if (typeof prev === "string" && prev.trim() !== "") {
      process.env[key] = prev;
    }
  }
  if (strippedAwsKeys.length > 0) {
    log(
      opts,
      `[env] warning: empty ${strippedAwsKeys.join(", ")} ignored so the default AWS credential chain can be used`,
    );
  }
  warnMissingLlmCredentials(opts);

  return { cwd, path: envPath, loaded, injected, strippedAwsKeys };
}
