const EMPTY_LABEL = "-";
const STAT_KEYS = ["power", "guard", "speed", "focus", "recovery", "insight"];
const DEVICE_STORAGE_KEY = "codexPetLeagueDeviceId";

const state = {
  ready: false,
  busy: false,
  session: null,
  authChallenge: null,
  liveStream: null,
  rules: { elements: [], skills: [], caps: {}, matchmakingPolicy: {} },
  league: null,
  pets: [],
  leaderboard: [],
  events: [],
  adminConsole: null,
  adminOutput: null,
  xpStatusByPetId: new Map(),
  profileByPetId: new Map(),
  replaysByPetId: new Map(),
  matchmaking: null,
  activePetId: null,
  activePetSelectionLocked: false,
  activePetLockedAt: null,
  activeBattleId: null,
  activeBattle: null,
  lastTrainingDraft: null,
  notices: [],
};

let silentRefreshPromise = null;
let silentRefreshQueued = false;

const els = queryElements({
  appStatus: "#appStatus",
  authOpenButton: "#authOpenButton",
  publicSignInButton: "#publicSignInButton",
  authCloseButton: "#authCloseButton",
  authModal: "#authModal",
  authIdentifierInput: "#authIdentifierInput",
  authChallengeButton: "#authChallengeButton",
  authCodeInput: "#authCodeInput",
  authVerifyButton: "#authVerifyButton",
  authHint: "#authHint",
  sessionLabel: "#sessionLabel",
  leagueLabel: "#leagueLabel",
  petSelect: "#petSelect",
  activePetLockHint: "#activePetLockHint",
  seedPetButton: "#seedPetButton",
  petTitle: "#petTitle",
  petSubtitle: "#petSubtitle",
  petImage: "#petImage",
  profilePetImage: "#profilePetImage",
  classPill: "#classPill",
  rankPill: "#rankPill",
  dashboardRankBadge: "#dashboardRankBadge",
  statList: "#statList",
  profileSummary: "#profileSummary",
  skillAliasList: "#skillAliasList",
  saveAliasesButton: "#saveAliasesButton",
  xpStatus: "#xpStatus",
  dashboardXpStatus: "#dashboardXpStatus",
  resetText: "#resetText",
  leagueSnapshot: "#leagueSnapshot",
  refreshButton: "#refreshButton",
  draftReportButton: "#draftReportButton",
  submitReportButton: "#submitReportButton",
  trainingPreview: "#trainingPreview",
  battleMode: "#battleMode",
  opponentLp: "#opponentLp",
  startBattleButton: "#startBattleButton",
  joinQueueButton: "#joinQueueButton",
  queueStatusButton: "#queueStatusButton",
  cancelQueueButton: "#cancelQueueButton",
  createInviteButton: "#createInviteButton",
  inviteCodeInput: "#inviteCodeInput",
  acceptInviteButton: "#acceptInviteButton",
  matchmakingCards: "#matchmakingCards",
  matchmakingOutput: "#matchmakingOutput",
  battleState: "#battleState",
  battleTimeline: "#battleTimeline",
  battleSkillSelect: "#battleSkillSelect",
  actionButtons: "[data-action]",
  battleOutput: "#battleOutput",
  replayRefreshButton: "#replayRefreshButton",
  replayList: "#replayList",
  leaderboardTierFilter: "#leaderboardTierFilter",
  leaderboardClassFilter: "#leaderboardClassFilter",
  leaderboardBody: "#leaderboardBody",
  dashboardEventFeed: "#dashboardEventFeed",
  eventLog: "#eventLog",
  adminRefreshButton: "#adminRefreshButton",
  adminRunOpsButton: "#adminRunOpsButton",
  adminCaseFilter: "#adminCaseFilter",
  adminSummary: "#adminSummary",
  adminAuditFindings: "#adminAuditFindings",
  adminReviewCases: "#adminReviewCases",
  adminHistory: "#adminHistory",
  adminOutput: "#adminOutput",
  adminPanel: ".admin-panel",
  tabButtons: "[data-tab]",
  tabJumpers: "[data-tab-jump]",
  views: "[data-view]",
});

boot();
setInterval(updateBattleTimerText, 1000);

async function boot() {
  bindEvents();
  setBusy(true);
  pushNotice("Loading League status...", "info");

  const rules = await loadOptional("/api/rules", "Rules unavailable.");
  state.rules = normalizeRules(rules);
  fillElements();

  const signedIn = await refreshSession();
  if (!signedIn) {
    state.ready = false;
    setBusy(false);
    pushNotice("Sign in to enter the League.", "info");
    renderApp();
    return;
  }

  connectLiveEvents();
  await refresh();
  setBusy(false);
  pushNotice("Ready.", "success");
}

function connectLiveEvents() {
  if (!("EventSource" in window)) return;
  state.liveStream?.close();
  const stream = new EventSource("/api/live");
  state.liveStream = stream;
  stream.addEventListener("battle.action.submitted", () => refreshSilently());
  stream.addEventListener("matchmaking.background_matched", () => safeLiveAction(loadMatchmakingStatus));
  stream.addEventListener("matchmaking.queue", () => safeLiveAction(loadMatchmakingStatus));
  stream.addEventListener("heartbeat", () => {
    if (state.ready) setText(els.appStatus, "Live.");
  });
  stream.addEventListener("error", () => pushNotice("Live updates reconnecting...", "info"));
}

async function safeLiveAction(action) {
  try {
    await action();
  } catch (error) {
    pushNotice(`Live update skipped. ${error.message}`, "error");
  }
}

async function refreshSilently() {
  if (silentRefreshPromise) {
    silentRefreshQueued = true;
    return silentRefreshPromise;
  }
  silentRefreshPromise = runSilentRefresh();
  return silentRefreshPromise;
}

async function runSilentRefresh() {
  try {
    do {
      silentRefreshQueued = false;
      await refresh();
    } while (silentRefreshQueued);
  } catch {
    // The next manual refresh will recover from transient live-update failures.
  } finally {
    silentRefreshPromise = null;
    silentRefreshQueued = false;
  }
}

