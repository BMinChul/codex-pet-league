import { createHash } from "node:crypto";
import { elementModifier, OFFICIAL_SKILLS } from "./rules.js";

export const TURN_SECONDS = 30;
export const MAX_TURNS = 20;
export const ACTION_KINDS = ["strike", "guard", "focus", "skill"];

const SKILL_COST = {
  offense: 2,
  defense: 2,
  status: 2,
  tempo: 2,
  finisher: 4,
};

export function createBattleRoomSnapshot(input) {
  const now = input.now ?? new Date().toISOString();
  const room = {
    id: input.id,
    account_id: input.accountId,
    pet_id: input.pet.id,
    mode: input.mode,
    status: "in_progress",
    turn_seconds: TURN_SECONDS,
    max_turns: MAX_TURNS,
    turn_index: 1,
    turn_started_at: now,
    turn_deadline_at: deadlineFrom(now),
    sides: {
      player: createSideSnapshot({
        side: "player",
        accountId: input.accountId,
        pet: input.pet,
        assetHash: input.assetHash,
      }),
      opponent: createOpponentSnapshot(input.opponent),
    },
    pending_actions: {},
    log: [],
    result: null,
    settlement_battle_id: null,
    replay_hash: null,
    created_at: now,
    updated_at: now,
  };
  room.state_hash = hashRoomState(room);
  return room;
}

export function publicBattleRoom(room) {
  return {
    id: room.id,
    mode: room.mode,
    status: room.status,
    turn_seconds: room.turn_seconds,
    max_turns: room.max_turns,
    turn_index: room.turn_index,
    turn_started_at: room.turn_started_at,
    turn_deadline_at: room.turn_deadline_at,
    sides: {
      player: publicSide(room.sides.player),
      opponent: publicSide(room.sides.opponent),
    },
    pending: {
      player: Boolean(room.pending_actions.player),
      opponent: Boolean(room.pending_actions.opponent),
    },
    log: room.log,
    result: room.result,
    replay_hash: room.replay_hash,
    state_hash: room.state_hash,
    updated_at: room.updated_at,
  };
}

export function submitAction(room, sideKey, input = {}, now = new Date().toISOString()) {
  assertInProgress(room);
  assertDeadlineOpen(room, now);

  if (room.pending_actions[sideKey]) {
    return { submitted: false, duplicate: true, room };
  }

  const side = room.sides[sideKey];
  const action = normalizeAction(input, side);
  room.pending_actions[sideKey] = {
    ...action,
    submitted_at: now,
    source: input.source ?? "manual",
  };
  room.updated_at = now;
  room.state_hash = hashRoomState(room);
  return { submitted: true, duplicate: false, room };
}

export function submitBotActionIfNeeded(room, now = new Date().toISOString()) {
  if (room.status !== "in_progress") return false;
  if (room.sides.opponent.kind !== "bot") return false;
  if (room.pending_actions.opponent) return false;

  const action = chooseBotAction(room);
  submitAction(room, "opponent", { ...action, source: "bot" }, now);
  return true;
}

export function resolveTurnIfReady(room, now = new Date().toISOString()) {
  if (room.status !== "in_progress") return false;
  if (!room.pending_actions.player || !room.pending_actions.opponent) return false;
  resolveTurn(room, now);
  return true;
}

export function resolveExpiredTurn(room, now = new Date().toISOString()) {
  if (room.status !== "in_progress") return false;
  if (new Date(now) < new Date(room.turn_deadline_at)) return false;

  for (const sideKey of ["player", "opponent"]) {
    if (!room.pending_actions[sideKey]) {
      const side = room.sides[sideKey];
      side.timeout_count += 1;
      if (sideKey === "player" && side.timeout_count >= 3) {
        finishBattle(room, "afk_loss", now, `${side.name} missed three turns.`);
        return true;
      }
      room.pending_actions[sideKey] = timeoutActionFor(side.timeout_count, now);
    }
  }

  resolveTurn(room, now);
  return true;
}

export function resultForWinner(winner) {
  if (winner === "player") return "win";
  if (winner === "opponent") return "loss";
  return "draw";
}

export function hashRoomState(room) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: room.id,
        status: room.status,
        turn_index: room.turn_index,
        sides: {
          player: room.sides.player,
          opponent: room.sides.opponent,
        },
        pending_actions: room.pending_actions,
        log: room.log,
        result: room.result,
      }),
    )
    .digest("hex");
}

