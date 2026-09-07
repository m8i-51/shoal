/**
 * `shoal doctor` — check the environment before spending a run on it.
 */
import { loadShoalEnv } from "./framework/load-env";
loadShoalEnv({ quiet: true });

import * as path from "path";
import { fileURLToPath } from "url";
import { runDoctor, formatDoctorReport } from "./framework/doctor";
import * as log from "./framework/log";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const report = runDoctor({ cwd: process.cwd(), packageRoot });

// print, not info: the report is the entire output of the command, so
// SHOAL_LOG_LEVEL=error must not blank it.
log.print(formatDoctorReport(report));

// Non-zero when something would actually stop a run, so CI can gate on it.
if (!report.ok) process.exitCode = 1;