function bindEvents() {
  els.petSelect?.addEventListener("change", async () => {
    const previousPetId = state.activePetId;
    const selectedPetId = els.petSelect.value || null;
    state.activePetId = selectedPetId;
    if (!selectedPetId || selectedPetId === previousPetId) {
      await loadActivePetDetails();
      renderApp();
      return;
    }
    try {
      const result = await api(`/api/pets/${encodeURIComponent(selectedPetId)}/activate`, {
        method: "POST",
        body: {},
      });
      state.activePetId = result.active_pet_id ?? selectedPetId;
      state.activePetSelectionLocked = result.active_pet_selection_locked ?? true;
      state.activePetLockedAt = result.active_pet_locked_at ?? state.activePetLockedAt;
    } catch (error) {
      state.activePetId = previousPetId;
      pushNotice(
        error.code === "ACTIVE_PET_SELECTION_LOCKED"
          ? "League pet selection is permanent for this account."
          : error.message,
        "error",
      );
    }
    await loadActivePetDetails();
    renderApp();
  });
  for (const button of els.tabButtons ?? []) {
    button.addEventListener("click", () => activateTab(button.dataset.tab));
  }
  for (const jumper of els.tabJumpers ?? []) {
    jumper.addEventListener("click", (event) => {
      const tab = jumper.dataset.tabJump;
      if (!tab) return;
      event.preventDefault();
      activateTab(tab);
    });
  }
  els.authOpenButton?.addEventListener("click", openAuthModal);
  els.publicSignInButton?.addEventListener("click", openAuthModal);
  els.authCloseButton?.addEventListener("click", closeAuthModal);
  els.authModal?.addEventListener("click", (event) => {
    if (event.target === els.authModal) closeAuthModal();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !els.authModal?.hidden) closeAuthModal();
  });
  els.authChallengeButton?.addEventListener("click", () => runAction(startAuthChallenge));
  els.authVerifyButton?.addEventListener("click", () => runAction(verifyAuthChallenge, "Signed in."));
  els.seedPetButton?.addEventListener("click", () => runAction(() => createDemoPet(), "Local demo pet seeded."));
  els.refreshButton?.addEventListener("click", () => runAction(refresh, "Refreshed."));
  els.saveAliasesButton?.addEventListener("click", () => runAction(saveSkillAliases, "Skill names saved."));
  els.draftReportButton?.addEventListener("click", () => runAction(draftTrainingReport));
  els.submitReportButton?.addEventListener("click", () => runAction(submitTrainingReport, "Training report submitted."));
  els.startBattleButton?.addEventListener("click", () => runAction(startTurnBattle));
  els.joinQueueButton?.addEventListener("click", () => runAction(joinRandomMatch));
  els.queueStatusButton?.addEventListener("click", () => runAction(loadMatchmakingStatus));
  els.cancelQueueButton?.addEventListener("click", () => runAction(cancelQueuedMatch, "Queue cancelled."));
  els.createInviteButton?.addEventListener("click", () => runAction(createFriendInvite));
  els.acceptInviteButton?.addEventListener("click", () => runAction(acceptFriendInvite));
  els.replayRefreshButton?.addEventListener("click", () => runAction(loadActivePetDetails, "Replays refreshed."));
  els.leaderboardTierFilter?.addEventListener("change", () => renderLeaderboard(state.leaderboard));
  els.leaderboardClassFilter?.addEventListener("change", () => renderLeaderboard(state.leaderboard));
  els.adminCaseFilter?.addEventListener("change", renderAdminConsole);
  els.adminRefreshButton?.addEventListener("click", () => runAction(loadAdminConsole, "Admin console refreshed."));
  els.adminRunOpsButton?.addEventListener("click", () => runAction(runAdminOpsJob, "Ops job completed."));
  for (const button of els.actionButtons ?? []) {
    button.addEventListener("click", () => runAction(() => submitBattleAction(button.dataset.action)));
  }
}

async function refresh() {
  if (!isSignedIn()) {
    renderApp();
    return;
  }
  const [petsResult, boardResult, eventsResult, league] = await Promise.all([
    loadOptional("/api/pets", "Pets could not be loaded."),
    loadOptional("/api/leaderboard", "Leaderboard could not be loaded."),
    loadOptional("/api/events", "Event log could not be loaded."),
    loadOptional("/api/league", "League status could not be refreshed."),
  ]);

  state.league = league ?? state.league;
  state.pets = asArray(petsResult?.pets);
  state.activePetSelectionLocked = Boolean(petsResult?.active_pet_selection_locked);
  state.activePetLockedAt = petsResult?.active_pet_locked_at ?? null;
  state.leaderboard = asArray(boardResult?.leaderboard);
  state.events = asArray(eventsResult?.events);
  if (isAdmin()) {
    state.adminConsole = await loadOptional("/api/admin/console", "Admin console could not be loaded.");
  }
  if (petsResult?.active_pet_id) {
    state.activePetId = petsResult.active_pet_id;
  } else if (!state.pets.some((pet) => pet.id === state.activePetId)) {
    state.activePetId = petsResult?.active_pet_id ?? state.pets.find((pet) => pet.is_active)?.id ?? state.pets[0]?.id ?? null;
  }
  await loadActivePetDetails();
  await loadActiveBattle();
  renderApp();
}

async function refreshSession() {
  try {
    state.session = await api("/api/session");
    state.ready = true;
    return true;
  } catch (error) {
    if (error.status === 401) {
      state.session = null;
      return false;
    }
    throw error;
  }
}

async function loadActivePetDetails() {
  const pet = activePet();
  if (!pet?.id) return;
  const [status, profile, replays] = await Promise.all([
    loadOptional(`/api/pets/${encodeURIComponent(pet.id)}/xp-status`, "XP status could not be loaded."),
    loadOptional(`/api/public/pets/${encodeURIComponent(pet.id)}`, "Profile could not be loaded."),
    loadOptional(`/api/pets/${encodeURIComponent(pet.id)}/replays`, "Replays could not be loaded."),
  ]);
  if (status) state.xpStatusByPetId.set(pet.id, status);
  if (profile) state.profileByPetId.set(pet.id, profile);
  if (replays) state.replaysByPetId.set(pet.id, asArray(replays.replays));
}

async function loadActiveBattle() {
  if (!state.activeBattleId) return;
  const result = await loadOptional(`/api/battles/${encodeURIComponent(state.activeBattleId)}`, "Battle could not be refreshed.");
  if (result?.battle) state.activeBattle = result.battle;
}

function pollActiveBattle(delayMs) {
  window.setTimeout(async () => {
    if (!state.activeBattleId) return;
    try {
      const result = await api(`/api/battles/${encodeURIComponent(state.activeBattleId)}`);
      if (result?.battle) {
        state.activeBattle = result.battle;
        renderApp();
      }
    } catch {
      // Live/SSE refresh will retry; this small poll is only a UI freshness backup.
    }
  }, delayMs);
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
  renderPublicProfile();
  renderXpStatus();
  renderMatchmaking(state.matchmaking);
  renderBattle(state.activeBattle);
  renderReplays();
  renderLeaderboard(state.leaderboard);
  renderLeagueSnapshot();
  renderEvents(state.events);
  renderAdminConsole();
  updateControls();
}

function renderChrome() {
  document.body.dataset.signedIn = String(isSignedIn());
  document.body.dataset.hasPet = String(Boolean(activePet()));
  document.body.dataset.admin = String(isAdmin());

  const accountName = state.session?.account?.displayName ?? "Sign in required";
  const verified = state.session?.account?.verified === false ? "not verified" : "verified";
  const pet = activePet();
  setText(els.sessionLabel, state.session?.account ? `${accountName} · ${pet?.name ?? "No Pet"} · ${verified}` : accountName);

  const season = state.league?.active_season;
  const policy = state.league?.matchmaking_policy ?? state.rules.matchmakingPolicy;
  const rankedStart = policy?.ranked?.lpWindows?.[0]?.lpWindow;
  const queue = state.league?.queue_summary;
  const queueText = queue ? ` · ${queue.waiting_total ?? 0} waiting` : "";
  const compactSeasonName = season?.name?.split(":")[0] ?? season?.name;
  const fullLeagueLabel = season
    ? `${season.name} · ranked ±${rankedStart ?? "?"} LP${queueText}`
    : isSignedIn()
      ? "League status unavailable"
      : "Official shared alpha";
  setText(els.leagueLabel, season ? `${compactSeasonName}${queueText}` : fullLeagueLabel);
  if (els.leagueLabel) els.leagueLabel.title = fullLeagueLabel;

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
  if (els.activePetLockHint) {
    els.activePetLockHint.textContent = state.activePetSelectionLocked
      ? "Official active pet is locked for this League account."
      : "First active League pet selection is permanent.";
  }
}

