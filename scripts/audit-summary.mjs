import { auditState } from "../src/domain/audit.js";
import { closeStorage, loadState, storageStatus } from "../src/storage/jsonStore.js";

const jsonOnly = process.argv.includes("--json");

try {
  const state = await loadState();
  const audit = auditState(state);
  const highOrCritical = audit.findings.filter((finding) => finding.severity === "high" || finding.severity === "critical");
  const summary = {
    generated_at: new Date().toISOString(),
    ok: audit.ok,
    counts: audit.counts,
    finding_count: audit.findings.length,
    high_or_critical_count: highOrCritical.length,
    findings_by_code: countBy(audit.findings, (finding) => `${finding.code}|${finding.severity}`),
    high_or_critical_samples: highOrCritical.slice(0, 25).map((finding) => ({
      code: finding.code,
      severity: finding.severity,
      message: finding.message,
    })),
    storage: storageStatus(),
  };
  if (jsonOnly) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printSummary(summary);
  }
  if (!audit.ok) process.exitCode = 1;
} finally {
  await closeStorage();
}

function printSummary(summary) {
  console.log(`audit summary ${summary.ok ? "ok" : "failed"}`);
  console.log(`findings=${summary.finding_count} high_or_critical=${summary.high_or_critical_count}`);
  for (const [key, count] of Object.entries(summary.findings_by_code).sort((left, right) => right[1] - left[1])) {
    console.log(`${key}=${count}`);
  }
  for (const finding of summary.high_or_critical_samples) {
    console.log(`${finding.severity}: ${finding.code}: ${finding.message}`);
  }
}

function countBy(items = [], keyFn) {
  return items.reduce((counts, item) => {
    const key = keyFn(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}
