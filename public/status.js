const cards = document.querySelector("#statusCards");
const badge = document.querySelector("#statusBadge");
const raw = document.querySelector("#statusRaw");
const updatedAt = document.querySelector("#statusUpdatedAt");

refreshStatus();
window.setInterval(refreshStatus, 30_000);

async function refreshStatus() {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    const payload = await response.json();
    renderStatus(payload, response.ok);
  } catch (error) {
    renderFailure(error);
  }
}

function renderStatus(health, ok) {
  const serviceOk = ok && health.status === "ok";
  badge.textContent = serviceOk ? "Operational" : `Degraded: ${health.status ?? "unknown"}`;
  badge.dataset.tone = serviceOk ? "success" : "error";
  updatedAt.textContent = `Last checked ${formatDateTime(health.checked_at ?? new Date().toISOString())}`;
  raw.textContent = JSON.stringify(health, null, 2);

  cards.replaceChildren(
    statusCard("Service", [
      ["Status", health.status ?? "-"],
      ["Uptime", `${health.uptime_seconds ?? 0}s`],
      ["Live clients", health.live_clients ?? 0],
    ]),
    statusCard("Storage", [
      ["Driver", health.storage?.driver ?? "-"],
      ["Mode", health.storage?.mode ?? health.storage?.path ?? "-"],
    ]),
    statusCard("Auth", [
      ["Provider", health.auth_provider?.provider ?? "-"],
      ["Email", health.auth_provider?.email_provider ?? "-"],
      ["Dev codes", String(Boolean(health.auth_provider?.dev_codes_exposed))],
    ]),
    statusCard("Realtime", [
      ["Bus", health.realtime?.provider ?? "-"],
      ["Guard", health.request_guard?.provider ?? "-"],
      ["Locks", health.locks?.provider ?? "-"],
    ]),
    statusCard("Review Queues", [
      ["Held reports", health.counts?.held_training_reports ?? 0],
      ["Open alerts", health.counts?.abuse_alerts ?? 0],
      ["Assets", health.counts?.assets ?? 0],
    ]),
    statusCard("League Counts", [
      ["Accounts", health.counts?.accounts ?? 0],
      ["Pets", health.counts?.pets ?? 0],
      ["Battles", health.counts?.active_battles ?? 0],
      ["Queue", health.counts?.match_tickets ?? 0],
    ]),
  );
}

function renderFailure(error) {
  badge.textContent = "Status check failed";
  badge.dataset.tone = "error";
  updatedAt.textContent = `Last checked ${formatDateTime(new Date().toISOString())}`;
  raw.textContent = error.message;
  cards.replaceChildren(statusCard("Service", [["Status", "unreachable"], ["Error", error.message]]));
}

function statusCard(title, rows) {
  const item = document.createElement("article");
  item.className = "status-card";
  appendText(item, "strong", title);
  for (const [label, value] of rows) {
    const row = document.createElement("div");
    appendText(row, "span", label);
    appendText(row, "b", value);
    item.append(row);
  }
  return item;
}

function appendText(parent, tag, text) {
  const child = document.createElement(tag);
  child.textContent = text === null || text === undefined || text === "" ? "-" : String(text);
  parent.append(child);
  return child;
}

function formatDateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleString();
}
