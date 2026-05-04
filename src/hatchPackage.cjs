const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const HATCH_ATLAS_CONTRACT = Object.freeze({
  width: 1536,
  height: 1872,
  cell_width: 192,
  cell_height: 208,
  columns: 8,
  rows: 9,
  states: ["idle", "running-right", "running-left", "waving", "jumping", "failed", "waiting", "running", "review"],
});

async function loadHatchPetPackage(inputPath, options = {}) {
  const packageDir = await resolveHatchPetDir(inputPath, options);
  const summary = await readHatchPetSummary(packageDir);
  const bytes = await fs.readFile(summary.spritesheet_path);

  return {
    ...summary,
    atlas_contract: { ...HATCH_ATLAS_CONTRACT },
    data_url: `data:${summary.image.content_type};base64,${bytes.toString("base64")}`,
    appearance: {
      source: "openai_hatch_pet",
      package_id: summary.manifest.id,
      manifest_file: "pet.json",
      spritesheet_file: path.basename(summary.spritesheet_path),
      pet_json: summary.manifest,
      atlas_contract: { ...HATCH_ATLAS_CONTRACT },
    },
  };
}

async function discoverHatchPetPackages(options = {}) {
  const root = path.resolve(expandHome(options.root ?? path.join(codexHome(), "pets")));
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const packages = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const packageDir = path.join(root, entry.name);
    try {
      packages.push(await readHatchPetSummary(packageDir));
    } catch (error) {
      if (options.includeInvalid) {
        packages.push({
          package_dir: packageDir,
          status: "invalid",
          error: error.message,
        });
      }
    }
  }
  return packages.sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
}

async function readHatchPetSummary(packageDir) {
  const manifestPath = path.join(packageDir, "pet.json");
  const manifest = sanitizeHatchManifest(JSON.parse(await fs.readFile(manifestPath, "utf8")));
  const spriteRelativePath = manifest.spritesheetPath || "spritesheet.webp";
  assertSafeRelativePath(spriteRelativePath);
  const spritesheetPath = path.resolve(packageDir, spriteRelativePath);
  const packagePrefix = packageDir.endsWith(path.sep) ? packageDir : `${packageDir}${path.sep}`;
  if (!spritesheetPath.startsWith(packagePrefix)) {
    throw new Error("hatch-pet spritesheetPath must stay inside the pet package directory.");
  }

  const bytes = await fs.readFile(spritesheetPath);
  const image = inspectHatchSpritesheet(bytes);
  if (image.width !== HATCH_ATLAS_CONTRACT.width || image.height !== HATCH_ATLAS_CONTRACT.height) {
    throw new Error(
      `hatch-pet spritesheet must be ${HATCH_ATLAS_CONTRACT.width}x${HATCH_ATLAS_CONTRACT.height}; received ${image.width}x${image.height}.`,
    );
  }

  return {
    package_dir: packageDir,
    manifest_path: manifestPath,
    spritesheet_path: spritesheetPath,
    manifest,
    image,
    updated_at: await packageUpdatedAt(manifestPath, spritesheetPath),
  };
}

async function resolveHatchPetDir(inputPath, options = {}) {
  if (!inputPath) return resolveDiscoveredHatchPetDir(options);
  const expanded = expandHome(String(inputPath).trim());
  const direct = path.resolve(expanded);
  if (await isDirectory(direct)) return direct;

  if (!path.isAbsolute(expanded) && !expanded.includes("/") && !expanded.includes("\\")) {
    const searchRoot = options.root ? path.resolve(expandHome(options.root)) : path.join(codexHome(), "pets");
    const codexPetDir = path.join(searchRoot, expanded);
    if (await isDirectory(codexPetDir)) return codexPetDir;
  }

  throw new Error(`hatch-pet package not found: ${inputPath}`);
}

async function resolveDiscoveredHatchPetDir(options) {
  const candidates = await discoverHatchPetPackages({ root: options.root });
  if (candidates.length === 0) {
    const root = path.resolve(expandHome(options.root ?? path.join(codexHome(), "pets")));
    throw new Error(`No hatch-pet packages were found under ${root}.`);
  }
  if (candidates.length === 1) return candidates[0].package_dir;
  const names = candidates.map((candidate) => `${candidate.manifest.displayName} (${candidate.manifest.id}) -> ${candidate.package_dir}`).join("\n");
  throw new Error(`Multiple hatch-pet packages were found. Pass --path so the first League selection is explicit.\n${names}`);
}

function sanitizeHatchManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("hatch-pet pet.json must be a JSON object.");
  }
  const id = sanitizeSlug(manifest.id);
  const displayName = sanitizeText(manifest.displayName, 80);
  const description = sanitizeText(manifest.description, 180);
  const spritesheetPath = sanitizeText(manifest.spritesheetPath || "spritesheet.webp", 160);
  if (!id) throw new Error("hatch-pet pet.json is missing a valid id.");
  if (!displayName) throw new Error("hatch-pet pet.json is missing displayName.");
  if (!description) throw new Error("hatch-pet pet.json is missing description.");
  return {
    id,
    displayName,
    description,
    spritesheetPath,
  };
}

function inspectHatchSpritesheet(buffer) {
  const png = inspectPng(buffer);
  if (png) return png;
  const webp = inspectWebp(buffer);
  if (webp) return webp;
  throw new Error("hatch-pet spritesheet must be a valid PNG or WebP file.");
}

function inspectPng(buffer) {
  const signature = "89504e470d0a1a0a";
  if (buffer.length < 45 || buffer.subarray(0, 8).toString("hex") !== signature) return null;
  if (buffer.readUInt32BE(8) !== 13 || buffer.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error("hatch-pet PNG spritesheet is missing a valid IHDR chunk.");
  }
  return {
    format: "png",
    content_type: "image/png",
    extension: "png",
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    byte_length: buffer.length,
  };
}

function inspectWebp(buffer) {
  if (buffer.length < 30 || buffer.subarray(0, 4).toString("ascii") !== "RIFF" || buffer.subarray(8, 12).toString("ascii") !== "WEBP") {
    return null;
  }
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const fourcc = buffer.subarray(offset, offset + 4).toString("ascii");
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (dataOffset + chunkSize > buffer.length + 1) break;
    if (fourcc === "VP8X" && chunkSize >= 10) {
      return webpInfo(read24LE(buffer, dataOffset + 4) + 1, read24LE(buffer, dataOffset + 7) + 1, buffer.length);
    }
    if (fourcc === "VP8L" && chunkSize >= 5 && buffer.readUInt8(dataOffset) === 0x2f) {
      const bits = buffer.readUInt32LE(dataOffset + 1);
      return webpInfo((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1, buffer.length);
    }
    if (fourcc === "VP8 " && chunkSize >= 10 && buffer.subarray(dataOffset + 3, dataOffset + 6).toString("hex") === "9d012a") {
      return webpInfo(buffer.readUInt16LE(dataOffset + 6) & 0x3fff, buffer.readUInt16LE(dataOffset + 8) & 0x3fff, buffer.length);
    }
    offset = dataOffset + chunkSize + (chunkSize % 2);
  }
  throw new Error("hatch-pet WebP spritesheet is missing readable canvas dimensions.");
}

function webpInfo(width, height, byteLength) {
  return {
    format: "webp",
    content_type: "image/webp",
    extension: "webp",
    width,
    height,
    byte_length: byteLength,
  };
}

function read24LE(buffer, offset) {
  return buffer.readUInt8(offset) | (buffer.readUInt8(offset + 1) << 8) | (buffer.readUInt8(offset + 2) << 16);
}

function assertSafeRelativePath(value) {
  const normalized = String(value).replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("../") || normalized === "..") {
    throw new Error("hatch-pet spritesheetPath must be a relative file path.");
  }
}

async function isDirectory(value) {
  try {
    return (await fs.stat(value)).isDirectory();
  } catch {
    return false;
  }
}

async function packageUpdatedAt(...filePaths) {
  const stats = await Promise.all(filePaths.map((filePath) => fs.stat(filePath)));
  return new Date(Math.max(...stats.map((stat) => stat.mtimeMs))).toISOString();
}

function codexHome() {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith(`~${path.sep}`) || value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function sanitizeSlug(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

function sanitizeText(value, maxLength) {
  return String(value ?? "").trim().replace(/[<>]/g, "").slice(0, maxLength);
}

module.exports = {
  HATCH_ATLAS_CONTRACT,
  discoverHatchPetPackages,
  inspectHatchSpritesheet,
  loadHatchPetPackage,
};
