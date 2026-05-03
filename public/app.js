const state = {
  rules: null,
  pets: [],
  activePetId: null,
};

const els = {
  sessionLabel: document.querySelector("#sessionLabel"),
  petSelect: document.querySelector("#petSelect"),
  seedPetButton: document.querySelector("#seedPetButton"),
  petNameInput: document.querySelector("#petNameInput"),
  primaryElementInput: document.querySelector("#primaryElementInput"),
  secondaryElementInput: document.querySelector("#secondaryElementInput"),
  atlasFileInput: document.querySelector("#atlasFileInput"),
  createPetButton: document.querySelector("#createPetButton"),
  petTitle: document.querySelector("#petTitle"),
  petSubtitle: document.querySelector("#petSubtitle"),
  classPill: document.querySelector("#classPill"),
  rankPill: document.querySelector("#rankPill"),
  statList: document.querySelector("#statList"),
  xpStatus: document.querySelector("#xpStatus"),
  resetText: document.querySelector("#resetText"),
  refreshButton: document.querySelector("#refreshButton"),
  draftReportButton: document.querySelector("#draftReportButton"),
  submitReportButton: document.querySelector("#submitReportButton"),
  trainingPreview: document.querySelector("#trainingPreview"),
  simulateBattleButton: document.querySelector("#simulateBattleButton"),
  battleOutput: document.querySelector("#battleOutput"),
  leaderboardBody: document.querySelector("#leaderboardBody"),
  eventLog: document.querySelector("#eventLog"),
};

await boot();

async function boot() {
  const [session, rules] = await Promise.all([api("/api/session"), api("/api/rules")]);
  state.rules = rules;
  els.sessionLabel.textContent = `${session.account.displayName} · verified`;
  fillElements();
  bindEvents();
  await refresh();
}

function bindEvents() {
  els.petSelect.addEventListener("change", async () => {
    state.activePetId = els.petSelect.value;
    await renderActivePet();
  });
  els.seedPetButton.addEventListener("click", () => createPet({ demo: true }));
  els.createPetButton.addEventListener("click", () => createPet({ demo: false }));
  els.refreshButton.addEventListener("click", refresh);
  els.draftReportButton.addEventListener("click", draftTrainingReport);
  els.submitReportButton.addEventListener("click", submitTrainingReport);
  els.simulateBattleButton.addEventListener("click", simulateBattle);
}

async function refresh() {
  const [petsResult, board, events] = await Promise.all([
    api("/api/pets"),
    api("/api/leaderboard"),
    api("/api/events"),
  ]);
  state.pets = petsResult.pets;
  if (!state.activePetId && state.pets[0]) state.activePetId = state.pets[0].id;
  renderPetSelect();
  await renderActivePet();
  renderLeaderboard(board.leaderboard);
  renderEvents(events.events);
}

function fillElements() {
  for (const select of [els.primaryElementInput, els.secondaryElementInput]) {
    select.innerHTML = "";
    for (const element of state.rules.elements) {
      const option = document.createElement("option");
      option.value = element;
      option.textContent = element;
      select.append(option);
    }
  }
  els.primaryElementInput.value = "Forge";
  els.secondaryElementInput.value = "Trace";
}

function renderPetSelect() {
  els.petSelect.innerHTML = "";
  if (state.pets.length === 0) {
    const option = document.createElement("option");
    option.textContent = "No pets yet";
    option.value = "";
    els.petSelect.append(option);
    return;
  }
  for (const pet of state.pets) {
    const option = document.createElement("option");
    option.value = pet.id;
    option.textContent = `${pet.name} · ${pet.battle_class}`;
    option.selected = pet.id === state.activePetId;
    els.petSelect.append(option);
  }
}

async function renderActivePet() {
  const pet = activePet();
  if (!pet) {
    els.petTitle.textContent = "No pet registered";
    els.petSubtitle.textContent = "Create a pet to start testing the League loop.";
    els.classPill.textContent = "Class -";
    els.rankPill.textContent = "Rank -";
    els.statList.innerHTML = "";
    els.xpStatus.innerHTML = "";
    return;
  }

  els.petTitle.textContent = pet.name;
  els.petSubtitle.textContent = `${pet.primary_element}${pet.secondary_element ? ` + ${pet.secondary_element}` : ""} · Lv ${pet.level}`;
  els.classPill.textContent = pet.battle_class.toUpperCase();
  els.rankPill.textContent = `${pet.rating.label} · ${pet.rating.lp} LP`;
  renderStats(pet);
  await renderXpStatus(pet.id);
}

function renderStats(pet) {
  const max = Math.max(...["power", "guard", "speed", "focus", "recovery", "insight"].map((key) => pet.stats[key]));
  els.statList.innerHTML = "";
  for (const stat of ["power", "guard", "speed", "focus", "recovery", "insight"]) {
    const row = document.createElement("div");
    row.className = "stat-row";
    row.innerHTML = `
      <strong>${title(stat)}</strong>
      <span class="bar"><span style="width:${Math.round((pet.stats[stat] / max) * 100)}%"></span></span>
      <span>${pet.stats[stat]}</span>
    `;
    els.statList.append(row);
  }
}

