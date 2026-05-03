import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ASSET_ROOT = new URL("../../data/assets", import.meta.url);

export async function saveAtlasObject(objectKey, dataUrl, env = process.env, transport = fetch) {
  if (!dataUrl) return { stored: false, reason: "no_atlas" };
  assertObjectKey(objectKey);
  const buffer = atlasBuffer(dataUrl);
  if (assetProvider(env) === "s3_compatible") {
    return putS3Object(objectKey, buffer, env, transport);
  }
  const filePath = objectFilePath(objectKey, env);
  await mkdir(dirname(filePath), { recursive: true });
  try {
    await writeFile(filePath, buffer, { flag: "wx" });
    return { stored: true, object_key: objectKey, byte_length: buffer.length };
  } catch (error) {
    if (error.code === "EEXIST") return { stored: false, reason: "already_exists", object_key: objectKey };
    throw error;
  }
}

export async function readAssetObject(objectKey, env = process.env, transport = fetch) {
  assertObjectKey(objectKey);
  if (assetProvider(env) === "s3_compatible") return getS3Object(objectKey, env, transport);
  return readFile(objectFilePath(objectKey, env));
}

export function assetStorageStatus(env = process.env) {
  const provider = assetProvider(env);
  return {
    provider,
    local_root: assetRoot(env),
    public_cdn_base_url: env.CODEX_PET_ASSET_CDN_BASE_URL || null,
    s3: {
      endpoint: env.CODEX_PET_S3_ENDPOINT ? "configured" : "missing",
      bucket: env.CODEX_PET_S3_BUCKET || "missing",
      region: env.CODEX_PET_S3_REGION || "auto",
      credentials: env.CODEX_PET_S3_ACCESS_KEY_ID && env.CODEX_PET_S3_SECRET_ACCESS_KEY ? "configured" : "missing",
    },
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
  assertObjectKey(cleanKey);
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

async function putS3Object(objectKey, buffer, env, transport) {
  const request = signedS3Request("PUT", objectKey, env, buffer, { "content-type": "image/png" });
  const response = await transport(request.url, {
    method: "PUT",
    headers: request.headers,
    body: buffer,
  });
  if (!response?.ok && response?.status !== 409) {
    throw providerError("ASSET_PROVIDER_WRITE_FAILED", `Asset provider write failed with ${response?.status ?? "no response"}.`);
  }
  return { stored: true, object_key: objectKey, byte_length: buffer.length, provider: "s3_compatible" };
}

async function getS3Object(objectKey, env, transport) {
  const request = signedS3Request("GET", objectKey, env);
  const response = await transport(request.url, {
    method: "GET",
    headers: request.headers,
  });
  if (!response?.ok) {
    const error = providerError("ASSET_PROVIDER_READ_FAILED", `Asset provider read failed with ${response?.status ?? "no response"}.`);
    error.status = response?.status === 404 ? 404 : 502;
    throw error;
  }
  return Buffer.from(await response.arrayBuffer());
}

function signedS3Request(method, objectKey, env, body = Buffer.alloc(0), extraHeaders = {}) {
  const config = s3Config(env);
  const date = new Date();
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = hashHex(body);
  const path = `/${encodeURIComponent(config.bucket)}/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
  const endpoint = config.endpoint.replace(/\/+$/, "");
  const url = `${endpoint}${path}`;
  const host = new URL(endpoint).host;
  const headers = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...extraHeaders,
  };
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((name) => `${name.toLowerCase()}:${String(headers[name]).trim()}\n`)
    .join("");
  const signedHeaders = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort()
    .join(";");
  const canonicalRequest = [method, path, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, hashHex(canonicalRequest)].join("\n");
  const signature = hmacHex(signingKey(config.secretAccessKey, dateStamp, config.region), stringToSign);
  const requestHeaders = {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
  delete requestHeaders.host;
  return {
    url,
    headers: requestHeaders,
  };
}

function s3Config(env) {
  const config = {
    endpoint: env.CODEX_PET_S3_ENDPOINT,
    bucket: env.CODEX_PET_S3_BUCKET,
    region: env.CODEX_PET_S3_REGION || "auto",
    accessKeyId: env.CODEX_PET_S3_ACCESS_KEY_ID,
    secretAccessKey: env.CODEX_PET_S3_SECRET_ACCESS_KEY,
  };
  for (const [key, value] of Object.entries(config)) {
    if (!value) throw providerError("ASSET_PROVIDER_NOT_CONFIGURED", `S3 asset storage is missing ${key}.`);
  }
  return config;
}

function signingKey(secret, dateStamp, region) {
  const dateKey = hmacBuffer(`AWS4${secret}`, dateStamp);
  const regionKey = hmacBuffer(dateKey, region);
  const serviceKey = hmacBuffer(regionKey, "s3");
  return hmacBuffer(serviceKey, "aws4_request");
}

function hmacBuffer(key, value) {
  return createHmac("sha256", key).update(value).digest();
}

function hmacHex(key, value) {
  return createHmac("sha256", key).update(value).digest("hex");
}

function hashHex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertObjectKey(objectKey) {
  const cleanKey = String(objectKey ?? "").replaceAll("\\", "/");
  if (!/^[A-Za-z0-9_.:-]+\/[A-Za-z0-9_.:-]+\.png$/.test(cleanKey)) {
    throw providerError("ASSET_OBJECT_KEY_INVALID", "Asset object key is invalid.", 400);
  }
}

function assetProvider(env) {
  const provider = env.CODEX_PET_ASSET_STORAGE || "local_fs";
  if (provider === "local_fs" || provider === "s3_compatible") return provider;
  throw providerError("ASSET_PROVIDER_UNSUPPORTED", `Unsupported asset storage provider: ${provider}.`);
}

function providerError(code, message, status = 503) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}
