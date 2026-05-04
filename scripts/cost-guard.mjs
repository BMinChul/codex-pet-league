import { closeStorage, loadState, storageStatus } from "../src/storage/jsonStore.js";
import { summarizeCostState } from "./ops-summary.mjs";

const jsonOnly = process.argv.includes("--json");

try {
  const state = await loadState();
  const summary = summarizeCostState(state);
  if (jsonOnly) {
    console.log(JSON.stringify({ ...summary, storage: storageStatus() }, null, 2));
  } else {
    printSummary(summary);
  }
  if (summary.status === "critical") process.exitCode = 1;
} finally {
  await closeStorage();
}

function printSummary(summary) {
  console.log(`cost guard ${summary.status}`);
  for (const check of summary.checks) {
    const prefix = check.level === "ok" ? "ok" : check.level;
    console.log(
      `${prefix}: ${check.name}=${check.value} warn=${check.warning} critical=${check.critical} (${check.description})`,
    );
  }
  if (summary.status === "ok") {
    console.log("cost guard ok: no configured usage threshold is above warning.");
  } else if (summary.status === "warning") {
    console.log("warning: review usage before enabling overages or increasing provider quotas.");
  } else {
    console.log("critical: pause risky traffic paths, review provider dashboards, and run an incident pack.");
  }
}
