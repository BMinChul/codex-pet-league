import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

test.describe.configure({ mode: "serial" });
test.setTimeout(90_000);

test("browser league flow covers auth, pet, training, battle, admin review, and responsive layout", async ({ page }) => {
  const app = await startTempServer();
  const browserErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(app.baseUrl, { waitUntil: "domcontentloaded" });
    await expect(page.locator("#appStatus")).toContainText("Sign in", { timeout: 10_000 });
    await expectNoLayoutOverflow(page);

    await page.selectOption("#authMethodInput", "email_magic_link");
    await page.fill("#authIdentifierInput", "demo@codexpet.local");
    await page.click("#authChallengeButton");
    await expect(page.locator("#authHint")).toContainText("Local dev code");
    await expect(page.locator("#authCodeInput")).not.toHaveValue("");
    await page.click("#authVerifyButton");
    await expect(page.locator("#sessionLabel")).toContainText("Demo Coder");
    browserErrors.length = 0;
    await expect(page.locator(".admin-panel")).toBeVisible();
    await expect(page.locator("#adminSummary")).toContainText("Review Cases");

    await page.click("#seedPetButton");
    await expect(page.locator("#petTitle")).toContainText("Pebble");
    await expect(page.locator("#profileSummary")).toContainText("Record");
    await expect(page.locator("#xpStatus")).toContainText("Pet XP");
    await expect(page.locator("#battleSkillSelect option")).toHaveCount(4);
    await page.locator("[data-skill-alias]").first().fill("QA Burst");
    await page.click("#saveAliasesButton");
    await expect(page.locator("#battleSkillSelect")).toContainText("QA Burst");

    await page.check("#debuggingActivity");
    await page.check("#milestone");
    await page.selectOption("#filesChangedBucket", "large");
    await page.fill("#testsRun", "12");
    await page.click("#draftReportButton");
    await expect(page.locator("#trainingPreview")).toContainText("risk_preview");
    await page.click("#submitReportButton");
    await expect(page.locator("#trainingPreview")).toContainText("status");

    await page.selectOption("#battleMode", "casual");
    await page.click("#startBattleButton");
    await expect(page.locator("#battleOutput")).toContainText("in_progress");
    await page.locator('[data-action="strike"]').click();
    await expect(page.locator("#battleOutput")).toContainText("latest_turn");
    await expect(page.locator("#battleTimeline")).toContainText("Turn 1");
    await finishActiveBattleFromPage(page);
    await page.click("#refreshButton");
    await expect(page.locator("#replayList")).toContainText("casual");

    await page.click("#joinQueueButton");
    await expect(page.locator("#matchmakingCards")).toContainText("Queue");
    await page.click("#cancelQueueButton");
    await expect(page.locator("#matchmakingCards")).toContainText("cancelled");

    const heldReportId = await createHeldTrainingReportFromPage(page);
    await page.click("#adminRefreshButton");
    await expect(page.locator("#adminAuditFindings")).toContainText("Audit");
    await expect(page.locator("#adminReviewCases")).toContainText(heldReportId);
    const heldReportRow = page.locator(".review-item", { hasText: heldReportId });
    await heldReportRow.getByRole("button", { name: "Approve" }).click();
    await expect(page.locator("#adminOutput")).toContainText("approved");
    await expect(page.locator("#adminReviewCases")).not.toContainText(heldReportId);

    await page.click("#adminRunOpsButton");
    await expect(page.locator("#adminOutput")).toContainText("server_authority_reconcile");
    await expectNoLayoutOverflow(page);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("#sessionLabel")).toContainText("Demo Coder");
    await expect(page.locator("#petTitle")).toContainText("Pebble");
    await expectNoLayoutOverflow(page);

    expect(browserErrors, browserErrors.join("\n")).toEqual([]);
  } finally {
    await app.close();
  }
});

