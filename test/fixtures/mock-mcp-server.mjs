#!/usr/bin/env node
/**
 * Minimal stdio MCP server fixture for gateway tests.
 *
 * Speaks the MCP JSON-RPC stdio protocol (newline-delimited JSON).
 * Exposes exactly 2 tools: "ping" and "echo".
 *
 * Protocol handled:
 *   initialize → capabilities response
 *   notifications/initialized → (ignored, no response)
 *   tools/list → tool list
 *   tools/call → execute ping or echo
 *
 * Exits cleanly when stdin closes.
 */

import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, terminal: false });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const TOOLS = [
  {
    name: 'ping',
    description: 'Returns pong',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'echo',
    description: 'Echoes back the message',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
  },
];

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // ignore malformed lines
  }

  // Notifications have no id — no response expected.
  if (msg.method === 'notifications/initialized') return;
  if (msg.id == null) return;

  const id = msg.id;

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'mock-mcp-server', version: '1.0.0' },
        capabilities: { tools: {} },
      },
    });
    return;
  }

  if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: { tools: TOOLS },
    });
    return;
  }

  if (msg.method === 'tools/call') {
    const toolName = msg.params?.name;
    const args = msg.params?.arguments ?? {};
    if (toolName === 'ping') {
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: 'pong' }] },
      });
    } else if (toolName === 'echo') {
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: String(args.message ?? '') }] },
      });
    } else {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Unknown tool: ${toolName}` },
      });
    }
    return;
  }

  // Unknown method
  send({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${msg.method}` },
  });
});

rl.on('close', () => {
  process.exit(0);
});
