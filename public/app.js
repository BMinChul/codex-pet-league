const EMPTY_LABEL = "-";
const STAT_KEYS = ["power", "guard", "speed", "focus", "recovery", "insight"];

const state = {
  ready: false,
  busy: false,
  session: null,
  rules: { elements: [], skills: [], caps: {}, matchmakingPolicy: {} },
  league: null,
  pets: [],
  leaderboard: [],
  events: [],
  xpStatusByPetId: new Map(),
  matchmaking: null,
  activePetId: null,
  activeBattleId: null,
  activeBattle: null,
  notices: [],
};

const els = queryElements({
  appStatus: "#appStatus",
  sessionLabel: "#sessionLabel",
  leagueLabel: "#leagueLabel",
  petSelect: "#petSelect",
  seedPetButton: "#seedPetButton",
  petNameInput: "#petNameInput",
  primaryElementInput: "#primaryElementInput",
  secondaryElementInput: "#secondaryElementInput",
  atlasFileInput: "#atlasFileInput",
  createPetButton: "#createPetButton",
  petTitle: "#petTitle",
  petSubtitle: "#petSubtitle",
  classPill: "#classPill",
  rankPill: "#rankPill",
  statList: "#statList",
  xpStatus: "#xpStatus",
  resetText: "#resetText",
  refreshButton: "#refreshButton",
  draftReportButton: "#draftReportButton",
  submitReportButton: "#submitReportButton",
  trainingPreview: "#trainingPreview",
  battleMode: "#battleMode",
  opponentLp: "#opponentLp",
  startBattleButton: "#startBattleButton",
  joinQueueButton: "#joinQueueButton",
  queueStatusButton: "#queueStatusButton",
  createInviteButton: "#createInviteButton",
  inviteCodeInput: "#inviteCodeInput",
  acceptInviteButton: "#acceptInviteButton",
  matchmakingOutput: "#matchmakingOutput",
  battleState: "#battleState",
  battleSkillSelect: "#battleSkillSelect",
  actionButtons: "[data-action]",
  battleOutput: "#battleOutput",
  leaderboardBody: "#leaderboardBody",
  eventLog: "#eventLog",
});

boot();

async function boot() {
  bindEvents();
  setBusy(true);
  pushNotice("Loading League status...", "info");

  const [session, rules, league] = await Promise.all([
    loadOptional("/api/session", "Session unavailable."),
    loadOptional("/api/rules", "Rules unavailable."),
    loadOptional("/api/league", "League status unavailable."),
  ]);

  state.session = session;
  state.rules = normalizeRules(rules);
  state.league = league;
  state.ready = true;

  fillElements();
  connectLiveEvents();
  await refresh();
  setBusy(false);
  pushNotice("Ready.", "success");
}

function connectLiveEvents() {
  if (!("EventSource" in window)) return;
  const stream = new EventSource("/api/live");
  stream.addEventListener("battle.action.submitted", () => refreshSilently());
  stream.addEventListener("battle.room.viewed", () => refreshSilently());
  stream.addEventListener("matchmaking.background_matched", () => loadMatchmakingStatus());
  stream.addEventListener("matchmaking.queue", () => loadMatchmakingStatus());
  stream.addEventListener("heartbeat", () => {
    if (state.ready) setText(els.appStatus, "Live.");
  });
  stream.addEventListener("error", () => pushNotice("Live updates reconnecting...", "info"));
}

async function refreshSilently() {
  try {
    if (state.activeBattleId) {
      const result = await api(`/api/battles/${encodeURIComponent(state.activeBattleId)}`);
      state.activeBattle = result.battle;
    }
    await refresh();
  } catch {
    // The next manual refresh will recover from transient live-update failures.
  }
}

function bindEvents() {
  els.petSelect?.addEventListener("change", async () => {
    state.activePetId = els.petSelect.value || null;
    await loadActivePetDetails();
    renderApp();
  });
  els.seedPetButton?.addEventListener("click", () => runAction(() => createPet({ demo: true }), "Demo pet registered."));
  els.createPetButton?.addEventListener("click", () => runAction(() => createPet({ demo: false }), "Pet created."));
  els.refreshButton?.addEventListener("click", () => runAction(refresh, "Refreshed."));
  els.draftReportButton?.addEventListener("click", () => runAction(draftTrainingReport));
  els.submitReportButton?.addEventListener("click", () => runAction(submitTrainingReport, "Training report submitted."));
  els.startBattleButton?.addEventListener("click", () => runAction(startTurnBattle));
  els.joinQueueButton?.addEventListener("click", () => runAction(joinRandomMatch));
  els.queueStatusButton?.addEventListener("click", () => runAction(loadMatchmakingStatus));
  els.createInviteButton?.addEventListener("click", () => runAction(createFriendInvite));
  els.acceptInviteButton?.addEventListener("click", () => runAction(acceptFriendInvite));
  for (const button of els.actionButtons ?? []) {
    button.addEventListener("click", () => runAction(() => submitBattleAction(button.dataset.action)));
  }
}