function renderActivePet() {
  const pet = activePet();
  if (!pet) {
    setText(els.petTitle, "No pet registered");
    setText(els.petSubtitle, "Import a local hatch-pet package through CLI or MCP.");
    setText(els.classPill, `Class ${EMPTY_LABEL}`);
    setText(els.rankPill, `Rank ${EMPTY_LABEL}`);
    setText(els.dashboardRankBadge, "No pet locked");
    clear(els.statList);
    renderEmpty(els.statList, "No hatch-pet package has been imported for this League account.");
    setPetImage(null);
    renderBattleSkills(null);
    return;
  }

  setPetImage(pet);
  setText(els.petTitle, safeText(pet.name));
  setText(els.petSubtitle, `${elementLine(pet)} · Lv ${pet.level ?? 1} · ${pet.stats?.total ?? 0} stats`);
  setText(els.classPill, String(pet.battle_class ?? EMPTY_LABEL).toUpperCase());
  setText(els.rankPill, `${pet.rating?.label ?? EMPTY_LABEL} · ${pet.rating?.lp ?? 0} LP`);
  setText(els.dashboardRankBadge, `${pet.rating?.label ?? EMPTY_LABEL} / ${String(pet.battle_class ?? EMPTY_LABEL).toUpperCase()}`);
  renderStats(pet);
  renderBattleSkills(pet);
}