export function maxHpForStats(stats) {
  return Math.round(140 + stats.guard * 2.3 + stats.recovery * 1.7);
}

function createSideSnapshot({ side, accountId, pet, assetHash }) {
  const maxHp = maxHpForStats(pet.stats);
  return {
    side,
    kind: "player",
    account_id: accountId,
    pet_id: pet.id,
    name: pet.name,
    level: pet.level,
    battle_class: pet.battle_class,
    primary_element: pet.primary_element,
    secondary_element: pet.secondary_element,
    stats: { ...pet.stats },
    skills: pet.skills,
    asset_hash: assetHash,
    max_hp: maxHp,
    hp: maxHp,
    energy: 1,
    focus_stack: 0,
    vulnerable_turns: 0,
    timeout_count: 0,
  };
}

function createOpponentSnapshot(opponent) {
  const maxHp = maxHpForStats(opponent.stats);
  return {
    side: "opponent",
    kind: opponent.kind ?? "bot",
    name: opponent.name,
    lp: opponent.lp,
    level: opponent.level,
    battle_class: opponent.battle_class,
    primary_element: opponent.primary_element,
    secondary_element: opponent.secondary_element,
    stats: { ...opponent.stats },
    skills: opponent.skills,
    asset_hash: opponent.asset_hash ?? null,
    max_hp: maxHp,
    hp: maxHp,
    energy: 1,
    focus_stack: 0,
    vulnerable_turns: 0,
    timeout_count: 0,
  };
}

function publicSide(side) {
  return {
    side: side.side,
    kind: side.kind,
    name: side.name,
    level: side.level,
    battle_class: side.battle_class,
    primary_element: side.primary_element,
    secondary_element: side.secondary_element,
    stats: side.stats,
    skills: side.skills,
    max_hp: side.max_hp,
    hp: side.hp,
    energy: side.energy,
    focus_stack: side.focus_stack,
    vulnerable_turns: side.vulnerable_turns,
    timeout_count: side.timeout_count,
  };
}

function normalizeAction(input, side) {
  const kind = ACTION_KINDS.includes(input.kind) ? input.kind : "strike";
  if (kind !== "skill") return { kind };

  const skillId = input.skill_id ?? side.skills[0];
  if (!side.skills.includes(skillId)) {
    throw actionError("SKILL_NOT_EQUIPPED", "Skill is not equipped in this battle loadout.");
  }

  const skill = OFFICIAL_SKILLS.find((entry) => entry.id === skillId);
  if (!skill) throw actionError("SKILL_NOT_FOUND", "Official skill not found.");
  if (skill.element !== side.primary_element && skill.element !== side.secondary_element) {
    throw actionError("SKILL_ELEMENT_INVALID", "Skill element does not match this pet.");
  }

  const cost = SKILL_COST[skill.role] ?? 2;
  if (side.energy < cost) {
    throw actionError("NOT_ENOUGH_ENERGY", `Skill requires ${cost} energy.`);
  }

  return {
    kind,
    skill_id: skill.id,
    skill_name: skill.officialName,
    skill_role: skill.role,
    energy_cost: cost,
  };
}

function chooseBotAction(room) {
  const bot = room.sides.opponent;
  const player = room.sides.player;
  const hpRatio = bot.hp / bot.max_hp;
  const finisher = bot.skills.map((id) => OFFICIAL_SKILLS.find((skill) => skill.id === id)).find((skill) => skill?.role === "finisher");
  const defense = bot.skills.map((id) => OFFICIAL_SKILLS.find((skill) => skill.id === id)).find((skill) => skill?.role === "defense");
  const offense = bot.skills.map((id) => OFFICIAL_SKILLS.find((skill) => skill.id === id)).find((skill) => skill?.role === "offense");

  if (finisher && bot.energy >= SKILL_COST.finisher && player.hp / player.max_hp <= 0.42) {
    return { kind: "skill", skill_id: finisher.id };
  }
  if (defense && bot.energy >= SKILL_COST.defense && hpRatio <= 0.35) {
    return { kind: "skill", skill_id: defense.id };
  }
  if (offense && bot.energy >= SKILL_COST.offense && room.turn_index % 3 !== 0) {
    return { kind: "skill", skill_id: offense.id };
  }
  if (room.turn_index % 4 === 0) return { kind: "guard" };
  if (room.turn_index % 3 === 0) return { kind: "focus" };
  return { kind: "strike" };
}

