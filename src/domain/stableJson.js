import { createHash } from "node:crypto";

export function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

export function stableHash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (child !== undefined) normalized[key] = stableValue(child);
  }
  return normalized;
}