function setPetImage(pet) {
  const atlasUrl = pet?.asset?.atlas_url;
  for (const image of [els.petImage, els.profilePetImage]) {
    if (!image) continue;
    image.src = atlasUrl || "/pet-placeholder.svg";
    image.classList.toggle("sprite-atlas", Boolean(atlasUrl));
  }
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

function renderPublicProfile() {
  clear(els.profileSummary);
  clear(els.skillAliasList);
  const pet = activePet();
  if (!pet) {
    renderEmpty(els.profileSummary, "No pet selected.");
    return;
  }

  const profile = state.profileByPetId.get(pet.id);
  const record = profile?.record ?? {};
  const rows = [
    ["Record", `${record.wins ?? 0}-${record.losses ?? 0}-${record.draws ?? 0}`],
    ["Battles", record.battles ?? 0],
    ["Asset", `${pet.asset?.is_visible ? "public" : "restricted"} · ${assetLabel(pet.asset)}`],
    ["Hatch", pet.asset?.hatch_pet_json?.id ?? pet.asset?.provenance?.hatch_pet_id ?? EMPTY_LABEL],
    ["Fingerprint", shortHash(pet.asset?.source_fingerprint ?? pet.asset?.atlas_sha256)],
    ["Rewards", asArray(pet.cosmetic_rewards).map((reward) => reward.name ?? reward.id).join(", ") || EMPTY_LABEL],
  ];
  for (const [label, value] of rows) {
    const item = document.createElement("div");
    appendText(item, "strong", label);
    appendText(item, "span", value);
    els.profileSummary?.append(item);
  }

  const skills = asArray(pet.skills);
  if (!skills.length) {
    renderEmpty(els.skillAliasList, "No skills in current loadout.");
    return;
  }
  for (const skill of skills) {
    const row = document.createElement("label");
    row.className = "skill-alias-row";
    appendText(row, "span", `${skill.officialName ?? skill.id} · ${skill.role ?? "skill"}`);
    const input = document.createElement("input");
    input.className = "field";
    input.dataset.skillAlias = skill.id;
    input.maxLength = 32;
    input.value = skill.alias ?? "";
    row.append(input);
    els.skillAliasList?.append(row);
  }
}

function renderXpStatus() {
  clear(els.xpStatus);
  clear(els.dashboardXpStatus);
  const pet = activePet();
  if (!pet) {
    setText(els.resetText, "");
    renderEmpty(els.xpStatus, "No pet selected.");
    renderEmpty(els.dashboardXpStatus, "No pet selected.");
    return;
  }

  const status = state.xpStatusByPetId.get(pet.id);
  if (!status) {
    setText(els.resetText, "XP status pending.");
    renderEmpty(els.xpStatus, "Refresh to load daily caps.");
    renderEmpty(els.dashboardXpStatus, "Refresh to load daily caps.");
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
  renderDashboardXpStatus(status);
  const remaining = status.remaining ?? {};
  setText(
    els.resetText,
    `Available today: pet ${remaining.pet ?? 0}, training ${remaining.training ?? 0}, battle ${remaining.battle ?? 0}, style ${remaining.style ?? 0}. Reset: ${formatDateTime(status.reset_at)}`,
  );
}

function renderDashboardXpStatus(status) {
  clear(els.dashboardXpStatus);
  const rows = [
    ["Pet XP", status.counters?.petDaily, status.caps?.petDaily],
    ["Training XP", status.counters?.trainingDaily, status.caps?.trainingDaily],
    ["Battle XP", status.counters?.battleDaily, status.caps?.battleDaily],
    ["Style XP", status.counters?.styleDaily, status.caps?.styleDaily],
  ];
  for (const [label, value, cap] of rows) {
    const current = Number(value ?? 0);
    const limit = Number.isFinite(Number(cap)) ? Number(cap) : 0;
    const item = document.createElement("div");
    appendText(item, "strong", label);
    appendText(item, "span", `${current}/${formatCap(cap)}`);
    const track = document.createElement("i");
    const fill = document.createElement("b");
    fill.style.width = `${percent(current, limit || current || 1)}%`;
    track.append(fill);
    item.append(track);
    els.dashboardXpStatus?.append(item);
  }
}

function renderLeagueSnapshot() {
  clear(els.leagueSnapshot);
  const pet = activePet();
  const replays = pet ? asArray(state.replaysByPetId.get(pet.id)).length : 0;
  const queue = state.league?.queue_summary;
  const activeBattleCount = state.activeBattle?.status === "in_progress" ? 1 : 0;
  const rows = [
    ["My Pets", state.pets.length],
    ["Queue", queue?.waiting_total ?? 0],
    ["Active Battle", activeBattleCount],
    ["Replays", replays],
  ];
  for (const [label, value] of rows) {
    const item = document.createElement("div");
    appendText(item, "strong", label);
    appendText(item, "span", value);
    els.leagueSnapshot?.append(item);
  }
}

async function createDemoPet() {
  const asset = await api("/api/pet-assets/uploads", {
    method: "POST",
    body: {
      appearance: { palette: "teal-blue", source: "local_browser_smoke" },
      atlas_data_url: null,
    },
  });
  const pet = await api("/api/pets", {
    method: "POST",
    body: {
      name: "Pebble",
      pet_asset_id: asset.asset?.id,
      primary_element: "Forge",
      secondary_element: "Trace",
    },
  });
  state.activePetId = pet.active_pet_id ?? pet.pet?.id ?? state.activePetId;
  await refresh();
}

async function saveSkillAliases() {
  const pet = requireActivePet();
  const aliases = {};
  for (const input of document.querySelectorAll("[data-skill-alias]")) {
    const value = input.value.trim();
    if (value) aliases[input.dataset.skillAlias] = value;
  }
  const result = await api(`/api/pets/${encodeURIComponent(pet.id)}/loadout`, {
    method: "PUT",
    body: {
      skills: asArray(pet.skills).map((skill) => skill.id),
      aliases,
    },
  });
  state.activePetId = result.pet?.id ?? pet.id;
  await refresh();
}

async function startAuthChallenge() {
  const result = await api("/api/auth/challenge", {
    method: "POST",
    body: {
      method: "email_magic_link",
      identifier: els.authIdentifierInput?.value?.trim() || "local@example.test",
    },
  });
  state.authChallenge = result;
  if (els.authCodeInput && result.dev_code) els.authCodeInput.value = result.dev_code;
  if (result.oauth_authorize_url) window.open(result.oauth_authorize_url, "_blank", "noopener,noreferrer");
  setText(els.authHint, authChallengeHint(result));
}

async function verifyAuthChallenge() {
  if (!state.authChallenge?.challenge_id) throw new Error("Click Send Code first, then enter the email code and click Verify Code.");
  const body = {
    challenge_id: state.authChallenge.challenge_id,
    code: els.authCodeInput?.value,
  };
  if (state.authChallenge.method === "league_oauth" && body.code) body.oauth_code = body.code;
  if (state.authChallenge.method === "passkey" && !body.code && state.authChallenge.passkey_options) {
    body.assertion = await collectPasskeyAssertion(state.authChallenge.passkey_options);
  }
  const result = await api("/api/auth/verify", {
    method: "POST",
    body,
  });
  state.session = { account: result.account };
  state.authChallenge = null;
  setText(els.authHint, "Signed in.");
  closeAuthModal();
  connectLiveEvents();
  await refresh();
}

function openAuthModal() {
  if (!els.authModal) return;
  els.authModal.hidden = false;
  window.setTimeout(() => els.authIdentifierInput?.focus(), 0);
}

function closeAuthModal() {
  if (!els.authModal) return;
  els.authModal.hidden = true;
}

function activateTab(tab = "dashboard") {
  let next = tab || "dashboard";
  if (next === "ops" && !isAdmin()) next = "dashboard";
  const previous = document.body.dataset.activeTab;
  let activeButton = null;
  for (const button of els.tabButtons ?? []) {
    const isActive = button.dataset.tab === next;
    button.classList.toggle("is-active", isActive);
    if (isActive) activeButton = button;
  }
  for (const view of els.views ?? []) {
    const active = view.dataset.view === next;
    view.hidden = !active;
    view.classList.toggle("is-active", active);
  }
  document.body.dataset.activeTab = next;
  activeButton?.scrollIntoView({ block: "nearest", inline: "center" });
  if (previous && previous !== next) {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }
}

function authChallengeHint(result) {
  if (result.dev_code) return `Local dev code: ${result.dev_code}`;
  if (result.oauth_authorize_url) return "OAuth provider opened. Paste the returned code to finish sign-in.";
  if (result.passkey_options) return "Passkey challenge ready. Use Verify to continue with this browser.";
  return result.delivery?.message ?? "Email code sent. Check your inbox.";
}

async function collectPasskeyAssertion(options) {
  if (!window.PublicKeyCredential || !navigator.credentials?.get) {
    throw new Error("This browser does not expose passkey credentials.");
  }
  const credential = await navigator.credentials.get({
    publicKey: {
      challenge: new TextEncoder().encode(options.challenge),
      rpId: options.rp_id,
      timeout: options.timeout_ms,
      userVerification: options.user_verification ?? "preferred",
    },
  });
  return serializeCredential(credential);
}

function serializeCredential(credential) {
  const response = credential.response;
  return {
    id: credential.id,
    type: credential.type,
    raw_id: bufferToBase64Url(credential.rawId),
    response: {
      authenticator_data: bufferToBase64Url(response.authenticatorData),
      client_data_json: bufferToBase64Url(response.clientDataJSON),
      signature: bufferToBase64Url(response.signature),
      user_handle: response.userHandle ? bufferToBase64Url(response.userHandle) : null,
    },
  };
}

function bufferToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function draftTrainingReport() {
  const pet = requireActivePet();
  const draft = await api(`/api/pets/${encodeURIComponent(pet.id)}/training-reports/draft`, {
    method: "POST",
    body: { signals: collectSignals() },
  });
  state.lastTrainingDraft = draft.draft ?? draft;
  setJson(els.trainingPreview, draft.draft ?? draft);
}

async function submitTrainingReport() {
  const pet = requireActivePet();
  let draft = state.lastTrainingDraft;
  if (!draft || draft.pet_id !== pet.id || new Date(draft.expires_at) <= new Date()) {
    const drafted = await api(`/api/pets/${encodeURIComponent(pet.id)}/training-reports/draft`, {
      method: "POST",
      body: { signals: collectSignals() },
    });
    draft = drafted.draft ?? drafted;
    state.lastTrainingDraft = draft;
  }
  const result = await api(`/api/pets/${encodeURIComponent(pet.id)}/training-reports`, {
    method: "POST",
    body: {
      client_report_id: randomId(),
      draft_id: draft.id,
      draft_nonce: draft.nonce,
      signals: collectSignals(),
    },
  });
  setJson(els.trainingPreview, {
    status: result.report?.status,
    review_reason: result.report?.review_reason,
    risk_flags: result.report?.risk_flags,
    trust: result.report?.trust_reason,
    applied: {
      pet_xp: result.report?.pet_xp_delta ?? 0,
      style_xp: result.report?.style_xp_delta ?? 0,
    },
    pet: summarizePet(result.pet),
    counters: result.counters,
  });
  await refresh();
}

async function loadAdminConsole() {
  state.adminConsole = await api("/api/admin/console");
  state.adminOutput = null;
  renderAdminConsole();
}

async function runAdminOpsJob() {
  const result = await api("/api/admin/ops/run", {
    method: "POST",
    body: {},
  });
  state.adminConsole = await api("/api/admin/console");
  state.adminOutput = result;
  renderAdminConsole();
}

async function reviewTrainingReport(reportId, decision) {
  const result = await api(`/api/admin/training-reports/${encodeURIComponent(reportId)}/review`, {
    method: "POST",
    body: { decision },
  });
  state.adminConsole = await api("/api/admin/console");
  state.adminOutput = result;
  renderAdminConsole();
  await refresh();
}

async function updateEnforcement(accountId, action) {
  const result = await api(`/api/admin/accounts/${encodeURIComponent(accountId)}/enforcement`, {
    method: "POST",
    body: { action, days: enforcementDays(action), reason: action },
  });
  state.adminConsole = await api("/api/admin/console");
  state.adminOutput = result;
  renderAdminConsole();
}

async function updateLinkedEnforcement(accountIds, action) {
  const results = [];
  for (const accountId of asArray(accountIds)) {
    results.push(
      await api(`/api/admin/accounts/${encodeURIComponent(accountId)}/enforcement`, {
        method: "POST",
        body: { action, days: enforcementDays(action), reason: action },
      }),
    );
  }
  state.adminConsole = await api("/api/admin/console");
  state.adminOutput = { action, accounts: results.map((result) => result.account?.id ?? result.account?.displayName ?? "account") };
  renderAdminConsole();
}

function enforcementDays(action) {
  if (action === "ranked_lp_suppress") return 7;
  return 1;
}

async function moderateAsset(assetId, action) {
  const result = await api(`/api/admin/assets/${encodeURIComponent(assetId)}/moderation`, {
    method: "POST",
    body: { action, reason: action },
  });
  state.adminConsole = await api("/api/admin/console");
  state.adminOutput = result;
  renderAdminConsole();
}

async function rollbackRankedRoom(roomId) {
  const result = await api(`/api/admin/battles/${encodeURIComponent(roomId)}/rollback`, {
    method: "POST",
    body: { reason: "competitive_integrity_review" },
  });
  state.adminConsole = await api("/api/admin/console");
  state.adminOutput = result;
  const board = await api("/api/leaderboard");
  state.leaderboard = asArray(board.leaderboard);
  renderAdminConsole();
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

async function cancelQueuedMatch() {
  if (!state.matchmaking) await loadMatchmakingStatus();
  const ticket = asArray(state.matchmaking?.tickets).find((entry) => entry.status === "waiting") ?? state.matchmaking?.ticket;
  if (!ticket?.id) throw new Error("No waiting queue ticket.");
  const result = await api("/api/matchmaking/cancel", {
    method: "POST",
    body: { ticket_id: ticket.id },
  });
  state.matchmaking = { ...state.matchmaking, status: "cancelled", ticket: result.ticket, tickets: [result.ticket] };
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
      turn_index: state.activeBattle?.turn_index,
      turn_nonce: state.activeBattle?.turn_nonce,
      skill_id: kind === "skill" ? els.battleSkillSelect?.value || undefined : undefined,
    },
  });
  setActiveBattle(result.battle);
  if (result.battle?.status === "in_progress") {
    pollActiveBattle(350);
    pollActiveBattle(1000);
  }
  if (result.battle?.status === "finished") await refresh();
}