function resolveTurn(room, now) {
  const player = room.sides.player;
  const opponent = room.sides.opponent;
  const playerAction = room.pending_actions.player;
  const opponentAction = room.pending_actions.opponent;
  const effects = [
    effectForAction(player, opponent, playerAction),
    effectForAction(opponent, player, opponentAction),
  ];

  const playerGuard = guardReduction(player, playerAction);
  const opponentGuard = guardReduction(opponent, opponentAction);

  applyEnergyAndSelfEffects(player, playerAction, opponent);
  applyEnergyAndSelfEffects(opponent, opponentAction, player);

  const playerIncoming = damageAfterDefense(effects[1].damage, playerGuard, player);
  const opponentIncoming = damageAfterDefense(effects[0].damage, opponentGuard, opponent);

  player.hp = clamp(player.hp - playerIncoming + effects[0].selfHeal, 0, player.max_hp);
  opponent.hp = clamp(opponent.hp - opponentIncoming + effects[1].selfHeal, 0, opponent.max_hp);

  tickStatuses(player);
  tickStatuses(opponent);

  const turnLog = {
    turn: room.turn_index,
    resolved_at: now,
    actions: {
      player: summarizeAction(playerAction),
      opponent: summarizeAction(opponentAction),
    },
    effects: [
      summarizeEffect("player", effects[0], opponentIncoming),
      summarizeEffect("opponent", effects[1], playerIncoming),
    ],
    sides: {
      player: summarizeVitals(player),
      opponent: summarizeVitals(opponent),
    },
  };
  room.log.push(turnLog);
  room.pending_actions = {};

  const winner = winnerAfterTurn(room);
  if (winner || room.turn_index >= room.max_turns) {
    finishBattle(room, resultForWinner(winner ?? winnerByHp(room)), now, winner ? "HP reached zero." : "Turn limit reached.");
    return;
  }

  room.turn_index += 1;
  room.turn_started_at = now;
  room.turn_deadline_at = deadlineFrom(now);
  room.updated_at = now;
  room.state_hash = hashRoomState(room);
}

function effectForAction(attacker, defender, action) {
  const result = {
    damage: 0,
    selfHeal: 0,
    appliesVulnerable: false,
  };

  if (action.kind === "idle") return result;
  if (action.kind === "guard") {
    result.selfHeal = Math.round(4 + attacker.stats.recovery * 0.2);
    return result;
  }
  if (action.kind === "focus") return result;
  if (action.kind === "strike") {
    result.damage = Math.round(14 + attacker.stats.power * 0.9);
    return withElementAndFocus(result, attacker, defender);
  }

  const skill = OFFICIAL_SKILLS.find((entry) => entry.id === action.skill_id);
  if (!skill) return result;

  if (skill.role === "offense") {
    result.damage = Math.round(18 + attacker.stats.power * 1.05 + attacker.stats.focus * 0.25);
  } else if (skill.role === "defense") {
    result.selfHeal = Math.round(10 + attacker.stats.recovery * 0.55);
  } else if (skill.role === "status") {
    result.damage = Math.round(10 + attacker.stats.insight * 0.55);
    result.appliesVulnerable = true;
  } else if (skill.role === "tempo") {
    result.damage = Math.round(12 + attacker.stats.speed * 0.65);
  } else if (skill.role === "finisher") {
    const lowHpBonus = defender.hp / defender.max_hp <= 0.35 ? 1.25 : 1;
    result.damage = Math.round((22 + attacker.stats.power * 0.7 + attacker.stats.insight * 0.7) * lowHpBonus);
  }

  return withElementAndFocus(result, attacker, defender);
}

function withElementAndFocus(effect, attacker, defender) {
  const modifier = elementModifier(
    { primaryElement: attacker.primary_element, secondaryElement: attacker.secondary_element },
    { primaryElement: defender.primary_element, secondaryElement: defender.secondary_element },
  );
  const focusBonus = attacker.focus_stack > 0 ? Math.min(0.24, attacker.focus_stack * 0.12) : 0;
  const vulnerableBonus = defender.vulnerable_turns > 0 ? 0.08 : 0;
  return {
    ...effect,
    damage: Math.max(0, Math.round(effect.damage * (1 + modifier + focusBonus + vulnerableBonus))),
  };
}

