import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assetStorageStatus, readAssetObject, saveAtlasObject } from "../src/storage/assetStore.js";

const tinyPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lZc2WQAAAABJRU5ErkJggg==";

test("asset store persists and reads atlas PNG objects under the configured root", async () => {
  const root = await mkdtemp(join(tmpdir(), "codexpet-assets-"));
  const env = { CODEX_PET_ASSET_ROOT: root };
  try {
    const result = await saveAtlasObject("local-dev/asset_hash.png", tinyPng, env);
    assert.equal(result.stored, true);
    assert.equal(assetStorageStatus(env).provider, "local_fs");

    const content = await readAssetObject("local-dev/asset_hash.png", env);
    assert.equal(content.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");

    const duplicate = await saveAtlasObject("local-dev/asset_hash.png", tinyPng, env);
    assert.equal(duplicate.reason, "already_exists");
    await assert.rejects(() => saveAtlasObject("../escape.png", tinyPng, env), /Asset object key/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