function renderBattleSkills(pet) {
  const skills = asArray(pet?.skills);
  const options = skills.length
    ? skills.map((skill) => ({
      value: skill.id,
      label: `${skillLabel(skill)} · ${skill.role ?? "skill"}`,
      }))
    : [{ value: "", label: "No skills in current loadout" }];
  replaceOptions(els.battleSkillSelect, options, options[0]?.value ?? "");
}

function renderBattle(battle) {
  clear(els.battleState);
  clear(els.battleTimeline);
  if (!battle) {
    renderEmpty(els.battleState, "No active battle.");
    renderEmpty(els.battleTimeline, "No battle timeline.");
    setText(els.battleOutput, "No active battle.");
    return;
  }

  const player = battle.sides?.player;
  const opponent = battle.sides?.opponent;
  const secondsLeft = battle.turn_deadline_at
    ? Math.max(0, Math.ceil((new Date(battle.turn_deadline_at).getTime() - Date.now()) / 1000))
    : null;

  const arena = document.createElement("div");
  arena.className = "battle-arena";
  arena.dataset.status = battle.status ?? "unknown";
  const skillsById = new Map(asArray(state.rules.skills).map((skill) => [skill.id, skill]));

  const combatants = document.createElement("div");
  combatants.className = "battle-combatants";
  if (player) combatants.append(battleSide(player.is_you ? "You" : player.name, player, skillsById));
  combatants.append(battleCenter(battle, secondsLeft));
  if (opponent) combatants.append(battleSide(opponent.is_you ? "You" : opponent.name, opponent, skillsById));
  arena.append(combatants);

  const recommendation = battleRecommendation(battle);
  const commandBar = document.createElement("div");
  commandBar.className = "battle-command-bar";
  appendText(commandBar, "strong", recommendation.label);
  appendText(commandBar, "span", recommendation.reason);
  arena.append(commandBar);

  els.battleState?.append(arena);
  renderBattleTimeline(battle, els.battleTimeline);

  setJson(els.battleOutput, {
    id: battle.id,
    mode: battle.mode,
    status: battle.status,
    turn: battle.turn_index,
    pending: battle.pending,
    assets: {
      player: battle.sides?.player?.asset ?? null,
      opponent: battle.sides?.opponent?.asset ?? null,
    },
    result: battle.result,
    latest_turn: asArray(battle.log).at(-1) ?? null,
    replay_hash: battle.replay_hash,
  });
}

function updateBattleTimerText() {
  const timer = document.querySelector("[data-battle-timer]");
  if (!timer || state.activeBattle?.status !== "in_progress") return;
  const deadline = state.activeBattle.turn_deadline_at;
  const secondsLeft = deadline ? Math.max(0, Math.ceil((new Date(deadline).getTime() - Date.now()) / 1000)) : null;
  timer.textContent = `${secondsLeft ?? "?"}s left`;
  timer.dataset.urgent = secondsLeft !== null && secondsLeft <= 8 ? "true" : "false";
}

function battleSide(label, side, skillsById = new Map()) {
  const wrapper = document.createElement("div");
  wrapper.className = "battle-side";
  if (side.is_you) wrapper.classList.add("is-you");
  const header = document.createElement("div");
  header.className = "battle-side-header";
  appendText(header, "strong", safeText(label));
  appendText(header, "span", elementLine(side), "element-chip");
  wrapper.append(header);
  const visual = document.createElement("div");
  visual.className = "battle-pet-visual";
  const img = document.createElement("img");
  img.alt = "";
  img.src = side.asset?.atlas_url || "/pet-placeholder.svg";
  img.className = side.asset?.atlas_url ? "sprite-atlas" : "";
  visual.append(img);
  const assetMeta = document.createElement("div");
  assetMeta.className = "battle-asset-meta";
  appendText(assetMeta, "span", assetLabel(side.asset));
  appendText(assetMeta, "span", shortHash(side.asset?.source_fingerprint ?? side.asset?.atlas_sha256 ?? side.asset?.hash));
  visual.append(assetMeta);
  wrapper.append(visual);
  wrapper.append(meter(Number(side.hp ?? 0), Number(side.max_hp ?? 1), "bar hp-bar"));
  const vitals = document.createElement("div");
  vitals.className = "battle-vitals";
  vitals.append(vitalChip("HP", `${side.hp ?? 0}/${side.max_hp ?? 0}`));
  vitals.append(vitalChip("Energy", energyPips(Number(side.energy ?? 0)), true));
  vitals.append(vitalChip("Focus", side.focus_stack ?? 0));
  vitals.append(vitalChip("AFK", `${side.timeout_count ?? 0}/3`));
  wrapper.append(vitals);

  const skillRow = document.createElement("div");
  skillRow.className = "battle-skill-row";
  for (const skillId of asArray(side.skills).slice(0, 4)) {
    const official = skillsById.get(skillId)?.officialName ?? skillId;
    const alias = side.skill_aliases?.[skillId];
    appendText(skillRow, "span", alias ? `${alias} · ${official}` : official);
  }
  wrapper.append(skillRow);
  return wrapper;
}

function battleCenter(battle, secondsLeft) {
  const center = document.createElement("div");
  center.className = "battle-center";
  appendText(center, "span", String(battle.mode ?? "battle"), "battle-mode-chip");
  appendText(center, "strong", `Turn ${battle.turn_index ?? 0}`, "battle-turn");
  const timer = appendText(
    center,
    "span",
    battle.status === "in_progress" ? `${secondsLeft ?? "?"}s left` : battle.result?.result ?? battle.status,
    "battle-countdown",
  );
  timer.dataset.battleTimer = "true";
  timer.dataset.urgent = secondsLeft !== null && secondsLeft <= 8 ? "true" : "false";
  if (battle.status === "in_progress") {
    appendText(center, "span", pendingText(battle, "player"), battle.pending?.player ? "pending-chip ready" : "pending-chip");
    appendText(center, "span", pendingText(battle, "opponent"), battle.pending?.opponent ? "pending-chip ready" : "pending-chip");
  } else if (battle.result) {
    appendText(center, "span", `${battle.result.reason ?? "complete"} · ${shortHash(battle.replay_hash)}`, "battle-result-chip");
  }
  return center;
}

function vitalChip(label, value, valueIsNode = false) {
  const chip = document.createElement("span");
  chip.className = "vital-chip";
  appendText(chip, "b", label);
  chip.append(document.createTextNode(" "));
  if (valueIsNode) {
    chip.append(value);
  } else {
    appendText(chip, "span", value);
  }
  return chip;
}

function energyPips(value) {
  const wrapper = document.createElement("span");
  wrapper.className = "energy-pips";
  for (let index = 0; index < 6; index += 1) {
    const pip = document.createElement("i");
    pip.dataset.on = index < value ? "true" : "false";
    wrapper.append(pip);
  }
  return wrapper;
}

function pendingText(battle, side) {
  const label = battle.sides?.[side]?.is_you ? "You" : title(side);
  return `${label}: ${battle.pending?.[side] ? "locked" : "waiting"}`;
}