function applyEnergyAndSelfEffects(side, action, target) {
  if (action.kind === "skill") {
    side.energy = Math.max(0, side.energy - action.energy_cost);
    side.focus_stack = 0;
    if (action.skill_role === "tempo") side.energy = clamp(side.energy + 1, 0, 6);
    if (action.skill_role === "status") target.vulnerable_turns = Math.max(target.vulnerable_turns, 2);
    return;
  }
  if (action.kind === "strike") {
    side.energy = clamp(side.energy + 1, 0, 6);
    side.focus_stack = 0;
    return;
  }
  if (action.kind === "guard") {
    side.energy = clamp(side.energy + 1, 0, 6);
    return;
  }
  if (action.kind === "focus") {
    side.energy = clamp(side.energy + 2, 0, 6);
    side.focus_stack = clamp(side.focus_stack + 1, 0, 2);
  }
}

function guardReduction(side, action) {
  if (action.kind === "skill" && action.skill_role === "defense") {
    return clamp(0.35 + side.stats.guard / 500, 0.35, 0.6);
  }
  if (action.kind === "guard") {
    return clamp(0.45 + side.stats.guard / 450, 0.45, 0.68);
  }
  return 0;
}

function damageAfterDefense(damage, reduction, defender) {
  const reduced = damage * (1 - reduction);
  const floor = damage > 0 ? 1 : 0;
  const armor = Math.round(defender.stats.guard * 0.08);
  return Math.max(floor, Math.round(reduced) - armor);
}

function tickStatuses(side) {
  side.vulnerable_turns = Math.max(0, side.vulnerable_turns - 1);
}

function winnerAfterTurn(room) {
  const playerDown = room.sides.player.hp <= 0;
  const opponentDown = room.sides.opponent.hp <= 0;
  if (playerDown && opponentDown) return "draw";
  if (opponentDown) return "player";
  if (playerDown) return "opponent";
  return null;
}

function winnerByHp(room) {
  const playerRatio = room.sides.player.hp / room.sides.player.max_hp;
  const opponentRatio = room.sides.opponent.hp / room.sides.opponent.max_hp;
  if (Math.abs(playerRatio - opponentRatio) <= 0.05) return "draw";
  return playerRatio > opponentRatio ? "player" : "opponent";
}

function finishBattle(room, result, now, reason) {
  room.status = "finished";
  room.result = {
    result,
    reason,
    finished_at: now,
  };
  room.pending_actions = {};
  room.updated_at = now;
  room.replay_hash = createHash("sha256")
    .update(JSON.stringify({ room_id: room.id, log: room.log, result: room.result }))
    .digest("hex");
  room.state_hash = hashRoomState(room);
}

function timeoutActionFor(timeoutCount, now) {
  return {
    kind: timeoutCount === 1 ? "guard" : "idle",
    submitted_at: now,
    source: "timeout",
  };
}

function summarizeAction(action) {
  return {
    kind: action.kind,
    skill_id: action.skill_id ?? null,
    skill_name: action.skill_name ?? null,
    source: action.source ?? "manual",
  };
}

function summarizeEffect(side, effect, appliedDamage) {
  return {
    side,
    damage: appliedDamage,
    self_heal: effect.selfHeal,
    applies_vulnerable: effect.appliesVulnerable,
  };
}

function summarizeVitals(side) {
  return {
    hp: side.hp,
    max_hp: side.max_hp,
    energy: side.energy,
    focus_stack: side.focus_stack,
    vulnerable_turns: side.vulnerable_turns,
    timeout_count: side.timeout_count,
  };
}

function assertInProgress(room) {
  if (!room || room.status !== "in_progress") {
    throw actionError("BATTLE_NOT_ACTIVE", "Battle is not accepting actions.");
  }
}

function assertDeadlineOpen(room, now) {
  if (new Date(now) > new Date(room.turn_deadline_at)) {
    throw actionError("TURN_EXPIRED", "Turn timer has expired.");
  }
}

function deadlineFrom(iso) {
  return new Date(new Date(iso).getTime() + TURN_SECONDS * 1000).toISOString();
}

function actionError(code, message) {
  const error = new Error(message);
  error.status = 400;
  error.code = code;
  return error;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
