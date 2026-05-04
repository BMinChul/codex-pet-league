import { createBattleRoomSnapshot, resolveTurnIfReady, submitAction } from "../src/domain/battleEngine.js";
import { deriveStats, ELEMENTS, OFFICIAL_SKILLS } from "../src/domain/rules.js";

const levels = [1, 25, 50, 100];
const timingScenarios = [
  { playerOffset: 0, opponentOffset: 1 },
  { playerOffset: 1, opponentOffset: 0 },
];
const results = [];

for (const level of levels) {
  for (const playerElement of ELEMENTS) {
    for (const opponentElement of ELEMENTS) {
      for (const timing of timingScenarios) {
        results.push(simulateMatch({ level, playerElement, opponentElement, ...timing }));
      }
    }
  }
}

const byElement = new Map();
for (const element of ELEMENTS) byElement.set(element, { wins: 0, draws: 0, losses: 0, score: 0, games: 0 });
for (const result of results) {
  const row = byElement.get(result.playerElement);
  row.games += 1;
  if (result.result === "win") {
    row.wins += 1;
    row.score += 1;
  } else if (result.result === "draw") {
    row.draws += 1;
    row.score += 0.5;
  } else {
    row.losses += 1;
  }
}

const summary = [...byElement.entries()].map(([element, row]) => ({
  element,
  scoreRate: Math.round((row.score / row.games) * 1000) / 1000,
  wins: row.wins,
  draws: row.draws,
  losses: row.losses,
  games: row.games,
}));
const rates = summary.map((row) => row.scoreRate);
const spread = Math.max(...rates) - Math.min(...rates);
const maxScoreRate = Math.max(...rates);
const minScoreRate = Math.min(...rates);
const output = {
  levels,
  timingScenarios,
  matches: results.length,
  maxScoreRateSpread: Math.round(spread * 1000) / 1000,
  maxScoreRate,
  minScoreRate,
  status: spread > 0.4 || maxScoreRate > 0.9 || minScoreRate < 0.25 ? "review" : "ok",
  summary,
};

console.log(JSON.stringify(output, null, 2));

if (spread > 0.8 || maxScoreRate > 0.95 || minScoreRate < 0.05) {
  throw new Error(`Element score-rate spread too wide: ${spread}`);
}

function simulateMatch({ level, playerElement, opponentElement, playerOffset = 0, opponentOffset = 1 }) {
  const playerPet = petFor("player", playerElement, level);
  const opponentPet = petFor("opponent", opponentElement, level);
  const room = createBattleRoomSnapshot({
    id: `sim_${level}_${playerElement}_${opponentElement}`,
    accountId: "acct_player",
    pet: playerPet,
    mode: "ranked",
    assetHash: `asset_${playerElement}`,
    opponent: {
      kind: "player",
      account_id: "acct_opponent",
      pet_id: opponentPet.id,
      name: opponentPet.name,
      lp: 1500,
      level: opponentPet.level,
      battle_class: opponentPet.battle_class,
      primary_element: opponentPet.primary_element,
      secondary_element: opponentPet.secondary_element,
      stats: opponentPet.stats,
      skills: opponentPet.skills,
      skill_aliases: {},
      asset_hash: `asset_${opponentElement}`,
    },
    now: "2026-05-03T00:00:00.000Z",
  });

  for (let turn = 1; turn <= room.max_turns && room.status === "in_progress"; turn += 1) {
    const turnInput = { turn_index: room.turn_index, turn_nonce: room.turn_nonce };
    submitAction(
      room,
      "player",
      { ...actionFor(room.sides.player, turn + playerOffset), ...turnInput },
      new Date(Date.UTC(2026, 4, 3, 0, 0, turn)).toISOString(),
    );
    submitAction(
      room,
      "opponent",
      { ...actionFor(room.sides.opponent, turn + opponentOffset), ...turnInput },
      new Date(Date.UTC(2026, 4, 3, 0, 0, turn)).toISOString(),
    );
    resolveTurnIfReady(room, new Date(Date.UTC(2026, 4, 3, 0, 0, turn)).toISOString());
  }

  return {
    level,
    playerElement,
    opponentElement,
    playerOffset,
    opponentOffset,
    result: room.result?.result ?? "unfinished",
    turns: room.log.length,
  };
}

function petFor(id, element, level) {
  return {
    id: `pet_${id}_${element}_${level}`,
    name: `${element} ${id}`,
    level,
    battle_class: "sim",
    primary_element: element,
    secondary_element: null,
    stats: deriveStats({ primaryElement: element, level }),
    skills: OFFICIAL_SKILLS.filter((skill) => skill.element === element).slice(0, 4).map((skill) => skill.id),
    skill_aliases: {},
  };
}

function actionFor(side, turn) {
  const skillId = preferredSkill(side, turn);
  if (side.energy >= 2 && turn % 3 === 0) return { kind: "skill", skill_id: skillId };
  if (turn % 5 === 0) return { kind: "guard" };
  if (turn % 4 === 0) return { kind: "focus" };
  return { kind: "strike" };
}

function preferredSkill(side, turn) {
  const finisher = skillForRole(side, "finisher");
  if (finisher && side.energy >= 4 && turn >= 6) return finisher;
  if (side.hp / side.max_hp <= 0.45 && side.energy >= 2) return skillForRole(side, "defense");
  if (side.stats.speed >= side.stats.power && side.stats.speed >= side.stats.insight) return skillForRole(side, "tempo");
  if (side.stats.insight >= side.stats.power) return skillForRole(side, "status");
  return skillForRole(side, "offense");
}

function skillForRole(side, role) {
  return side.skills.find((id) => id.endsWith(`_${role}`)) ?? null;
}
