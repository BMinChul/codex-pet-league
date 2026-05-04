const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export function summarizeCostState(state, options = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const metrics = {
    auth_challenges_last_hour: countSince(state.authChallenges, now, HOUR_MS),
    auth_challenges_last_day: countSince(state.authChallenges, now, DAY_MS),
    pending_auth_challenges: (state.authChallenges ?? []).filter((challenge) => challenge.status === "pending").length,
    sessions_last_day: countSince(state.sessions, now, DAY_MS),
    asset_uploads_last_day: countSince(state.assets, now, DAY_MS),
    total_asset_bytes: sumAssetBytes(state.assets),
    open_asset_reports: (state.assetReports ?? []).filter((report) => report.status === "open").length,
    held_training_reports: (state.trainingReports ?? []).filter((report) => report.status === "review").length,
    open_abuse_alerts: (state.abuseAlerts ?? []).filter((alert) => alert.status === "open").length,
    active_battles: (state.battleRooms ?? []).filter((room) => room.status === "in_progress").length,
    waiting_match_tickets: (state.matchTickets ?? []).filter((ticket) => ticket.status === "waiting").length,
  };
  const checks = [
    thresholdCheck(
      "auth_challenges_last_hour",
      metrics.auth_challenges_last_hour,
      envNumber(env, "CODEX_PET_COST_AUTH_CHALLENGES_HOURLY_WARN", 10),
      envNumber(env, "CODEX_PET_COST_AUTH_CHALLENGES_HOURLY_CRITICAL", 30),
      "email-code requests in the last hour",
    ),
    thresholdCheck(
      "auth_challenges_last_day",
      metrics.auth_challenges_last_day,
      envNumber(env, "CODEX_PET_COST_AUTH_CHALLENGES_DAILY_WARN", 50),
      envNumber(env, "CODEX_PET_COST_AUTH_CHALLENGES_DAILY_CRITICAL", 150),
      "email-code requests in the last day",
    ),
    thresholdCheck(
      "asset_uploads_last_day",
      metrics.asset_uploads_last_day,
      envNumber(env, "CODEX_PET_COST_ASSET_UPLOADS_DAILY_WARN", 25),
      envNumber(env, "CODEX_PET_COST_ASSET_UPLOADS_DAILY_CRITICAL", 100),
      "asset uploads in the last day",
    ),
    thresholdCheck(
      "total_asset_bytes",
      metrics.total_asset_bytes,
      envNumber(env, "CODEX_PET_COST_ASSET_BYTES_TOTAL_WARN", 536870912),
      envNumber(env, "CODEX_PET_COST_ASSET_BYTES_TOTAL_CRITICAL", 1073741824),
      "stored atlas bytes across all assets",
    ),
    thresholdCheck(
      "open_abuse_alerts",
      metrics.open_abuse_alerts,
      envNumber(env, "CODEX_PET_COST_OPEN_ABUSE_ALERTS_WARN", 25),
      envNumber(env, "CODEX_PET_COST_OPEN_ABUSE_ALERTS_CRITICAL", 100),
      "open abuse alerts",
    ),
    thresholdCheck(
      "open_asset_reports",
      metrics.open_asset_reports,
      envNumber(env, "CODEX_PET_COST_OPEN_ASSET_REPORTS_WARN", 25),
      envNumber(env, "CODEX_PET_COST_OPEN_ASSET_REPORTS_CRITICAL", 100),
      "open asset reports",
    ),
  ];
  const findings = checks.filter((check) => check.level !== "ok");
  const status = findings.some((finding) => finding.level === "critical")
    ? "critical"
    : findings.some((finding) => finding.level === "warning")
      ? "warning"
      : "ok";
  return {
    generated_at: now.toISOString(),
    status,
    metrics,
    checks,
    findings,
  };
}

