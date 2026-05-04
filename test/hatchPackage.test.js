import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import hatchPackage from "../src/hatchPackage.cjs";

const { discoverHatchPetPackages, loadHatchPetPackage } = hatchPackage;

test("loads an official hatch-pet package with server provenance hashes", async () => {
  const root = await mkdtemp(join(tmpdir(), "codexpet-hatch-"));
  try {
    const dir = await makeHatchPackage(root, "pebble", {
      spritesheetPath: "art/spritesheet.webp",
      description: "A verified local hatch package.",
    });

    const loaded = await loadHatchPetPackage(dir);
    assert.equal(loaded.manifest.id, "pebble");
    assert.equal(loaded.image.width, 1536);
    assert.equal(loaded.image.height, 1872);
    assert.equal(loaded.appearance.source, "openai_hatch_pet");
    assert.match(loaded.manifest_sha256, /^[a-f0-9]{64}$/);
    assert.match(loaded.spritesheet_sha256, /^[a-f0-9]{64}$/);
    assert.match(loaded.package_fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(loaded.appearance.official_contract, "openai-hatch-pet@8x9-192x208-v1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discovers hatch-pet packages under the Codex pets root and reports fingerprints", async () => {
  const root = await mkdtemp(join(tmpdir(), "codexpet-hatch-root-"));
  try {
    await makeHatchPackage(root, "first");
    await makeHatchPackage(root, "second");

    const packages = await discoverHatchPetPackages({ root });
    assert.equal(packages.length, 2);
    assert.ok(packages.every((entry) => entry.package_fingerprint));
    await assert.rejects(() => loadHatchPetPackage(null, { root }), /Multiple hatch-pet packages/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects hatch-pet spritesheets that do not match the official atlas contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "codexpet-hatch-bad-size-"));
  try {
    const dir = await makeHatchPackage(root, "bad-size", { width: 128, height: 64 });
    await assert.rejects(() => loadHatchPetPackage(dir), /1536x1872/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects path traversal and extension spoofing in hatch-pet manifests", async () => {
  const root = await mkdtemp(join(tmpdir(), "codexpet-hatch-bad-path-"));
  try {
    const traversal = await makeHatchPackage(root, "traversal", { spritesheetPath: "../spritesheet.webp" });
    await assert.rejects(() => loadHatchPetPackage(traversal), /relative file path/);

    const spoofed = await makeHatchPackage(root, "spoofed", { spritesheetPath: "spritesheet.png" });
    await assert.rejects(() => loadHatchPetPackage(spoofed), /extension must match/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function makeHatchPackage(root, id, options = {}) {
  const dir = join(root, id);
  const spritesheetPath = options.spritesheetPath ?? "spritesheet.webp";
  await mkdir(dir, { recursive: true });
  await mkdir(join(dir, dirnameFor(spritesheetPath)), { recursive: true });
  await writeFile(
    join(dir, "pet.json"),
    JSON.stringify(
      {
        id,
        displayName: options.displayName ?? title(id),
        description: options.description ?? "A hatch-pet test fixture.",
        spritesheetPath,
      },
      null,
      2,
    ),
  );
  if (!spritesheetPath.startsWith("../")) {
    await writeFile(join(dir, spritesheetPath), webpHeader(options.width ?? 1536, options.height ?? 1872));
  }
  return dir;
}

function dirnameFor(filePath) {
  const parts = String(filePath).replaceAll("\\", "/").split("/");
  parts.pop();
  return parts.join("/") || ".";
}

function title(value) {
  return String(value)
    .split("-")
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function webpHeader(width, height) {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(22, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8X", 12, "ascii");
  bytes.writeUInt32LE(10, 16);
  writeUInt24LE(bytes, width - 1, 24);
  writeUInt24LE(bytes, height - 1, 27);
  return bytes;
}

function writeUInt24LE(bytes, value, offset) {
  bytes.writeUInt8(value & 0xff, offset);
  bytes.writeUInt8((value >> 8) & 0xff, offset + 1);
  bytes.writeUInt8((value >> 16) & 0xff, offset + 2);
}
