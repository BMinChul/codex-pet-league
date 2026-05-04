#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const { resolve } = require("node:path");

const bridgePath = resolve(__dirname, "../../../src/mcp/codex-pet-mcp.cjs");
const child = spawn(process.execPath, [bridgePath], {
  env: process.env,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`Failed to start Codex Pet League MCP bridge: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 0);
});