async function refresh() {
  const [petsResult, boardResult, eventsResult, league] = await Promise.all([
    loadOptional("/api/pets", "Pets could not be loaded."),
    loadOptional("/api/leaderboard", "Leaderboard could not be loaded."),
    loadOptional("/api/events", "Event log could not be loaded."),
    loadOptional("/api/league", "League status could not be refreshed."),
  ]);

  state.league = league ?? state.league;
  state.pets = asArray(petsResult?.pets);
  state.leaderboard = asArray(boardResult?.leaderboard);
  state.events = asArray(eventsResult?.events);
  if (!state.pets.some((pet) => pet.id === state.activePetId)) {
    state.activePetId = state.pets[0]?.id ?? null;
  }
  await loadActivePetDetails();
  renderApp();
}

async function loadActivePetDetails() {
  const pet = activePet();
  if (!pet?.id) return;
  const status = await loadOptional(`/api/pets/${encodeURIComponent(pet.id)}/xp-status`, "XP status could not be loaded.");
  if (status) state.xpStatusByPetId.set(pet.id, status);
}

async function loadMatchmakingStatus() {
  const pet = activePet();
  const suffix = pet?.id ? `?pet_id=${encodeURIComponent(pet.id)}` : "";
  state.matchmaking = await api(`/api/matchmaking/status${suffix}`);
  const activeBattle = asArray(state.matchmaking.active_battles)[0];
  if (activeBattle) {
    state.activeBattleId = activeBattle.id;
    state.activeBattle = activeBattle;
  }
  renderApp();
}

function renderApp() {
  renderChrome();
  renderPetSelect();
  renderActivePet();
  renderXpStatus();
  renderMatchmaking(state.matchmaking);
  renderBattle(state.activeBattle);
  renderLeaderboard(state.leaderboard);
  renderEvents(state.events);
  updateControls();
}

function renderChrome() {
  const accountName = state.session?.account?.displayName ?? "Local account";
  const verified = state.session?.account?.verified === false ? "not verified" : "verified";
  setText(els.sessionLabel, `${accountName} · ${verified}`);

  const season = state.league?.active_season;
  const policy = state.league?.matchmaking_policy ?? state.rules.matchmakingPolicy;
  const rankedStart = policy?.ranked?.lpWindows?.[0]?.lpWindow;
  const queue = state.league?.queue_summary;
  const queueText = queue ? ` · ${queue.waiting_total ?? 0} waiting` : "";
  setText(els.leagueLabel, season ? `${season.name} · ranked ±${rankedStart ?? "?"} LP${queueText}` : "League status unavailable");

  const latest = state.notices[0];
  if (els.appStatus) {
    els.appStatus.textContent = latest?.message ?? (state.ready ? "Ready." : "Connecting...");
    els.appStatus.dataset.tone = latest?.tone ?? "info";
  }
}

function renderPetSelect() {
  replaceOptions(
    els.petSelect,
    state.pets.length
      ? state.pets.map((pet) => ({ value: pet.id, label: `${safeText(pet.name)} · ${safeText(pet.battle_class)}` }))
      : [{ value: "", label: "No pets yet" }],
    state.activePetId ?? "",
  );
}

function renderActivePet() {
  const pet = activePet();
  if (!pet) {
    setText(els.petTitle, "No pet registered");
    setText(els.petSubtitle, "Create a pet to start testing the League loop.");
    setText(els.classPill, `Class ${EMPTY_LABEL}`);
    setText(els.rankPill, `Rank ${EMPTY_LABEL}`);
    clear(els.statList);
    renderBattleSkills(null);
    return;
  }

  setText(els.petTitle, safeText(pet.name));
  setText(els.petSubtitle, `${elementLine(pet)} · Lv ${pet.level ?? 1} · ${pet.stats?.total ?? 0} stats`);
  setText(els.classPill, String(pet.battle_class ?? EMPTY_LABEL).toUpperCase());
  setText(els.rankPill, `${pet.rating?.label ?? EMPTY_LABEL} · ${pet.rating?.lp ?? 0} LP`);
  renderStats(pet);
  renderBattleSkills(pet);
}