async function createHeldTrainingReportFromPage(page) {
  return page.evaluate(async () => {
    const petsResponse = await fetch("/api/pets");
    const petsPayload = await petsResponse.json();
    if (!petsResponse.ok) throw new Error(`pets request failed: ${JSON.stringify(petsPayload)}`);
    const pet = petsPayload.pets?.[0];
    if (!pet?.id) throw new Error("No active pet was available for held-report creation.");

    const reportResponse = await fetch(`/api/pets/${encodeURIComponent(pet.id)}/training-reports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: crypto.randomUUID(),
        client_report_id: `browser-held-${crypto.randomUUID()}`,
        signals: {
          testsRun: 99,
          milestone: true,
          filesChangedBucket: "small",
        },
      }),
    });
    const reportPayload = await reportResponse.json();
    if (!reportResponse.ok) throw new Error(`held report request failed: ${JSON.stringify(reportPayload)}`);
    if (reportPayload.report?.status !== "review") {
      throw new Error(`held report was not queued for review: ${JSON.stringify(reportPayload.report)}`);
    }
    return reportPayload.report.id;
  });
}

async function finishActiveBattleFromPage(page) {
  return page.evaluate(async () => {
    const current = JSON.parse(document.querySelector("#battleOutput").textContent);
    let view = await fetch(`/api/battles/${encodeURIComponent(current.id)}`);
    let payload = await view.json();
    if (!view.ok) throw new Error(`battle view failed: ${JSON.stringify(payload)}`);
    let battle = payload.battle;
    for (let index = 0; index < 30 && battle.status === "in_progress"; index += 1) {
      const response = await fetch(`/api/battles/${encodeURIComponent(battle.id)}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request_id: crypto.randomUUID(),
          kind: "strike",
          turn_index: battle.turn_index,
          turn_nonce: battle.turn_nonce,
        }),
      });
      payload = await response.json();
      if (!response.ok && ["TURN_STALE", "TURN_ACTION_DUPLICATE"].includes(payload.error?.code)) {
        const latestResponse = await fetch(`/api/battles/${encodeURIComponent(battle.id)}`);
        payload = await latestResponse.json();
      } else if (!response.ok) {
        throw new Error(`battle finish failed: ${JSON.stringify(payload)}`);
      }
      battle = payload.battle;
    }
    if (battle.status !== "finished") throw new Error(`battle did not finish: ${JSON.stringify(battle)}`);
    return battle.id;
  });
}

async function expectNoLayoutOverflow(page) {
  const layout = await page.evaluate(() => {
    const overflowNodes = Array.from(
      document.querySelectorAll(
        "button, input, select, h1, h2, p, .status-pills span, .meter-row > strong, .meter-row > span, .stat-row > strong, .stat-row > span, .battle-meta",
      ),
    )
      .filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const hiddenAncestor = element.closest("[hidden]");
        return !hiddenAncestor && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      })
      .filter((element) => element.scrollWidth > element.clientWidth + 2)
      .slice(0, 20)
      .map((element) => ({
        selector: describeElement(element),
        text: element.textContent.trim().slice(0, 80),
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }));

    return {
      documentOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      overflowNodes,
    };

    function describeElement(element) {
      if (element.id) return `#${element.id}`;
      const className = Array.from(element.classList).slice(0, 2).join(".");
      return `${element.tagName.toLowerCase()}${className ? `.${className}` : ""}`;
    }
  });

  expect(layout.documentOverflow, JSON.stringify(layout, null, 2)).toBeLessThanOrEqual(2);
  expect(layout.overflowNodes, JSON.stringify(layout, null, 2)).toEqual([]);
}

async function startTempServer() {
  const tempRoot = await mkdtemp(join(tmpdir(), "codexpet-browser-"));
  const port = await availablePort();
  const child = spawn(process.execPath, ["src/server/index.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      CODEX_PET_STATE_PATH: join(tempRoot, "browser-state.json"),
      CODEX_PET_AUTH_DEV_CODE: "true",
      CODEX_PET_ALLOW_DEV_ACCOUNT_HEADER: "false",
      CODEX_PET_OPS_JOB_INTERVAL_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = [];
  const stderr = [];
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForServer(baseUrl);
  } catch (error) {
    await closeServer(child, closed, tempRoot);
    throw new Error(`${error.message}\nserver stdout:\n${Buffer.concat(stdout)}\nserver stderr:\n${Buffer.concat(stderr)}`);
  }

  return {
    baseUrl,
    async close() {
      await closeServer(child, closed, tempRoot);
    },
  };
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(baseUrl) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      await sleep(150);
    }
  }
  throw new Error(`server did not become ready at ${baseUrl}`);
}

async function closeServer(child, closed, tempRoot) {
  if (child.exitCode === null && !child.killed) child.kill();
  await Promise.race([closed, sleep(2_000)]);
  await rm(tempRoot, { recursive: true, force: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
