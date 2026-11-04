#!/usr/bin/env node
/**
 * lib/providers/anthropic-tool-stub.mjs — MCP stdio stub for the client tool bridge
 *
 * Authority: ADR 0009 Amendment 2; evidence in docs/spikes/2026-11-02-client-tool-bridge.md
 * (claude CLI 2.1.304 § --mcp-config).
 *
 * The claude CLI starts this process as an MCP server (one per spawn, only when the
 * request carries tools[]). It registers the client's tools so the model can choose
 * one. It never answers `tools/call`: anthropic.mjs reads the model's `tool_use`
 * event from the CLI's stdout, hands it to the client and terminates the CLI. The
 * tool itself always runs on the client.
 *
 * argv[2] = path of a JSON file with the tool list [{ name, description, inputSchema }].
 * The process ends when the CLI closes stdin.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const FALLBACK_PROTOCOL = '2024-11-05';

export function loadTools(path) {
  try {
    const tools = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(tools) ? tools : [];
  } catch {
    return [];
  }
}

/**
 * Answers one JSON-RPC message. Returns the response object, or null when no
 * answer is due (notifications, and `tools/call` by design).
 */
export function handleMessage(msg, tools) {
  if (!msg || typeof msg !== 'object') return null;
  const isRequest = msg.id !== undefined && msg.method !== undefined;
  if (!isRequest) return null;
  switch (msg.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? FALLBACK_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: 'olp-tool-stub', version: '1.0.0' },
        },
      };
    case 'tools/list':
      return { jsonrpc: '2.0', id: msg.id, result: { tools } };
    case 'ping':
      return { jsonrpc: '2.0', id: msg.id, result: {} };
    case 'tools/call':
      return null; // by design: the client runs the tool, not this process
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}

function main() {
  const tools = loadTools(process.argv[2]);
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const res = handleMessage(msg, tools);
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  });
  rl.on('close', () => process.exit(0));
}

// import.meta.url is the resolved path; argv[1] keeps symlinks (macOS /var is a
// link to /private/var), so compare the real path.
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch (e) {
    // Without this the stub would exit silently and the CLI would just see "no tool".
    process.stderr.write(`anthropic-tool-stub: cannot resolve ${process.argv[1]}: ${e?.message ?? e}\n`);
    return false;
  }
}
if (isMain()) {
  main();
}