export function summarizeIncidentState(state, options = {}) {
  const now = options.now ?? new Date();
  const openAssetReports = (state.assetReports ?? []).filter((report) => report.status === "open");
  const moderationAssets = (state.assets ?? []).filter(
    (asset) => asset.safety_status !== "clear" || asset.visibility === "private" || openAssetReports.some((report) => report.asset_id === asset.id),
  );
  return {
    generated_at: now.toISOString(),
    counts: {
      accounts: (state.accounts ?? []).length,
      verified_accounts: (state.accounts ?? []).filter((account) => account.verified).length,
      pets: (state.pets ?? []).length,
      assets: (state.assets ?? []).length,
      battles: (state.battles ?? []).length,
      battle_rooms: (state.battleRooms ?? []).length,
      training_reports: (state.trainingReports ?? []).length,
      auth_challenges: (state.authChallenges ?? []).length,
      sessions: (state.sessions ?? []).length,
      risk_events: (state.riskEvents ?? []).length,
      abuse_alerts: (state.abuseAlerts ?? []).length,
    },
    queues: {
      active_battles: (state.battleRooms ?? []).filter((room) => room.status === "in_progress").length,
      waiting_match_tickets: (state.matchTickets ?? []).filter((ticket) => ticket.status === "waiting").length,
      held_training_reports: (state.trainingReports ?? []).filter((report) => report.status === "review").length,
      open_asset_reports: openAssetReports.length,
      moderation_assets: moderationAssets.length,
      open_abuse_alerts: (state.abuseAlerts ?? []).filter((alert) => alert.status === "open").length,
    },
    recent_activity: {
      auth_challenges_last_hour: countSince(state.authChallenges, now, HOUR_MS),
      auth_challenges_last_day: countSince(state.authChallenges, now, DAY_MS),
      sessions_last_day: countSince(state.sessions, now, DAY_MS),
      assets_last_day: countSince(state.assets, now, DAY_MS),
      battles_last_day: countSince(state.battleRooms, now, DAY_MS) + countSince(state.battles, now, DAY_MS),
      training_reports_last_day: countSince(state.trainingReports, now, DAY_MS),
    },
    latest_ops_job: summarizeOpsJob((state.opsJobs ?? [])[0]),
    open_abuse_alerts: (state.abuseAlerts ?? [])
      .filter((alert) => alert.status === "open")
      .slice(0, 20)
      .map(summarizeAbuseAlert),
    held_training_reports: (state.trainingReports ?? [])
      .filter((report) => report.status === "review")
      .slice(0, 20)
      .map((report) => ({
        id: report.id,
        account_id: report.account_id,
        pet_id: report.pet_id,
        report_type: report.report_type,
        created_at: report.created_at,
      })),
    moderation_assets: moderationAssets.slice(0, 20).map((asset) => ({
      id: asset.id,
      owner_account_id: asset.owner_account_id,
      safety_status: asset.safety_status,
      visibility: asset.visibility,
      report_count: openAssetReports.filter((report) => report.asset_id === asset.id).length,
      created_at: asset.created_at,
      moderated_at: asset.moderated_at ?? null,
    })),
    recent_events: (state.events ?? []).slice(0, 40).map(summarizeEvent),
    recent_risk_events: (state.riskEvents ?? []).slice(0, 40).map(summarizeRiskEvent),
  };
}

function thresholdCheck(name, value, warning, critical, description) {
  const level = value >= critical ? "critical" : value >= warning ? "warning" : "ok";
  return { name, value, warning, critical, level, description };
}

function envNumber(env, name, fallback) {
  const value = Number(env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function countSince(items = [], now, windowMs) {
  const nowMs = now.getTime();
  return items.filter((item) => {
    const createdAt = item.created_at ?? item.createdAt ?? item.started_at ?? item.finished_at;
    const timestamp = Date.parse(createdAt);
    return Number.isFinite(timestamp) && timestamp <= nowMs && nowMs - timestamp <= windowMs;
  }).length;
}

function sumAssetBytes(assets = []) {
  return assets.reduce((total, asset) => total + safeNumber(asset.atlas_byte_length), 0);
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function summarizeOpsJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    started_at: job.started_at,
    finished_at: job.finished_at,
    matches_processed: job.matches_processed,
    settlements_reconciled: job.settlements_reconciled,
    abuse_alerts_created: job.abuse_alerts_created,
    high_findings: job.high_findings,
  };
}

function summarizeAbuseAlert(alert) {
  return {
    id: alert.id,
    type: alert.type,
    severity: alert.severity,
    status: alert.status,
    account_id: alert.account_id ?? null,
    created_at: alert.created_at,
  };
}

function summarizeEvent(event) {
  return {
    id: event.id,
    type: event.type,
    account_id: event.account_id ?? null,
    created_at: event.created_at,
    hash: event.hash,
    previous_hash: event.previous_hash,
    payload_keys: Object.keys(event.payload ?? {}).sort(),
  };
}

function summarizeRiskEvent(event) {
  return {
    id: event.id,
    type: event.type,
    severity: event.severity,
    score: event.score,
    account_id: event.account_id ?? null,
    created_at: event.created_at,
    metadata_keys: Object.keys(event.metadata ?? {}).sort(),
  };
}
