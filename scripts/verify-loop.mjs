import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const iterations = Number(process.argv[2] ?? process.env.CODEX_PET_VERIFY_ITERATIONS ?? 2);
const nodeBin = process.execPath;

const syntaxFiles = [
  "src/server/index.js",
  "src/domain/state.js",
  "src/domain/audit.js",
  "src/domain/battleEngine.js",
  "src/storage/jsonStore.js",
  "src/cli/index.js",
  "src/mcp/codex-pet-mcp.cjs",
  "public/app.js",
  "scripts/runtime-smoke.mjs",
  "scripts/verify-loop.mjs",
];

const scanRoots = ["public", "src", "test"];
const forbiddenPatterns = [
  { pattern: "innerHTML", reason: "unsafe HTML sink" },
  { pattern: "outerHTML", reason: "unsafe HTML sink" },
  { pattern: "insertAdjacentHTML", reason: "unsafe HTML sink" },
  { pattern: "document.write", reason: "unsafe HTML sink" },
  { pattern: "eval(", reason: "dynamic code execution" },
  { pattern: "new Function", reason: "dynamic code execution" },
  { pattern: "Math.random", reason: "weak randomness in product/test paths" },
  { pattern: "TODO", reason: "unfinished work marker" },
  { pattern: "FIXME", reason: "unfinished work marker" },
];

if (!Number.isInteger(iterations) || iterations < 1) {
  throw new Error("Pass a positive integer iteration count.");
}

for (let index = 1; index <= iterations; index += 1) {
  console.log(`\nverify loop ${index}/${iterations}`);
  runSyntaxChecks();
  runStaticScan();
  run("git", ["diff", "--check"], "diff whitespace check");
  run(nodeBin, ["--test", "test/*.test.js"], "unit tests");
  run(nodeBin, ["scripts/runtime-smoke.mjs"], "runtime smoke");
}

console.log(`\nverify loop ok (${iterations}/${iterations})`);

function runSyntaxChecks() {
  for (const file of syntaxFiles) {
    run(nodeBin, ["--check", file], `syntax ${file}`);
  }
}

function runStaticScan() {
  const findings = [];
  for (const root of scanRoots) {
    for (const file of walk(join(repoRoot, root))) {
      const text = readFileSync(file, "utf8");
      const lines = text.split(/\r?\n/);
      lines.forEach((line, lineIndex) => {
        for (const { pattern, reason } of forbiddenPatterns) {
          if (line.includes(pattern)) {
            findings.push(`${relative(file)}:${lineIndex + 1} ${reason}: ${pattern}`);
          }
        }
      });
    }
  }
  if (findings.length > 0) {
    throw new Error(`static scan failed:\n${findings.join("\n")}`);
  }
  console.log("ok static scan");
}

function run(command, args, label) {
  console.log(`> ${label}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      yield* walk(path);
    } else if (/\.(cjs|mjs|js|html|css|md)$/.test(entry)) {
      yield path;
    }
  }
}

function relative(file) {
  return file.slice(repoRoot.length + 1).replaceAll("\\", "/");
}
