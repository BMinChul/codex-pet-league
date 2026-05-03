import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assetStorageStatus, readAssetObject, saveAtlasObject } from "../src/storage/assetStore.js";

const tinyPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lZc2WQAAAABJRU5ErkJggg==";
const tinyWebp =
  "data:image/webp;base64,UklGRhoAAABXRUJQVlA4WAoAAAAAAAAAAAAAAQAAAAEAAA==";

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

test("asset store persists hatch-pet WebP spritesheet objects", async () => {
  const root = await mkdtemp(join(tmpdir(), "codexpet-assets-"));
  const env = { CODEX_PET_ASSET_ROOT: root };
  try {
    const result = await saveAtlasObject("local-dev/asset_hash.webp", tinyWebp, env);
    assert.equal(result.stored, true);
    assert.equal(result.content_type, "image/webp");

    const content = await readAssetObject("local-dev/asset_hash.webp", env);
    assert.equal(content.subarray(0, 4).toString("ascii"), "RIFF");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("asset store can write atlas objects to an S3-compatible provider", async () => {
  const calls = [];
  const env = {
    CODEX_PET_ASSET_STORAGE: "s3_compatible",
    CODEX_PET_S3_ENDPOINT: "https://assets.example.test",
    CODEX_PET_S3_BUCKET: "codex-pets",
    CODEX_PET_S3_REGION: "auto",
    CODEX_PET_S3_ACCESS_KEY_ID: "access-key",
    CODEX_PET_S3_SECRET_ACCESS_KEY: "secret-key",
  };

  const result = await saveAtlasObject("local-dev/asset_hash.png", tinyPng, env, async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  });

  assert.equal(result.provider, "s3_compatible");
  assert.equal(calls[0].url, "https://assets.example.test/codex-pets/local-dev/asset_hash.png");
  assert.equal(calls[0].init.method, "PUT");
  assert.equal(calls[0].init.headers["content-type"], "image/png");
  assert.match(calls[0].init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=access-key\//);
  assert.match(calls[0].init.headers["x-amz-date"], /^\d{8}T\d{6}Z$/);
  assert.match(calls[0].init.headers["x-amz-content-sha256"], /^[a-f0-9]{64}$/);
});

test("asset store writes WebP objects with image/webp content type to S3-compatible providers", async () => {
  const calls = [];
  const env = {
    CODEX_PET_ASSET_STORAGE: "s3_compatible",
    CODEX_PET_S3_ENDPOINT: "https://assets.example.test",
    CODEX_PET_S3_BUCKET: "codex-pets",
    CODEX_PET_S3_REGION: "auto",
    CODEX_PET_S3_ACCESS_KEY_ID: "access-key",
    CODEX_PET_S3_SECRET_ACCESS_KEY: "secret-key",
  };

  await saveAtlasObject("local-dev/asset_hash.webp", tinyWebp, env, async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  });

  assert.equal(calls[0].url, "https://assets.example.test/codex-pets/local-dev/asset_hash.webp");
  assert.equal(calls[0].init.headers["content-type"], "image/webp");
});

test("asset store can read atlas objects from an S3-compatible provider", async () => {
  const env = {
    CODEX_PET_ASSET_STORAGE: "s3_compatible",
    CODEX_PET_S3_ENDPOINT: "https://assets.example.test",
    CODEX_PET_S3_BUCKET: "codex-pets",
    CODEX_PET_S3_REGION: "auto",
    CODEX_PET_S3_ACCESS_KEY_ID: "access-key",
    CODEX_PET_S3_SECRET_ACCESS_KEY: "secret-key",
  };

  const content = await readAssetObject("local-dev/asset_hash.png", env, async (url, init) => {
    assert.equal(url, "https://assets.example.test/codex-pets/local-dev/asset_hash.png");
    assert.equal(init.method, "GET");
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from("atlas-bytes"),
    };
  });

  assert.equal(content.toString("utf8"), "atlas-bytes");
});
