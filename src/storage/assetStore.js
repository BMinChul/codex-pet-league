import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ASSET_ROOT = new URL("../../data/assets", import.meta.url);

export async function saveAtlasObject(objectKey, dataUrl, env = process.env) {
  if (!dataUrl) return { stored: false, reason: "no_atlas" };
  const filePath = objectFilePath(objectKey, env);
  const buffer = atlasBuffer(dataUrl);
  await mkdir(dirname(filePath), { recursive: true });
  try {
    await writeFile(filePath, buffer, { flag: "wx" });
    return { stored: true, object_key: objectKey, byte_length: buffer.length };
  } catch (error) {
    if (error.code === "EEXIST") return { stored: false, reason: "already_exists", object_key: objectKey };
    throw error;
  }
}

export async function readAssetObject(objectKey, env = process.env) {
  return readFile(objectFilePath(objectKey, env));
}

export function assetStorageStatus(env = process.env) {
  return {
    provider: env.CODEX_PET_ASSET_STORAGE || "local_fs",
    local_root: assetRoot(env),
    public_cdn_base_url: env.CODEX_PET_ASSET_CDN_BASE_URL || null,
  };
}

function atlasBuffer(dataUrl) {
  const match = String(dataUrl).match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    const error = new Error("Atlas upload must be a PNG data URL.");
    error.status = 400;
    error.code = "ASSET_FORMAT_INVALID";
    throw error;
  }
  return Buffer.from(match[1], "base64");
}

function objectFilePath(objectKey, env) {
  const cleanKey = String(objectKey ?? "").replaceAll("\\", "/");
  if (!/^[A-Za-z0-9_.:-]+\/[A-Za-z0-9_.:-]+\.png$/.test(cleanKey)) {
    const error = new Error("Asset object key is invalid.");
    error.status = 400;
    error.code = "ASSET_OBJECT_KEY_INVALID";
    throw error;
  }
  const root = assetRoot(env);
  const filePath = resolve(root, cleanKey);
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!filePath.startsWith(rootPrefix)) {
    const error = new Error("Asset object key escapes the storage root.");
    error.status = 400;
    error.code = "ASSET_OBJECT_KEY_INVALID";
    throw error;
  }
  return filePath;
}

function assetRoot(env) {
  return resolve(env.CODEX_PET_ASSET_ROOT || fileURLToPath(DEFAULT_ASSET_ROOT));
}
