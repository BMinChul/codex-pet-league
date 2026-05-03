export const ELEMENTS = ["Logic", "Patch", "Trace", "Forge", "Pulse", "Deploy"];

export const ELEMENT_ADVANTAGE = {
  Logic: "Pulse",
  Pulse: "Trace",
  Trace: "Deploy",
  Deploy: "Patch",
  Patch: "Forge",
  Forge: "Logic",
};

export const STARTING_TEMPLATES = {
  Logic: { power: 13, guard: 14, speed: 15, focus: 22, recovery: 13, insight: 23 },
  Patch: { power: 13, guard: 22, speed: 13, focus: 15, recovery: 23, insight: 14 },
  Trace: { power: 13, guard: 14, speed: 22, focus: 14, recovery: 13, insight: 24 },
  Forge: { power: 24, guard: 20, speed: 13, focus: 14, recovery: 13, insight: 16 },
  Pulse: { power: 14, guard: 13, speed: 24, focus: 22, recovery: 13, insight: 14 },
  Deploy: { power: 23, guard: 13, speed: 14, focus: 16, recovery: 13, insight: 21 },
};

const GROWTH_WEIGHTS = {
  Logic: { power: 0.05, guard: 0.1, speed: 0.1, focus: 0.35, recovery: 0.05, insight: 0.35 },
  Patch: { power: 0.05, guard: 0.28, speed: 0.05, focus: 0.12, recovery: 0.35, insight: 0.15 },
  Trace: { power: 0.05, guard: 0.08, speed: 0.28, focus: 0.12, recovery: 0.07, insight: 0.4 },
  Forge: { power: 0.36, guard: 0.24, speed: 0.06, focus: 0.1, recovery: 0.08, insight: 0.16 },
  Pulse: { power: 0.08, guard: 0.05, speed: 0.36, focus: 0.3, recovery: 0.08, insight: 0.13 },
  Deploy: { power: 0.32, guard: 0.08, speed: 0.08, focus: 0.16, recovery: 0.08, insight: 0.28 },
};

export const TRAINING_REPORT_XP = {
  light: 30,
  standard: 70,
  major: 120,
  milestone: 180,
};

export const BATTLE_XP = {
  ranked: { win: 80, draw: 60, loss: 45, afk_loss: 0 },
  casual: { win: 60, draw: 45, loss: 35, afk_loss: 0 },
  friend: { complete: 25, win: 25, draw: 25, loss: 25, afk_loss: 0 },
  training: { complete: 30, win: 40, draw: 30, loss: 25, afk_loss: 0 },
};

export const XP_CAPS = {
  petDaily: 700,
  trainingDaily: 400,
  battleDaily: 300,
  friendDaily: 75,
  styleDaily: 1000,
  styleWeekly: 5000,
  petEligibleTrainingReportsDaily: 3,
};

export const LEVEL_XP_TABLE = [
  { min: 1, max: 10, xpToNext: 100 },
  { min: 11, max: 25, xpToNext: 250 },
  { min: 26, max: 45, xpToNext: 450 },
  { min: 46, max: 65, xpToNext: 650 },
  { min: 66, max: 80, xpToNext: 850 },
  { min: 81, max: 90, xpToNext: 1050 },
  { min: 91, max: 99, xpToNext: 1300 },
];

export const SKILL_CATALOG_ROLES = ["offense", "defense", "status", "tempo", "finisher"];

export const OFFICIAL_SKILLS = ELEMENTS.flatMap((element) =>
  SKILL_CATALOG_ROLES.map((role) => ({
    id: `${element.toLowerCase()}_${role}`,
    element,
    role,
    officialName: skillNameFor(element, role),
  })),
);

export function assertElement(element) {
  if (!ELEMENTS.includes(element)) {
    throw new Error(`Unknown element: ${element}`);
  }
}

export function totalXpForLevel100() {
  let total = 0;
  for (let level = 1; level < 100; level += 1) {
    total += xpToNextLevel(level);
  }
  return total;
}

export function xpToNextLevel(level) {
  if (level >= 100) return 2500;
  const band = LEVEL_XP_TABLE.find((entry) => level >= entry.min && level <= entry.max);
  if (!band) throw new Error(`Missing XP table entry for level ${level}`);
  return band.xpToNext;
}

export function progressionFromXp(xp) {
  let remaining = Math.max(0, Math.floor(xp));
  let level = 1;

  while (level < 100) {
    const needed = xpToNextLevel(level);
    if (remaining < needed) break;
    remaining -= needed;
    level += 1;
  }

  if (level < 100) {
    return {
      level,
      masteryLevel: 0,
      xpIntoLevel: remaining,
      xpToNext: xpToNextLevel(level),
    };
  }

  const masteryLevel = Math.floor(remaining / 2500);
  return {
    level: 100,
    masteryLevel,
    xpIntoLevel: remaining % 2500,
    xpToNext: 2500,
  };
}

