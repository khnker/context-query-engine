#!/usr/bin/env bash
# 13.3 — test servidor MCP stdio: initialize + notifications/initialized + tools/list + tools/call
# Envía mensajes JSON-RPC 2.0 (una línea por mensaje) por pipe a node engine/mcp-server.js
# y muestra las respuestas del servidor.
set -uo pipefail
cd "$(dirname "$0")/.."

{
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}'
  echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  echo '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  echo '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"context_query","arguments":{"intent":"FIND definitions OF symbol parseConfig","constraints":{"budget":2000,"limit":10,"scope":"."}}}}'
  echo '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"context_query","arguments":{"intent":"donde está definido parseConfig"}}}'
  echo '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"search_files","arguments":{"pattern":"parseConfig","dir":"engine","case_insensitive":true}}}'
  echo '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"read_file","arguments":{"path":"engine/optimizer.js","start_line":1,"end_line":8}}}'
  echo '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"search_files","arguments":{"pattern":"nonexistent_symbol_xyz"}}}'
} | node engine/mcp-server.js