function renderStats(pet) {
  clear(els.statList);
  const stats = pet?.stats ?? {};
  const max = Math.max(1, ...STAT_KEYS.map((key) => Number(stats[key] ?? 0)));
  for (const stat of STAT_KEYS) {
    const value = Number(stats[stat] ?? 0);
    const row = document.createElement("div");
    row.className = "stat-row";
    appendText(row, "strong", title(stat));
    row.append(meter(value, max));
    appendText(row, "span", String(value));
    els.statList?.append(row);
  }
}

function renderXpStatus() {
  clear(els.xpStatus);
  const pet = activePet();
  if (!pet) {
    setText(els.resetText, "");
    renderEmpty(els.xpStatus, "No pet selected.");
    return;
  }

  const status = state.xpStatusByPetId.get(pet.id);
  if (!status) {
    setText(els.resetText, "XP status pending.");
    renderEmpty(els.xpStatus, "Refresh to load daily caps.");
    return;
  }

  const rows = [
    ["Pet XP", status.counters?.petDaily, status.caps?.petDaily],
    ["Training", status.counters?.trainingDaily, status.caps?.trainingDaily],
    ["Battle", status.counters?.battleDaily, status.caps?.battleDaily],
    ["Friend", status.counters?.friendDaily, status.caps?.friendDaily],
    ["Reports", status.counters?.trainingReportsUsed, status.caps?.petEligibleTrainingReportsDaily],
    ["Style", status.counters?.styleDaily, status.caps?.styleDaily],
    ["Week Style", status.counters?.styleWeekly, status.caps?.styleWeekly],
  ];

  for (const [label, value, cap] of rows) {
    const current = Number(value ?? 0);
    const limit = Number.isFinite(Number(cap)) ? Number(cap) : 0;
    const row = document.createElement("div");
    row.className = "meter-row";
    appendText(row, "strong", label);
    row.append(meter(current, limit || current || 1));
    appendText(row, "span", `${current}/${formatCap(cap)}`);
    els.xpStatus?.append(row);
  }
  setText(els.resetText, `Daily reset: ${formatDateTime(status.reset_at)}`);
}

async function createPet({ demo }) {
  const name = demo ? "Pebble" : els.petNameInput?.value;
  const primary = demo ? "Forge" : els.primaryElementInput?.value;
  const secondary = demo ? "Trace" : els.secondaryElementInput?.value;
  const atlasDataUrl = demo ? null : await readAtlasDataUrl();
  const asset = await api("/api/pet-assets/uploads", {
    method: "POST",
    body: {
      appearance: { palette: demo ? "teal-blue" : "custom", source: "codex_app_demo" },
      atlas_data_url: atlasDataUrl,
    },
  });
  const pet = await api("/api/pets", {
    method: "POST",
    body: {
      name,
      pet_asset_id: asset.asset?.id,
      primary_element: primary,
      secondary_element: secondary,
    },
  });
  state.activePetId = pet.pet?.id ?? state.activePetId;
  await refresh();
}

async function draftTrainingReport() {
  const pet = requireActivePet();
  const draft = await api(`/api/pets/${encodeURIComponent(pet.id)}/training-reports/draft`, {
    method: "POST",
    body: { signals: collectSignals() },
  });
  setJson(els.trainingPreview, draft.draft ?? draft);
}

async function submitTrainingReport() {
  const pet = requireActivePet();
  const result = await api(`/api/pets/${encodeURIComponent(pet.id)}/training-reports`, {
    method: "POST",
    body: {
      client_report_id: randomId(),
      signals: collectSignals(),
    },
  });
  setJson(els.trainingPreview, {
    applied: {
      pet_xp: result.report?.pet_xp_delta ?? 0,
      style_xp: result.report?.style_xp_delta ?? 0,
    },
    pet: summarizePet(result.pet),
    counters: result.counters,
  });
  await refresh();
}