function battleRecommendation(battle) {
  if (battle.status !== "in_progress") {
    return {
      label: `Result · ${battle.result?.result ?? battle.status}`,
      reason: battle.result?.reason ?? "Battle has finished.",
    };
  }
  const side = battle.viewer_side === "opponent" ? battle.sides?.opponent : battle.sides?.player;
  const pending = battle.viewer_side === "opponent" ? battle.pending?.opponent : battle.pending?.player;
  if (pending) {
    return { label: "Action Locked", reason: "Your action is submitted for this turn." };
  }
  const hpRatio = Number(side?.hp ?? 0) / Math.max(1, Number(side?.max_hp ?? 1));
  const deadline = "Submit before 30s; no action auto-guards, third miss is AFK.";
  if (hpRatio <= 0.32) return { label: "Recommended · Guard", reason: `Low HP. Guard reduces incoming damage and gains energy. ${deadline}` };
  if (Number(side?.energy ?? 0) < 2) return { label: "Recommended · Focus", reason: `Low energy. Focus builds enough energy for skill turns. ${deadline}` };
  return { label: "Recommended · Strike", reason: `Stable state. Strike gives reliable damage and gains energy. ${deadline}` };
}

function renderMatchmaking(result) {
  const activeTickets = asArray(result?.tickets);
  const activeBattles = asArray(result?.active_battles);
  renderMatchmakingCards(result, activeTickets, activeBattles);
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

function renderMatchmakingCards(result, tickets = [], activeBattles = []) {
  clear(els.matchmakingCards);
  if (!result) {
    renderEmpty(els.matchmakingCards, "No matchmaking activity.");
    return;
  }
  const displayTickets = tickets.length ? tickets : result.ticket ? [result.ticket] : [];
  const displayBattles = activeBattles.length ? activeBattles : result.battle ? [result.battle] : [];
  if (result.invite) {
    els.matchmakingCards?.append(statusCard("Invite", [
      ["Code", result.invite.code],
      ["Status", result.invite.status],
      ["Class", result.invite.battle_class],
      ["Expires", formatTime(result.invite.expires_at)],
    ]));
  }
  for (const ticket of displayTickets) {
    els.matchmakingCards?.append(statusCard("Queue", [
      ["Mode", ticket.mode],
      ["Status", ticket.status],
      ["Class", ticket.battle_class],
      ["LP", ticket.lp],
      ["Window", `±${ticket.search_window_lp ?? "?"}`],
      ["Wait", `${Math.floor(Number(ticket.wait_seconds ?? 0))}s`],
    ]));
  }
  for (const battle of displayBattles) {
    els.matchmakingCards?.append(statusCard("Battle", [
      ["Mode", battle.mode],
      ["Status", battle.status],
      ["Side", battle.viewer_side],
      ["Room", shortId(battle.id)],
    ]));
  }
  if (!result.invite && !displayTickets.length && !displayBattles.length) {
    renderEmpty(els.matchmakingCards, result.status ?? "No matchmaking activity.");
  }
}

function renderReplays() {
  clear(els.replayList);
  const pet = activePet();
  if (!pet) {
    renderEmpty(els.replayList, "No pet selected.");
    return;
  }
  const replays = state.replaysByPetId.get(pet.id) ?? [];
  if (!replays.length) {
    renderEmpty(els.replayList, "No finished replays yet.");
    return;
  }
  for (const replay of replays.slice(0, 8)) {
    const item = document.createElement("div");
    item.className = "timeline-item replay-item";
    const header = document.createElement("div");
    appendText(header, "strong", `${replay.mode ?? "battle"} · ${replay.result ?? EMPTY_LABEL}`);
    appendText(header, "span", replay.lp ? `${replay.lp.delta ?? 0} LP · ${replay.turn_count ?? 0} turns` : `${replay.pet_xp_delta ?? 0} XP · ${replay.turn_count ?? 0} turns`);
    item.append(header);
    appendText(item, "div", `${shortId(replay.room_id ?? replay.battle_id)} · ${shortHash(replay.replay_hash)} · ${formatDateTime(replay.created_at)}`, "timeline-meta");
    if (asArray(replay.integrity_flags).length) appendText(item, "div", `Integrity ${asArray(replay.integrity_flags).join(", ")}`, "timeline-meta");
    const latest = asArray(replay.log).at(-1);
    if (latest) item.append(turnLogItem(latest));
    els.replayList?.append(item);
  }
}

function renderLeaderboard(rows) {
  clear(els.leaderboardBody);
  fillLeaderboardFilters(rows);
  const tierFilter = els.leaderboardTierFilter?.value ?? "all";
  const classFilter = els.leaderboardClassFilter?.value ?? "all";
  const list = asArray(rows).filter(
    (row) =>
      (tierFilter === "all" || row.tier_label?.startsWith(tierFilter) || row.tier_label === tierFilter) &&
      (classFilter === "all" || row.battle_class === classFilter),
  );
  if (!list.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 7;
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
      row.publish_state ?? "published",
      `${row.wins ?? 0}/${row.losses ?? 0}/${row.draws ?? 0}`,
    ]) {
      appendText(tr, "td", safeText(value));
    }
    els.leaderboardBody?.append(tr);
  }
}

function fillLeaderboardFilters(rows) {
  const tierValue = els.leaderboardTierFilter?.value ?? "all";
  const classValue = els.leaderboardClassFilter?.value ?? "all";
  const tiers = [...new Set(asArray(rows).map((row) => String(row.tier_label ?? "").split(" ")[0]).filter(Boolean))].sort();
  const classes = [...new Set(asArray(rows).map((row) => row.battle_class).filter(Boolean))].sort();
  replaceOptions(els.leaderboardTierFilter, [{ value: "all", label: "All Tiers" }, ...tiers.map((tier) => ({ value: tier, label: tier }))], tierValue);
  replaceOptions(els.leaderboardClassFilter, [{ value: "all", label: "All Classes" }, ...classes.map((entry) => ({ value: entry, label: entry }))], classValue);
}

function renderEvents(events) {
  clear(els.eventLog);
  clear(els.dashboardEventFeed);
  const list = asArray(events);
  if (!list.length) {
    renderEmpty(els.eventLog, "No server events yet.");
    renderEmpty(els.dashboardEventFeed, "Import and bridge checks run through CLI/MCP.");
    return;
  }
  for (const [index, event] of list.entries()) {
    els.eventLog?.append(eventItem(event));
    if (index === 0) renderEmpty(els.dashboardEventFeed, "Import and bridge checks run through CLI/MCP.");
  }
}

function eventItem(event, className = "event-item") {
  const item = document.createElement("div");
  item.className = className;
  appendText(item, "strong", formatTime(event.created_at));
  appendText(item, "span", `${event.type ?? "event"} · ${safeJson(event.payload)}`);
  return item;
}