export function totalStatsForLevel(level) {
  return 100 + (Math.min(100, Math.max(1, level)) - 1) * 2;
}

export function battleClassForTotalStats(totalStats) {
  if (totalStats <= 139) return "hatch";
  if (totalStats <= 179) return "core";
  if (totalStats <= 219) return "surge";
  if (totalStats <= 259) return "apex";
  return "prime";
}

export function deriveStats({ primaryElement, secondaryElement = null, level = 1 }) {
  assertElement(primaryElement);
  if (secondaryElement) assertElement(secondaryElement);

  const base = { ...STARTING_TEMPLATES[primaryElement] };
  const growthPoints = totalStatsForLevel(level) - 100;
  if (growthPoints <= 0) return withTotal(base);

  const weights = blendGrowthWeights(primaryElement, secondaryElement);
  const allocated = allocateIntegerPoints(growthPoints, weights);
  for (const stat of Object.keys(base)) {
    base[stat] += allocated[stat] ?? 0;
  }
  return withTotal(base);
}

export function elementModifier(attacker, defender) {
  const primary = elementPairModifier(attacker.primaryElement, defender.primaryElement) * 0.1;
  const secondary =
    attacker.secondaryElement && defender.secondaryElement
      ? elementPairModifier(attacker.secondaryElement, defender.secondaryElement) * 0.05
      : 0;
  return clamp(round(primary + secondary, 3), -0.15, 0.15);
}

export function tierForLp(lp) {
  const value = Math.max(0, Math.floor(lp));
  if (value >= 6000) return { tier: "Codex", division: null, label: "Codex" };

  const tiers = ["Bronze", "Silver", "Gold", "Platinum", "Diamond", "Mythic"];
  const tierIndex = Math.floor(value / 1000);
  const tierBase = tierIndex * 1000;
  const divisionOffset = value - tierBase;
  const division = divisionOffset <= 333 ? 1 : divisionOffset <= 666 ? 2 : 3;
  const tier = tiers[Math.min(tierIndex, tiers.length - 1)];
  return { tier, division, label: `${tier} ${division}` };
}

export function lpDelta({ result, playerLp, opponentLp, placement = false }) {
  let delta = 0;
  if (result === "win") delta = 25;
  if (result === "loss") delta = -25;
  if (result === "draw") delta = 0;
  if (result === "afk_loss") delta = -40;

  const diff = opponentLp - playerLp;
  if (result === "win" && diff >= 400) delta += 10;
  else if (result === "win" && diff >= 200) delta += 5;
  else if (result === "win" && diff <= -400) delta -= 5;

  if (result === "loss" && diff <= -400) delta -= 10;
  else if (result === "loss" && diff <= -200) delta -= 5;
  else if (result === "loss" && diff >= 400) delta += 5;

  if (placement) {
    return clamp(delta * 2, -90, 90);
  }
  return clamp(delta, -45, 45);
}

export function classifyTrainingReport(signals = {}) {
  const score =
    scoreBucket(signals.filesChangedBucket) +
    Math.min(30, Number(signals.testsRun ?? 0) * 6) +
    boolScore(signals.implementationActivity, 24) +
    boolScore(signals.debuggingActivity, 18) +
    boolScore(signals.docsActivity, 10) +
    boolScore(signals.releaseActivity, 18) +
    boolScore(signals.verificationActivity, 16) +
    boolScore(signals.milestone, 50);

  const reportType = score >= 85 ? "milestone" : score >= 55 ? "major" : score >= 22 ? "standard" : "light";
  const elementSignal = inferElementSignal(signals);
  return { reportType, elementSignal, qualityScore: Math.min(100, score) };
}

export function calculateTrainingAward({ reportType, counters, isFirstDailyReport }) {
  const base = TRAINING_REPORT_XP[reportType] ?? TRAINING_REPORT_XP.light;
  const rawPetXp = Math.round(base * (isFirstDailyReport ? 1.2 : 1));
  const reportSlotsRemaining = Math.max(0, XP_CAPS.petEligibleTrainingReportsDaily - counters.trainingReportsUsed);
  const petEligible = reportSlotsRemaining > 0;

  const petRemaining = Math.max(0, XP_CAPS.petDaily - counters.petDaily);
  const trainingRemaining = Math.max(0, XP_CAPS.trainingDaily - counters.trainingDaily);
  const petXpApplied = petEligible ? Math.min(rawPetXp, petRemaining, trainingRemaining) : 0;
  const styleOverflow = rawPetXp - petXpApplied;
  const styleRemaining = Math.max(0, XP_CAPS.styleDaily - counters.styleDaily);
  const styleXpApplied = Math.min(styleOverflow, styleRemaining);

  return {
    basePetXp: base,
    rawPetXp,
    petEligible,
    petXpApplied,
    styleXpApplied,
    capped: petXpApplied < rawPetXp,
  };
}