async function renderXpStatus(petId) {
  const status = await api(`/api/pets/${petId}/xp-status`);
  const rows = [
    ["Pet XP", status.counters.petDaily, status.caps.petDaily],
    ["Training", status.counters.trainingDaily, status.caps.trainingDaily],
    ["Battle", status.counters.battleDaily, status.caps.battleDaily],
    ["Friend", status.counters.friendDaily, status.caps.friendDaily],
    ["Reports", status.counters.trainingReportsUsed, status.caps.petEligibleTrainingReportsDaily],
    ["Style", status.counters.styleDaily, status.caps.styleDaily],
    ["Week Style", status.counters.styleWeekly, status.caps.styleWeekly],
  ];
  els.xpStatus.innerHTML = "";
  for (const [label, value, cap] of rows) {
    const percent = cap === Infinity ? 0 : Math.min(100, Math.round((value / cap) * 100));
    const row = document.createElement("div");
    row.className = "meter-row";
    row.innerHTML = `
      <strong>${label}</strong>
      <span class="bar"><span style="width:${percent}%"></span></span>
      <span>${value}/${cap}</span>
    `;
    els.xpStatus.append(row);
  }
  els.resetText.textContent = `Daily reset: ${new Date(status.reset_at).toLocaleString()}`;
}

async function createPet({ demo }) {
  const name = demo ? "Pebble" : els.petNameInput.value;
  const primary = demo ? "Forge" : els.primaryElementInput.value;
  const secondary = demo ? "Trace" : els.secondaryElementInput.value;
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
      pet_asset_id: asset.asset.id,
      primary_element: primary,
      secondary_element: secondary,
    },
  });
  state.activePetId = pet.pet.id;
  await refresh();
}

async function draftTrainingReport() {
  const pet = activePet();
  if (!pet) return;
  const draft = await api(`/api/pets/${pet.id}/training-reports/draft`, {
    method: "POST",
    body: { signals: collectSignals() },
  });
  els.trainingPreview.textContent = JSON.stringify(draft.draft, null, 2);
}

async function submitTrainingReport() {
  const pet = activePet();
  if (!pet) return;
  const result = await api(`/api/pets/${pet.id}/training-reports`, {
    method: "POST",
    body: {
      client_report_id: crypto.randomUUID(),
      signals: collectSignals(),
    },
  });
  els.trainingPreview.textContent = JSON.stringify(
    {
      applied: {
        pet_xp: result.report?.pet_xp_delta,
        style_xp: result.report?.style_xp_delta,
      },
      pet: summarizePet(result.pet),
      counters: result.counters,
    },
    null,
    2,
  );
  await refresh();
}

async function simulateBattle() {
  const pet = activePet();
  if (!pet) return;
  const result = await api(`/api/pets/${pet.id}/battles/simulate`, {
    method: "POST",
    body: {
      mode: document.querySelector("#battleMode").value,
      result: document.querySelector("#battleResult").value,
      opponent_lp: Number(document.querySelector("#opponentLp").value),
    },
  });
  els.battleOutput.textContent = JSON.stringify(
    {
      battle: result.battle,
      pet: summarizePet(result.pet),
      counters: result.counters,
    },
    null,
    2,
  );
  await refresh();
}

function collectSignals() {
  return {
    implementationActivity: document.querySelector("#implementationActivity").checked,
    debuggingActivity: document.querySelector("#debuggingActivity").checked,
    verificationActivity: document.querySelector("#verificationActivity").checked,
    docsActivity: document.querySelector("#docsActivity").checked,
    releaseActivity: document.querySelector("#releaseActivity").checked,
    milestone: document.querySelector("#milestone").checked,
    filesChangedBucket: document.querySelector("#filesChangedBucket").value,
    testsRun: Number(document.querySelector("#testsRun").value),
  };
}

function readAtlasDataUrl() {
  const file = els.atlasFileInput.files?.[0];
  if (!file) return null;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

function renderLeaderboard(rows) {
  els.leaderboardBody.innerHTML = "";
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.rank}</td>
      <td>${row.name}</td>
      <td>${row.battle_class}</td>
      <td>${row.tier_label}</td>
      <td>${row.lp}</td>
      <td>${row.wins}/${row.losses}/${row.draws}</td>
    `;
    els.leaderboardBody.append(tr);
  }
}

function renderEvents(events) {
  els.eventLog.innerHTML = "";
  for (const event of events) {
    const item = document.createElement("div");
    item.className = "event-item";
    item.innerHTML = `
      <strong>${new Date(event.created_at).toLocaleTimeString()}</strong>
      <span>${event.type} · ${JSON.stringify(event.payload)}</span>
    `;
    els.eventLog.append(item);
  }
}

function activePet() {
  return state.pets.find((pet) => pet.id === state.activePetId) ?? null;
}

function summarizePet(pet) {
  return {
    name: pet.name,
    level: pet.level,
    mastery_level: pet.mastery_level,
    battle_class: pet.battle_class,
    xp: pet.xp,
    style_xp: pet.style_xp,
    stats_total: pet.stats.total,
    rank: pet.rating.label,
    lp: pet.rating.lp,
  };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: { "content-type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error?.message ?? "API request failed");
  }
  return payload;
}

function title(value) {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}
