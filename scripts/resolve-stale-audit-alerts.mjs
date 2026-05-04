import { createHash } from "node:crypto";
import { auditState } from "../src/domain/audit.js";
import { closeStorage, loadState, saveState, storageStatus } from "../src/storage/jsonStore.js";

const apply = process.argv.includes("--apply");

try {
  const state = await loadState();
  const audit = auditState(state);
  const activeAuditDedupeKeys = new Set(
    audit.findings
      .filter((finding) => finding.severity === "high" || finding.severity === "critical")
      .map((finding) => auditDedupeKey(finding)),
  );
  const now = new Date().toISOString();
  const staleAlerts = (state.abuseAlerts ?? []).filter(
    (alert) =>
      alert.status === "open" &&
      String(alert.dedupe_key ?? "").startsWith("audit:") &&
      !activeAuditDedupeKeys.has(alert.dedupe_key),
  );
  if (apply) {
    for (const alert of staleAlerts) {
      alert.status = "resolved";
      alert.resolved_at = now;
      alert.resolution_reason = "audit_finding_cleared";
    }
    await saveState(state);
  }
  console.log(
    JSON.stringify(
      {
        generated_at: now,
        applied: apply,
        storage: storageStatus(),
        audit_ok: audit.ok,
        active_audit_findings: activeAuditDedupeKeys.size,
        stale_open_audit_alerts: staleAlerts.length,
      },
      null,
      2,
    ),
  );
} finally {
  await closeStorage();
}

function auditDedupeKey(finding) {
  return `audit:${finding.code}:${createHash("sha256").update(finding.message).digest("hex").slice(0, 12)}`;
}
