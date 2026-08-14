#!/usr/bin/env node
/**
 * engine/mcp-server.js — servidor MCP stdio mínimo SIN dependencias (task 13.3).
 * Protocolo MCP stdio = JSON-RPC 2.0 delimitado por newline (una línea JSON por
 * mensaje) por stdin/stdout.
 *
 * Tools:
 *   context_query — CQL (FIND ...) → runCQL; intención natural → interpret → runIntent
 *   search_files  — passthrough a scripts/search-code (rg)
 *   read_file     — passthrough a scripts/extract-context
 *
 * Test: bash engine/mcp-test.sh
 */

import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCQL, runIntent } from './engine.js';

const SCRIPTS = fileURLToPath(new URL('../scripts/', import.meta.url));

const TOOLS = [
  {
    name: 'context_query',
    description: 'Query de contexto: CQL (FIND ...) o intención en lenguaje natural → pipeline optimizer+engine',
    inputSchema: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: 'Query CQL o intención natural' },
        constraints: {
          type: 'object',
          properties: {
            budget: { type: 'number' },
            limit: { type: 'number' },
            scope: { type: 'string' },
          },
        },
      },
      required: ['intent'],
    },
  },
  {
    name: 'search_files',
    description: 'Passthrough a scripts/search-code (rg)',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        dir: { type: 'string' },
        case_insensitive: { type: 'boolean' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'read_file',
    description: 'Passthrough a scripts/extract-context (archivo con numeración de líneas)',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        start_line: { type: 'number' },
        end_line: { type: 'number' },
      },
      required: ['path'],
    },
  },
];

function runScript(script, args) {
  try {
    return execFileSync(script, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    return e.stdout ?? ''; // exit != 0: devolver stdout si lo hay (rg sin matches)
  }
}

function handleCall(name, args) {
  switch (name) {
    case 'context_query': {
      const intent = String(args?.intent ?? '').trim();
      if (!intent) throw new Error('context_query: falta intent');
      const cqlLike = /^\s*FIND\b/i.test(intent);
      const out = cqlLike ? runCQL(intent) : runIntent(intent);
      return { content: [{ type: 'text', text: JSON.stringify(out) }] };
    }
    case 'search_files': {
      const a = ['-d', String(args?.dir ?? '.'), ...(args?.case_insensitive ? ['-i'] : []), String(args?.pattern ?? '')];
      const text = runScript(path.join(SCRIPTS, 'search-code'), a);
      return { content: [{ type: 'text', text }] };
    }
    case 'read_file': {
      const a = [String(args?.path ?? ''), String(args?.start_line ?? 1)];
      if (args?.end_line != null) a.push(String(args.end_line));
      const text = runScript(path.join(SCRIPTS, 'extract-context'), a);
      return { content: [{ type: 'text', text }] };
    }
    default:
      throw new Error(`tool desconocida: ${name}`);
  }
}

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function respondError(id, message, code = -32000) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; } // mensaje corrupto → ignorar
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'contextforge', version: '0.1.0' },
      });
      break;
    case 'notifications/initialized':
      break; // notification → sin respuesta
    case 'tools/list':
      respond(id, { tools: TOOLS });
      break;
    case 'tools/call':
      try {
        respond(id, handleCall(params?.name, params?.arguments ?? {}));
      } catch (err) {
        respondError(id, err.message);
      }
      break;
    default:
      respondError(id, `method no soportado: ${method}`, -32601);
  }
});

rl.on('close', () => process.exit(0));