async function startTurnBattle() {
  const pet = requireActivePet();
  const result = await api(`/api/pets/${encodeURIComponent(pet.id)}/battles`, {
    method: "POST",
    body: {
      mode: els.battleMode?.value === "ranked" ? "casual" : els.battleMode?.value,
      opponent_lp: Number(els.opponentLp?.value ?? pet.rating?.lp ?? 1500),
    },
  });
  setActiveBattle(result.battle);
}

async function joinRandomMatch() {
  const pet = requireActivePet();
  const result = await api(`/api/pets/${encodeURIComponent(pet.id)}/matchmaking/queue`, {
    method: "POST",
    body: {
      mode: els.battleMode?.value === "ranked" ? "ranked" : "casual",
    },
  });
  state.matchmaking = result;
  if (result.battle) setActiveBattle(result.battle);
  renderApp();
}

async function createFriendInvite() {
  const pet = requireActivePet();
  const result = await api(`/api/pets/${encodeURIComponent(pet.id)}/friend-invites`, {
    method: "POST",
    body: {},
  });
  state.matchmaking = result;
  if (els.inviteCodeInput && result.invite?.code) els.inviteCodeInput.value = result.invite.code;
  renderApp();
}

async function acceptFriendInvite() {
  const pet = requireActivePet();
  const result = await api(`/api/pets/${encodeURIComponent(pet.id)}/friend-invites/accept`, {
    method: "POST",
    body: { code: els.inviteCodeInput?.value },
  });
  state.matchmaking = result;
  if (result.battle) setActiveBattle(result.battle);
  renderApp();
}

async function submitBattleAction(kind) {
  if (!state.activeBattleId) throw new Error("Start or join a server battle first.");
  const result = await api(`/api/battles/${encodeURIComponent(state.activeBattleId)}/actions`, {
    method: "POST",
    body: {
      kind,
      skill_id: kind === "skill" ? els.battleSkillSelect?.value || undefined : undefined,
    },
  });
  setActiveBattle(result.battle);
  if (result.battle?.status === "finished") await refresh();
}

function renderBattleSkills(pet) {
  const skills = asArray(pet?.skills);
  const options = skills.length
    ? skills.map((skill) => ({
        value: skill.id,
        label: `${skill.officialName ?? skill.id} · ${skill.role ?? "skill"}`,
      }))
    : [{ value: "", label: "No skills in current loadout" }];
  replaceOptions(els.battleSkillSelect, options, options[0]?.value ?? "");
}

function renderBattle(battle) {
  clear(els.battleState);
  if (!battle) {
    renderEmpty(els.battleState, "No active battle.");
    setText(els.battleOutput, "No active battle.");
    return;
  }

  const player = battle.sides?.player;
  const opponent = battle.sides?.opponent;
  if (player) els.battleState?.append(battleSide(player.is_you ? "You" : player.name, player));
  if (opponent) els.battleState?.append(battleSide(opponent.is_you ? "You" : opponent.name, opponent));

  const secondsLeft = battle.turn_deadline_at
    ? Math.max(0, Math.ceil((new Date(battle.turn_deadline_at).getTime() - Date.now()) / 1000))
    : null;
  const turnLine = document.createElement("div");
  turnLine.className = "turn-line";
  appendText(turnLine, "strong", `Turn ${battle.turn_index ?? 0}`);
  appendText(turnLine, "span", battle.status === "in_progress" ? `${secondsLeft ?? "?"}s left` : battle.result?.result ?? battle.status);
  els.battleState?.append(turnLine);

  setJson(els.battleOutput, {
    id: battle.id,
    mode: battle.mode,
    status: battle.status,
    turn: battle.turn_index,
    pending: battle.pending,
    result: battle.result,
    latest_turn: asArray(battle.log).at(-1) ?? null,
    replay_hash: battle.replay_hash,
  });
}

function battleSide(label, side) {
  const wrapper = document.createElement("div");
  wrapper.className = "battle-side";
  const header = document.createElement("div");
  appendText(header, "strong", safeText(label));
  appendText(header, "span", elementLine(side));
  wrapper.append(header);
  wrapper.append(meter(Number(side.hp ?? 0), Number(side.max_hp ?? 1), "bar hp-bar"));
  appendText(
    wrapper,
    "div",
    `${side.hp ?? 0}/${side.max_hp ?? 0} HP · ${"#".repeat(Number(side.energy ?? 0)).padEnd(6, ".")} · AFK ${side.timeout_count ?? 0}/3`,
    "battle-meta",
  );
  return wrapper;
}