function renderAdminConsole() {
  if (els.adminPanel) els.adminPanel.hidden = !isAdmin();
  if (!isAdmin()) return;
  clear(els.adminSummary);
  clear(els.adminAuditFindings);
  clear(els.adminReviewCases);
  clear(els.adminHistory);
  const consoleState = state.adminConsole;
  if (!consoleState) {
    renderEmpty(els.adminReviewCases, "Admin console not loaded.");
    return;
  }
  const summary = [
    ["Review Cases", consoleState.review_cases?.length ?? 0],
    ["Held Reports", consoleState.held_training_reports?.length ?? 0],
    ["Abuse Alerts", consoleState.abuse_alerts?.length ?? 0],
    ["Linked", consoleState.linked_account_cases?.length ?? 0],
    ["Competitive", consoleState.competitive_integrity_cases?.length ?? 0],
    ["Moderation", consoleState.moderation_queue?.length ?? 0],
    ["Audit Findings", consoleState.audit?.findings?.length ?? 0],
    ["Suspicious", consoleState.suspicious_accounts?.length ?? 0],
  ];
  for (const [label, value] of summary) {
    const item = document.createElement("div");
    appendText(item, "strong", label);
    appendText(item, "div", value);
    els.adminSummary?.append(item);
  }
  renderAdminAudit(consoleState);
  const alertCases = asArray(consoleState.abuse_alerts).map((alert) => ({
    id: `case_${alert.id}`,
    kind: "abuse_alert",
    priority: alert.severity ?? "medium",
    account_id: alert.account_id,
    subject_id: alert.id,
    status: alert.status,
    reason: `${alert.kind ?? "alert"} · ${safeJson(alert.summary)}`,
    created_at: alert.created_at,
  }));
  const allCases = [...asArray(consoleState.review_cases), ...alertCases];
  const filter = els.adminCaseFilter?.value ?? "all";
  const cases = filter === "all" ? allCases : allCases.filter((item) => item.kind === filter);
  if (!cases.length) {
    renderEmpty(els.adminReviewCases, "No open review cases.");
  }
  for (const item of cases.slice(0, 12)) {
    const row = document.createElement("div");
    row.className = "review-item";
    const text = document.createElement("div");
    appendText(text, "strong", `${item.kind} · ${item.priority}`);
    appendText(text, "div", `${item.subject_id} · ${item.reason}`, "timeline-meta");
    appendText(text, "div", `Account ${item.account_id ?? EMPTY_LABEL} · ${formatDateTime(item.created_at)}`, "timeline-meta");
    if (item.risk_score !== undefined) appendText(text, "div", `Risk ${item.risk_score} · ${asArray(item.risk_flags).join(", ")}`, "timeline-meta");
    if (item.integrity) appendText(text, "div", `24h risk ${item.integrity.risk_score_24h} · ${item.integrity.risk_events_24h} events`, "timeline-meta");
    if (item.evidence) {
      appendText(
        text,
        "div",
        `Evidence ${item.evidence.level} · ${item.evidence.context} · risk ${item.evidence.risk_score} · ranked ${item.evidence.ranked_lp_suppressed_count}`,
        "timeline-meta",
      );
      appendText(text, "div", `Accounts ${asArray(item.account_ids).join(" <-> ")}`, "timeline-meta");
      appendText(text, "div", `Reasons ${asArray(item.evidence.recent_events).map((event) => event.link_reason).join(", ")}`, "timeline-meta");
      appendText(text, "div", `${asArray(item.recommended_actions).join(", ")}`, "timeline-meta");
    }
    if (item.open_report_count !== undefined) appendText(text, "div", `${item.open_report_count} open reports · ${item.visibility}`, "timeline-meta");
    row.append(text);
    if (item.kind === "training_report") {
      const actions = document.createElement("div");
      const approve = document.createElement("button");
      approve.className = "secondary-button";
      approve.textContent = "Approve";
      approve.addEventListener("click", () => runAction(() => reviewTrainingReport(item.subject_id, "approve")));
      const reject = document.createElement("button");
      reject.className = "secondary-button";
      reject.textContent = "Reject";
      reject.addEventListener("click", () => runAction(() => reviewTrainingReport(item.subject_id, "reject")));
      actions.append(approve, reject);
      row.append(actions);
    } else if (item.kind === "linked_accounts" || item.kind === "competitive_integrity") {
      const actions = document.createElement("div");
      actions.append(
        adminActionButton("Watch", () => updateLinkedEnforcement(item.account_ids, "watch")),
        adminActionButton("Suppress", () => updateLinkedEnforcement(item.account_ids, "ranked_lp_suppress")),
        adminActionButton("Lock", () => updateLinkedEnforcement(item.account_ids, "ranked_lock")),
        adminActionButton("Clear", () => updateLinkedEnforcement(item.account_ids, "clear")),
      );
      const rollbackRoomId = item.kind === "competitive_integrity" ? asArray(item.evidence?.recent_events).find((event) => event.room_id)?.room_id : null;
      if (rollbackRoomId) actions.append(adminActionButton("Rollback", () => rollbackRankedRoom(rollbackRoomId)));
      row.append(actions);
    } else if (item.kind === "account_integrity") {
      const actions = document.createElement("div");
      actions.append(
        adminActionButton("Watch", () => updateEnforcement(item.account_id, "watch")),
        adminActionButton("Suppress", () => updateEnforcement(item.account_id, "ranked_lp_suppress")),
        adminActionButton("Lock", () => updateEnforcement(item.account_id, "ranked_lock")),
        adminActionButton("Unlock", () => updateEnforcement(item.account_id, "ranked_unlock")),
        adminActionButton("Clear", () => updateEnforcement(item.account_id, "clear")),
      );
      row.append(actions);
    } else if (item.kind === "asset_moderation") {
      const actions = document.createElement("div");
      const clearButton = document.createElement("button");
      clearButton.className = "secondary-button";
      clearButton.textContent = "Clear";
      clearButton.addEventListener("click", () => runAction(() => moderateAsset(item.subject_id, "clear")));
      const hideButton = document.createElement("button");
      hideButton.className = "secondary-button";
      hideButton.textContent = "Hide";
      hideButton.addEventListener("click", () => runAction(() => moderateAsset(item.subject_id, "hide")));
      actions.append(clearButton, hideButton);
      row.append(actions);
    } else {
      appendText(row, "span", item.status);
    }
    els.adminReviewCases?.append(row);
  }
  renderAdminHistory(consoleState);
  setJson(els.adminOutput, state.adminOutput ?? {
    ops: consoleState.ops,
    audit_ok: consoleState.audit?.ok,
    auth_provider: consoleState.auth_provider,
    bridge_attestation: consoleState.bridge_attestation,
  });
}

function adminActionButton(label, action) {
  const button = document.createElement("button");
  button.className = "secondary-button";
  button.textContent = label;
  button.addEventListener("click", () => runAction(action));
  return button;
}

function renderAdminAudit(consoleState) {
  const findings = asArray(consoleState.audit?.findings);
  const box = document.createElement("div");
  box.className = "admin-block";
  appendText(box, "strong", "Audit");
  if (!findings.length) {
    appendText(box, "div", "OK", "timeline-meta");
  } else {
    for (const finding of findings.slice(0, 6)) {
      appendText(box, "div", `${finding.severity} · ${finding.code} · ${finding.message}`, "timeline-meta");
    }
  }
  els.adminAuditFindings?.append(box);

  const accounts = asArray(consoleState.suspicious_accounts);
  const accountBox = document.createElement("div");
  accountBox.className = "admin-block";
  appendText(accountBox, "strong", "Accounts");
  if (!accounts.length) {
    appendText(accountBox, "div", "Clear", "timeline-meta");
  } else {
    for (const account of accounts.slice(0, 6)) {
      appendText(accountBox, "div", `${account.account_id} · ${account.level} · risk ${account.risk_score_24h}`, "timeline-meta");
    }
  }
  els.adminAuditFindings?.append(accountBox);
}

