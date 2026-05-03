import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

test("sqlite storage driver persists state snapshots", async () => {
  const child = spawn(process.execPath, ["scripts/storage-smoke.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const output = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => output.push(chunk));
  const exitCode = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(exitCode, 0, output.join(""));
  assert.match(output.join(""), /storage smoke ok/);
});
