#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");

const logDir = path.join(process.cwd(), "identity-probe", "logs");
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, `probe-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);

const sensitivePattern = /(token|secret|key|auth|credential|password|session|cookie|bearer)/i;
const identityPattern = /(openai|chatgpt|codex|user|account|workspace|org|organization|plugin|mcp|client|auth|token|session|credential|home|profile)/i;

function redactValue(key, value) {
  const text = String(value ?? "");
  if (sensitivePattern.test(key)) {
    return { redacted: true, length: text.length };
  }
  if (text.length > 160) {
    return `${text.slice(0, 80)}...<${text.length} chars>`;
  }
  return text;
}

function sanitize(value, key = "") {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return redactValue(key, value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, key));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitize(v, k);
    return out;
  }
  return String(value);
}

function collectEnv() {
  const selected = {};
  const names = Object.keys(process.env).sort();
  for (const name of names) {
    if (identityPattern.test(name)) {
      selected[name] = redactValue(name, process.env[name]);
    }
  }
  return {
    selected,
    counts: {
      total: names.length,
      selected: Object.keys(selected).length,
    },
    has: {
      CODEX_HOME: Boolean(process.env.CODEX_HOME),
      OPENAI_API_KEY: Boolean(process.env.OPENAI_API_KEY),
      CHATGPT: names.some((name) => /chatgpt/i.test(name)),
      OPENAI: names.some((name) => /openai/i.test(name)),
      CODEX: names.some((name) => /codex/i.test(name)),
      USER_ID: names.some((name) => /user.*id|account.*id|workspace.*id/i.test(name)),
    },
  };
}

function writeLog(event) {
  fs.appendFileSync(logFile, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, resultValue) {
  send({ jsonrpc: "2.0", id, result: resultValue });
}

function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

const tools = [
  {
    name: "identity_probe",
    title: "Identity Probe",
    description:
      "Reports sanitized Codex/MCP process metadata visible to a local MCP server. It does not read auth files or expose secret values.",
    inputSchema: {
      type: "object",
      properties: {
        note: { type: "string" },
      },
      additionalProperties: false,
    },
  },
];

function handleRequest(message) {
  writeLog({ direction: "in", message: sanitize(message) });

  const { id, method, params } = message;
  if (method === "initialize") {
    result(id, {
      protocolVersion: params?.protocolVersion ?? "2024-11-05",
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: "codex-pet-league-identity-probe",
        version: "0.1.0",
      },
    });
    return;
  }

  if (method === "notifications/initialized") {
    return;
  }

  if (method === "tools/list") {
    result(id, { tools });
    return;
  }

  if (method === "tools/call") {
    if (params?.name !== "identity_probe") {
      error(id, -32602, `Unknown tool: ${params?.name}`);
      return;
    }

    const payload = {
      verdict_hint:
        "If this output lacks a signed OpenAI/ChatGPT user claim, Pet League cannot treat Codex local MCP as OpenAI-attested identity.",
      process: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        pid: process.pid,
        cwd: process.cwd(),
        argv: process.argv.map((arg) => (sensitivePattern.test(arg) ? "<redacted>" : arg)),
      },
      os: {
        userInfo: sanitize(os.userInfo(), "userInfo"),
        hostname: os.hostname(),
      },
      env: collectEnv(),
      received_call_params: sanitize(params),
      log_file: logFile,
    };

    writeLog({ direction: "tool-result", payload });
    result(id, {
      content: [
        {
          type: "text",
          text: JSON.stringify(payload, null, 2),
        },
      ],
      structuredContent: payload,
    });
    return;
  }

  error(id, -32601, `Method not found: ${method}`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) continue;
    try {
      handleRequest(JSON.parse(line));
    } catch (err) {
      writeLog({ direction: "parse-error", line, error: String(err?.stack ?? err) });
    }
  }
});

process.stdin.on("end", () => {
  writeLog({ direction: "stdin-end" });
});

writeLog({
  direction: "start",
  process: sanitize({ argv: process.argv, cwd: process.cwd(), env: collectEnv() }),
});