function renderAdminHistory(consoleState) {
  const histories = [
    ["Enforcement", consoleState.recent_enforcement_events],
    ["Moderation", consoleState.recent_moderation_events],
    ["Risk Events", consoleState.recent_risk_events],
  ];
  for (const [label, entries] of histories) {
    const box = document.createElement("div");
    box.className = "admin-block";
    appendText(box, "strong", label);
    const list = asArray(entries);
    if (!list.length) {
      appendText(box, "div", "No recent entries.", "timeline-meta");
    }
    for (const entry of list.slice(0, 5)) {
      const type = entry.type ?? entry.kind ?? entry.id ?? "entry";
      const detail = entry.payload ? safeJson(entry.payload) : entry.metadata ? safeJson(entry.metadata) : safeJson(entry.summary);
      appendText(box, "div", `${formatTime(entry.created_at)} · ${type} · ${detail}`, "timeline-meta");
    }
    els.adminHistory?.append(box);
  }
}

function updateControls() {
  const hasPet = Boolean(activePet());
  const hasSkill = Boolean(els.battleSkillSelect?.value);
  const signedIn = isSignedIn();
  const battleReady = state.activeBattle?.status === "in_progress";
  const ownPending =
    state.activeBattle?.viewer_side === "opponent" ? state.activeBattle?.pending?.opponent : state.activeBattle?.pending?.player;
  const disableWhenNoPet = [
    els.draftReportButton,
    els.submitReportButton,
    els.startBattleButton,
    els.joinQueueButton,
    els.queueStatusButton,
    els.cancelQueueButton,
    els.createInviteButton,
    els.acceptInviteButton,
    els.replayRefreshButton,
    els.saveAliasesButton,
  ];
  for (const control of disableWhenNoPet) {
    if (control) control.disabled = state.busy || !signedIn || !hasPet;
  }
  for (const button of els.actionButtons ?? []) {
    button.disabled = state.busy || !signedIn || !state.activeBattleId || !battleReady || ownPending || (button.dataset.action === "skill" && !hasSkill);
  }
  for (const control of [els.seedPetButton, els.refreshButton]) {
    if (control) control.disabled = state.busy || !signedIn;
  }
  if (els.petSelect) {
    els.petSelect.disabled = state.busy || !signedIn || (state.activePetSelectionLocked && Boolean(state.activePetId));
    els.petSelect.title = state.activePetSelectionLocked ? "League pet selection is permanent for this account." : "";
  }
  for (const control of [els.adminRefreshButton, els.adminRunOpsButton, els.adminCaseFilter]) {
    if (control) control.disabled = state.busy || !isAdmin();
  }
  for (const control of [els.authIdentifierInput, els.authChallengeButton, els.authCodeInput, els.authVerifyButton]) {
    if (control) control.disabled = state.busy;
  }
  if (els.authOpenButton) els.authOpenButton.disabled = state.busy;
}

function fillElements() {
  // Element pickers live in the CLI/MCP hatch import flow for the public alpha.
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

function renderBattleTimeline(battle, target) {
  clear(target);
  const log = asArray(battle?.log);
  if (!log.length) {
    renderEmpty(target, "Turn log pending.");
    return;
  }
  for (const turn of log.slice(-6).reverse()) {
    target?.append(turnLogItem(turn, battle));
  }
}

function turnLogItem(turn, battle = null) {
  const item = document.createElement("div");
  item.className = "timeline-item";
  const titleRow = document.createElement("div");
  appendText(titleRow, "strong", `Turn ${turn.turn ?? EMPTY_LABEL}`);
  appendText(titleRow, "span", formatTime(turn.resolved_at));
  item.append(titleRow);

  const actions = turn.actions ?? {};
  const playerName = battle?.sides?.player?.is_you ? "You" : battle?.sides?.player?.name ?? "Player";
  const opponentName = battle?.sides?.opponent?.is_you ? "You" : battle?.sides?.opponent?.name ?? "Opponent";
  appendText(item, "div", `${playerName}: ${actionLabel(actions.player)} · ${opponentName}: ${actionLabel(actions.opponent)}`, "timeline-meta");

  const effects = asArray(turn.effects)
    .map((effect) => `${title(effect.side)} ${effect.damage ?? 0} dmg${effect.self_heal ? `, ${effect.self_heal} heal` : ""}`)
    .join(" · ");
  appendText(item, "div", effects || "No effects.", "timeline-meta");
  return item;
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
  const method = options.method ?? "GET";
  const body = options.body ? { ...options.body } : undefined;
  if (body && method !== "GET" && !body.request_id) body.request_id = randomId();
  const response = await fetch(path, {
    method,
    headers: { "content-type": "application/json", "x-league-device-id": leagueDeviceId() },
    credentials: "same-origin",
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const payload = text ? parseJson(text) : {};
  if (!response.ok) {
    const retriesLeft = options.leaseRetries ?? 2;
    if (payload.error?.code === "LEASE_BUSY" && retriesLeft > 0) {
      await sleep(180);
      return api(path, { ...options, leaseRetries: retriesLeft - 1 });
    }
    const message = payload.error?.message ?? payload.message ?? `API request failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    error.code = payload.error?.code;
    error.payload = payload;
    throw error;
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

function isSignedIn() {
  return Boolean(state.session?.account);
}

function isAdmin() {
  return state.session?.account?.role === "admin";
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

function statusCard(titleText, rows) {
  const item = document.createElement("div");
  item.className = "status-card";
  appendText(item, "strong", titleText);
  for (const [label, value] of rows) {
    const row = document.createElement("div");
    appendText(row, "span", label);
    appendText(row, "b", value);
    item.append(row);
  }
  return item;
}

function skillLabel(skillOrId) {
  const skill =
    typeof skillOrId === "string"
      ? asArray(activePet()?.skills).find((entry) => entry.id === skillOrId) ?? { id: skillOrId }
      : skillOrId ?? {};
  const official = skill.officialName ?? skill.skill_name ?? skill.id ?? "skill";
  return skill.alias ? `${skill.alias} (${official})` : official;
}

function assetLabel(asset) {
  const source = asset?.source ?? asset?.hatch_source ?? asset?.asset_kind ?? "asset";
  const hatchId = asset?.hatch_pet_id ?? asset?.hatch_pet_json?.id ?? asset?.provenance?.hatch_pet_id;
  return hatchId ? `${source} · ${hatchId}` : source;
}

function actionLabel(action) {
  if (!action) return "pending";
  if (action.kind === "skill") {
    const equipped = asArray(activePet()?.skills).find((skill) => skill.id === action.skill_id);
    return skillLabel(equipped ?? { id: action.skill_id, skill_name: action.skill_name, alias: action.skill_alias });
  }
  return action.kind ?? "action";
}

function shortId(value) {
  const text = String(value ?? EMPTY_LABEL);
  if (text.length <= 14) return text;
  return `${text.slice(0, 8)}...${text.slice(-4)}`;
}

function shortHash(value) {
  const text = String(value ?? EMPTY_LABEL);
  if (text.length <= 16) return text;
  return `${text.slice(0, 10)}...`;
}

function queryElements(selectors) {
  return Object.fromEntries(
    Object.entries(selectors).map(([key, selector]) => [
      key,
      ["[data-action]", "[data-tab]", "[data-tab-jump]", "[data-view]"].includes(selector)
        ? document.querySelectorAll(selector)
        : document.querySelector(selector),
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
  fill.style.width = `${percent(value, cap)}%`;
  bar.append(fill);
  return bar;
}

function percent(value, cap) {
  return cap > 0 ? Math.min(100, Math.max(0, Math.round((value / cap) * 100))) : 0;
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
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--:--:--" : date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
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

function leagueDeviceId() {
  try {
    const existing = localStorage.getItem(DEVICE_STORAGE_KEY);
    if (existing) return existing;
    const next = `device_${randomId()}`;
    localStorage.setItem(DEVICE_STORAGE_KEY, next);
    return next;
  } catch {
    return `device_${randomId()}`;
  }
}