function renderMatchmaking(result) {
  const activeTickets = asArray(result?.tickets);
  const activeBattles = asArray(result?.active_battles);
  const payload = result
    ? {
        status: result.status ?? result.invite?.status ?? activeTickets[0]?.status ?? "status",
        ticket: result.ticket ?? activeTickets[0] ?? null,
        invite: result.invite ?? null,
        active_battles: activeBattles.map((battle) => ({ id: battle.id, mode: battle.mode, status: battle.status })),
        queue_window_lp: result.ticket?.search_window_lp ?? activeTickets[0]?.search_window_lp ?? null,
        battle_id: result.battle?.id ?? activeBattles[0]?.id ?? null,
        viewer_side: result.battle?.viewer_side ?? activeBattles[0]?.viewer_side ?? null,
      }
    : { status: "No matchmaking activity." };
  setJson(els.matchmakingOutput, payload);
}

function renderLeaderboard(rows) {
  clear(els.leaderboardBody);
  const list = asArray(rows);
  if (!list.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 6;
    td.className = "empty-cell";
    td.textContent = "No ranked pets yet.";
    tr.append(td);
    els.leaderboardBody?.append(tr);
    return;
  }

  for (const row of list) {
    const tr = document.createElement("tr");
    for (const value of [
      row.rank,
      row.name,
      row.battle_class,
      row.tier_label,
      row.lp,
      `${row.wins ?? 0}/${row.losses ?? 0}/${row.draws ?? 0}`,
    ]) {
      appendText(tr, "td", safeText(value));
    }
    els.leaderboardBody?.append(tr);
  }
}

function renderEvents(events) {
  clear(els.eventLog);
  const list = asArray(events);
  if (!list.length) {
    renderEmpty(els.eventLog, "No server events yet.");
    return;
  }
  for (const event of list) {
    const item = document.createElement("div");
    item.className = "event-item";
    appendText(item, "strong", formatTime(event.created_at));
    appendText(item, "span", `${event.type ?? "event"} · ${safeJson(event.payload)}`);
    els.eventLog?.append(item);
  }
}

function updateControls() {
  const hasPet = Boolean(activePet());
  const hasSkill = Boolean(els.battleSkillSelect?.value);
  const disableWhenNoPet = [
    els.draftReportButton,
    els.submitReportButton,
    els.startBattleButton,
    els.joinQueueButton,
    els.queueStatusButton,
    els.createInviteButton,
    els.acceptInviteButton,
  ];
  for (const control of disableWhenNoPet) {
    if (control) control.disabled = state.busy || !hasPet;
  }
  for (const button of els.actionButtons ?? []) {
    button.disabled = state.busy || !state.activeBattleId || (button.dataset.action === "skill" && !hasSkill);
  }
  for (const control of [els.seedPetButton, els.createPetButton, els.refreshButton, els.petSelect]) {
    if (control) control.disabled = state.busy;
  }
}

function fillElements() {
  const elements = state.rules.elements.length ? state.rules.elements : ["Forge", "Trace", "Logic", "Patch", "Pulse", "Deploy"];
  for (const select of [els.primaryElementInput, els.secondaryElementInput]) {
    replaceOptions(
      select,
      elements.map((element) => ({ value: element, label: element })),
      select === els.primaryElementInput ? "Forge" : "Trace",
    );
  }
}

function collectSignals() {
  return {
    implementationActivity: checked("#implementationActivity"),
    debuggingActivity: checked("#debuggingActivity"),
    verificationActivity: checked("#verificationActivity"),
    docsActivity: checked("#docsActivity"),
    releaseActivity: checked("#releaseActivity"),
    milestone: checked("#milestone"),
    filesChangedBucket: document.querySelector("#filesChangedBucket")?.value ?? "small",
    testsRun: Number(document.querySelector("#testsRun")?.value ?? 0),
  };
}

function readAtlasDataUrl() {
  const file = els.atlasFileInput?.files?.[0];
  if (!file) return null;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Could not read atlas PNG.")));
    reader.readAsDataURL(file);
  });
}

async function runAction(action, successMessage = null) {
  try {
    setBusy(true);
    await action();
    if (successMessage) pushNotice(successMessage, "success");
  } catch (error) {
    pushNotice(error.message, "error");
    const target = error.message.toLowerCase().includes("match") ? els.matchmakingOutput : els.battleOutput;
    if (target) target.textContent = error.message;
  } finally {
    setBusy(false);
    renderApp();
  }
}

