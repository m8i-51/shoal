import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { spawnRun } from "./runner.js";

export interface ScheduleConfig {
  enabled: boolean;
  dayOfWeek: number;   // 0=Sun 1=Mon ... 6=Sat
  hour: number;
  minute: number;
  lastRunDate: string | null;  // YYYY-MM-DD — prevents double-trigger
}

const DEFAULT_CONFIG: ScheduleConfig = {
  enabled: false,
  dayOfWeek: 1,
  hour: 9,
  minute: 0,
  lastRunDate: null,
};

function configPath(): string {
  return join(process.cwd(), "schedule.json");
}

export function loadSchedule(): ScheduleConfig {
  const p = configPath();
  if (!existsSync(p)) return { ...DEFAULT_CONFIG };
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(p, "utf-8")) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveSchedule(config: ScheduleConfig): void {
  writeFileSync(configPath(), JSON.stringify(config, null, 2), "utf-8");
}

export function startScheduler(): void {
  const check = () => {
    const config = loadSchedule();
    if (!config.enabled) return;

    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    // ±1 分のウィンドウで判定（interval のズレを吸収）
    const nowMin = now.getDay() * 1440 + now.getHours() * 60 + now.getMinutes();
    const targetMin = config.dayOfWeek * 1440 + config.hour * 60 + config.minute;
    const diff = nowMin - targetMin;

    if (diff >= 0 && diff < 2 && config.lastRunDate !== today) {
      console.log(`[scheduler] triggering scheduled run (${today})`);
      spawnRun({});
      saveSchedule({ ...config, lastRunDate: today });
    }
  };

  // 次の分の頭に揃えてから毎分チェック
  const msToNextMinute = 60_000 - (Date.now() % 60_000);
  setTimeout(() => {
    check();
    setInterval(check, 60_000);
  }, msToNextMinute);
}
