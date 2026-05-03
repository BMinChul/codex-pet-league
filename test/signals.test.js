import test from "node:test";
import assert from "node:assert/strict";
import { signalsFromChangedFiles } from "../src/cli/signals.js";

test("CLI signal analyzer infers implementation, docs, tests, and file buckets", () => {
  const signals = signalsFromChangedFiles([
    "src/server/index.js",
    "src/domain/rules.js",
    "test/rules.test.js",
    "README.md",
  ]);

  assert.equal(signals.implementationActivity, true);
  assert.equal(signals.verificationActivity, true);
  assert.equal(signals.docsActivity, true);
  assert.equal(signals.filesChangedBucket, "medium");
  assert.equal(signals.testsRun, 1);
});

test("CLI signal analyzer treats large changes as milestone candidates", () => {
  const files = Array.from({ length: 12 }, (_, index) => `src/file-${index}.js`);
  const signals = signalsFromChangedFiles(files);
  assert.equal(signals.filesChangedBucket, "large");
  assert.equal(signals.milestone, true);
});