async function loadOptional(path, fallbackMessage) {
  try {
    return await api(path);
  } catch (error) {
    pushNotice(`${fallbackMessage} ${error.message}`, "error");
    return null;
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: { "content-type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const payload = text ? parseJson(text) : {};
  if (!response.ok) {
    const message = payload.error?.message ?? payload.message ?? `API request failed (${response.status})`;
    throw new Error(message);
  }
  return payload;
}

function setActiveBattle(battle) {
  state.activeBattle = battle ?? null;
  state.activeBattleId = battle?.id ?? null;
  renderApp();
}

function activePet() {
  return state.pets.find((pet) => pet.id === state.activePetId) ?? null;
}

function requireActivePet() {
  const pet = activePet();
  if (!pet) throw new Error("Create or select a pet first.");
  return pet;
}

function normalizeRules(rules) {
  return {
    elements: asArray(rules?.elements),
    skills: asArray(rules?.skills),
    caps: rules?.caps ?? {},
    matchmakingPolicy: rules?.matchmakingPolicy ?? rules?.matchmaking_policy ?? {},
  };
}

function summarizePet(pet) {
  if (!pet) return null;
  return {
    name: pet.name,
    level: pet.level,
    mastery_level: pet.mastery_level,
    battle_class: pet.battle_class,
    xp: pet.xp,
    style_xp: pet.style_xp,
    stats_total: pet.stats?.total,
    rank: pet.rating?.label,
    lp: pet.rating?.lp,
  };
}

function queryElements(selectors) {
  return Object.fromEntries(
    Object.entries(selectors).map(([key, selector]) => [
      key,
      selector === "[data-action]" ? document.querySelectorAll(selector) : document.querySelector(selector),
    ]),
  );
}

function replaceOptions(select, options, selectedValue) {
  if (!select) return;
  select.replaceChildren(
    ...options.map((entry) => {
      const option = document.createElement("option");
      option.value = entry.value ?? "";
      option.textContent = entry.label ?? entry.value ?? "";
      option.selected = option.value === selectedValue;
      return option;
    }),
  );
}

function meter(value, cap, className = "bar") {
  const bar = document.createElement("span");
  bar.className = className;
  const fill = document.createElement("span");
  const percent = cap > 0 ? Math.min(100, Math.max(0, Math.round((value / cap) * 100))) : 0;
  fill.style.width = `${percent}%`;
  bar.append(fill);
  return bar;
}

function appendText(parent, tag, text, className = "") {
  const child = document.createElement(tag);
  if (className) child.className = className;
  child.textContent = safeText(text);
  parent.append(child);
  return child;
}

function renderEmpty(parent, message) {
  if (!parent) return;
  const item = document.createElement("div");
  item.className = "empty-state";
  item.textContent = message;
  parent.append(item);
}

function clear(element) {
  element?.replaceChildren();
}

function setText(element, text) {
  if (element) element.textContent = safeText(text);
}

function setJson(element, value) {
  if (element) element.textContent = JSON.stringify(value, null, 2);
}

function checked(selector) {
  return Boolean(document.querySelector(selector)?.checked);
}

function setBusy(value) {
  state.busy = value;
  updateControls();
}

function pushNotice(message, tone = "info") {
  if (!message) return;
  state.notices.unshift({ message, tone, createdAt: Date.now() });
  state.notices = state.notices.slice(0, 4);
  renderChrome();
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Server returned invalid JSON.");
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function safeText(value) {
  if (value === null || value === undefined || value === "") return EMPTY_LABEL;
  return String(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function elementLine(entry) {
  const primary = entry?.primary_element ?? EMPTY_LABEL;
  const secondary = entry?.secondary_element;
  return secondary ? `${primary} + ${secondary}` : primary;
}

function formatCap(cap) {
  if (cap === Infinity) return "∞";
  return Number.isFinite(Number(cap)) ? String(cap) : "?";
}

function formatDateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleString();
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--:--:--" : date.toLocaleTimeString();
}

function title(value) {
  const text = String(value ?? "");
  return text.slice(0, 1).toUpperCase() + text.slice(1);
}

function randomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint32Array(2);
  globalThis.crypto?.getRandomValues?.(bytes);
  return `client_${Date.now()}_${bytes[0].toString(16)}${bytes[1].toString(16)}`;
}
