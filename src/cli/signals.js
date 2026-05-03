import { spawnSync } from "node:child_process";
import { extname, basename } from "node:path";

const IMPLEMENTATION_EXTENSIONS = new Set([
  ".c",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".sql",
  ".svelte",
  ".swift",
  ".ts",
  ".tsx",
  ".vue",
]);

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".rst", ".txt", ".adoc"]);
const TEST_PATTERNS = [/\.test\./i, /\.spec\./i, /(^|[/\\])test(s)?([/\\]|$)/i, /(^|[/\\])__tests__([/\\]|$)/i];

export function buildSignalsFromWorkspace({ cwd = process.cwd(), flags = {} } = {}) {
  const changedFiles = readGitChangedFiles(cwd);
  const inferred = signalsFromChangedFiles(changedFiles);
  return {
    ...inferred,
    implementationActivity: Boolean(flags.implementationActivity ?? inferred.implementationActivity),
    debuggingActivity: Boolean(flags.debuggingActivity ?? inferred.debuggingActivity),
    verificationActivity: Boolean(flags.verificationActivity ?? inferred.verificationActivity),
    docsActivity: Boolean(flags.docsActivity ?? inferred.docsActivity),
    releaseActivity: Boolean(flags.releaseActivity ?? inferred.releaseActivity),
    quickIterationActivity: Boolean(flags.quickIterationActivity ?? inferred.quickIterationActivity),
    milestone: Boolean(flags.milestone ?? inferred.milestone),
    testsRun: Number(flags.testsRun ?? inferred.testsRun ?? 0),
    filesChangedBucket: flags.filesChangedBucket ?? inferred.filesChangedBucket,
    changedFilesCount: changedFiles.length,
  };
}

export function signalsFromChangedFiles(changedFiles) {
  const files = changedFiles.map((file) => file.trim()).filter(Boolean);
  const extensions = files.map((file) => extname(file).toLowerCase());
  const names = files.map((file) => basename(file).toLowerCase());

  return {
    implementationActivity: extensions.some((ext) => IMPLEMENTATION_EXTENSIONS.has(ext)),
    debuggingActivity: names.some((name) => name.includes("debug") || name.includes("trace") || name.includes("log")),
    verificationActivity: files.some((file) => TEST_PATTERNS.some((pattern) => pattern.test(file))),
    docsActivity: extensions.some((ext) => DOC_EXTENSIONS.has(ext)),
    releaseActivity: names.some((name) => ["package.json", "package-lock.json", "dockerfile"].includes(name)),
    quickIterationActivity: files.length > 0 && files.length <= 3,
    milestone: files.length >= 12,
    testsRun: files.some((file) => TEST_PATTERNS.some((pattern) => pattern.test(file))) ? 1 : 0,
    filesChangedBucket: bucketForChangedFiles(files.length),
  };
}

function readGitChangedFiles(cwd) {
  const result = spawnSync("git", ["status", "--short"], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .map((file) => file.replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function bucketForChangedFiles(count) {
  if (count >= 12) return "large";
  if (count >= 4) return "medium";
  if (count >= 1) return "small";
  return "none";
}
