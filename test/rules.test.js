import test from "node:test";
import assert from "node:assert/strict";
import {
  XP_CAPS,
  battleClassForTotalStats,
  calculateTrainingAward,
  deriveStats,
  elementModifier,
  lpDelta,
  progressionFromXp,
  tierForLp,
  totalXpForLevel100,
} from "../src/domain/rules.js";

test("level 100 takes the agreed 90-day pacing budget", () => {
  assert.equal(totalXpForLevel100(), 61700);
  assert.equal(Math.round((totalXpForLevel100() / XP_CAPS.petDaily) * 10) / 10, 88.1);
  const progression = progressionFromXp(totalXpForLevel100());
  assert.equal(progression.level, 100);
});

test("leveling grows actual stats and Battle Class boundaries stay stable", () => {
  assert.equal(deriveStats({ primaryElement: "Forge", secondaryElement: "Trace", level: 1 }).total, 100);
  assert.equal(deriveStats({ primaryElement: "Forge", secondaryElement: "Trace", level: 100 }).total, 298);
  assert.equal(battleClassForTotalStats(100), "hatch");
  assert.equal(battleClassForTotalStats(140), "core");
  assert.equal(battleClassForTotalStats(180), "surge");
  assert.equal(battleClassForTotalStats(220), "apex");
  assert.equal(battleClassForTotalStats(260), "prime");
});

test("element advantage is capped and follows the six element loop", () => {
  assert.equal(
    elementModifier(
      { primaryElement: "Logic", secondaryElement: "Trace" },
      { primaryElement: "Pulse", secondaryElement: "Deploy" },
    ),
    0.15,
  );
  assert.equal(
    elementModifier(
      { primaryElement: "Pulse", secondaryElement: "Deploy" },
      { primaryElement: "Logic", secondaryElement: "Trace" },
    ),
    -0.15,
  );
});

test("LP tiers and ranked deltas match the design", () => {
  assert.equal(tierForLp(0).label, "Bronze 1");
  assert.equal(tierForLp(667).label, "Bronze 3");
  assert.equal(tierForLp(1500).label, "Silver 2");
  assert.equal(tierForLp(6000).label, "Codex");
  assert.equal(lpDelta({ result: "win", playerLp: 1000, opponentLp: 1500 }), 35);
  assert.equal(lpDelta({ result: "loss", playerLp: 1500, opponentLp: 1000 }), -35);
  assert.equal(lpDelta({ result: "afk_loss", playerLp: 1500, opponentLp: 1500 }), -40);
  assert.equal(lpDelta({ result: "win", playerLp: 1000, opponentLp: 1500, placement: true }), 70);
});

test("Training Report award respects report count and XP caps", () => {
  const first = calculateTrainingAward({
    reportType: "milestone",
    isFirstDailyReport: true,
    counters: {
      petDaily: 0,
      trainingDaily: 0,
      styleDaily: 0,
      trainingReportsUsed: 0,
    },
  });
  assert.equal(first.rawPetXp, 216);
  assert.equal(first.petXpApplied, 216);

  const capped = calculateTrainingAward({
    reportType: "milestone",
    isFirstDailyReport: false,
    counters: {
      petDaily: 650,
      trainingDaily: 390,
      styleDaily: 0,
      trainingReportsUsed: 2,
    },
  });
  assert.equal(capped.petXpApplied, 10);
  assert.equal(capped.styleXpApplied, 170);

  const noPetSlot = calculateTrainingAward({
    reportType: "major",
    isFirstDailyReport: false,
    counters: {
      petDaily: 100,
      trainingDaily: 100,
      styleDaily: 0,
      trainingReportsUsed: 3,
    },
  });
  assert.equal(noPetSlot.petEligible, false);
  assert.equal(noPetSlot.petXpApplied, 0);
  assert.equal(noPetSlot.styleXpApplied, 120);
});
