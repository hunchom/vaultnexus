#!/usr/bin/env node
import { connect } from 'node:net';
import { defaultSocketPath } from '../core/paths.js';

// Dumb byte pipe: Claude Code <-> (stdio) <-> this bridge <-> (socket) <-> daemon.
// No MCP parsing — newline-delimited JSON-RPC passes through untouched.
const socket = connect(defaultSocketPath());

socket.on('connect', () => {
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});

socket.on('error', (err) => {
  process.stderr.write(`vaultnexus-bridge: ${err.message}\n`);
  process.exit(1);
});

socket.on('close', () => process.exit(0));
process.stdin.on('end', () => socket.end());