export function calculateBattleAward({ mode, result, counters }) {
  const table = BATTLE_XP[mode] ?? BATTLE_XP.casual;
  const rawPetXp = table[result] ?? table.complete ?? 0;
  const petRemaining = Math.max(0, XP_CAPS.petDaily - counters.petDaily);
  const battleRemaining = Math.max(0, XP_CAPS.battleDaily - counters.battleDaily);
  const friendRemaining = mode === "friend" ? Math.max(0, XP_CAPS.friendDaily - counters.friendDaily) : Infinity;
  const petXpApplied = Math.min(rawPetXp, petRemaining, battleRemaining, friendRemaining);
  return { rawPetXp, petXpApplied, capped: petXpApplied < rawPetXp };
}

function skillNameFor(element, role) {
  const names = {
    Logic: {
      offense: "Predictive Read",
      defense: "Clean Proof",
      status: "Counterline",
      tempo: "Proof Net",
      finisher: "Checkmate Thread",
    },
    Patch: {
      offense: "Hotfix",
      defense: "Stabilize",
      status: "Rollback",
      tempo: "Safe Merge",
      finisher: "Recovery Loop",
    },
    Trace: {
      offense: "Expose Path",
      defense: "Breakpoint",
      status: "Signal Leak",
      tempo: "Stack Trace",
      finisher: "Watchpoint",
    },
    Forge: {
      offense: "Heavy Commit",
      defense: "Overclock",
      status: "Build Breaker",
      tempo: "Refactor Hammer",
      finisher: "Compile Surge",
    },
    Pulse: {
      offense: "Quick Loop",
      defense: "Charge Cycle",
      status: "Tempo Shift",
      tempo: "Interrupt Beat",
      finisher: "Rapid Retry",
    },
    Deploy: {
      offense: "Final Push",
      defense: "Release Burst",
      status: "Lock In",
      tempo: "Canary Drop",
      finisher: "Ship It",
    },
  };
  return names[element][role];
}

function inferElementSignal(signals) {
  const scores = {
    Logic: Number(signals.testsRun ?? 0) * 4 + boolScore(signals.verificationActivity, 18),
    Patch: boolScore(signals.recoveryActivity, 24) + boolScore(signals.bugfixActivity, 18),
    Trace: boolScore(signals.debuggingActivity, 24),
    Forge: boolScore(signals.implementationActivity, 24),
    Pulse: boolScore(signals.quickIterationActivity, 24),
    Deploy: boolScore(signals.docsActivity, 12) + boolScore(signals.releaseActivity, 24),
  };
  return Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
}

function elementPairModifier(attackerElement, defenderElement) {
  if (!attackerElement || !defenderElement) return 0;
  if (ELEMENT_ADVANTAGE[attackerElement] === defenderElement) return 1;
  if (ELEMENT_ADVANTAGE[defenderElement] === attackerElement) return -1;
  return 0;
}

function blendGrowthWeights(primaryElement, secondaryElement) {
  const primary = GROWTH_WEIGHTS[primaryElement];
  if (!secondaryElement) return primary;
  const secondary = GROWTH_WEIGHTS[secondaryElement];
  const blended = {};
  for (const stat of Object.keys(primary)) {
    blended[stat] = primary[stat] * 0.7 + secondary[stat] * 0.3;
  }
  return blended;
}

function allocateIntegerPoints(points, weights) {
  const allocation = {};
  const remainders = [];
  let used = 0;

  for (const [stat, weight] of Object.entries(weights)) {
    const exact = points * weight;
    const whole = Math.floor(exact);
    allocation[stat] = whole;
    used += whole;
    remainders.push([stat, exact - whole]);
  }

  remainders.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (let i = 0; i < points - used; i += 1) {
    allocation[remainders[i % remainders.length][0]] += 1;
  }

  return allocation;
}

function withTotal(stats) {
  return {
    ...stats,
    total: Object.values(stats).reduce((sum, value) => sum + value, 0),
  };
}

function scoreBucket(bucket) {
  if (bucket === "large") return 35;
  if (bucket === "medium") return 20;
  if (bucket === "small") return 8;
  return 0;
}

function boolScore(value, score) {
  return value ? score : 0;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
