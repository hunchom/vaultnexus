import { describe, it, expect, afterEach } from 'vitest';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { SocketServerTransport } from '../../src/daemon/socket-transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

const sockPath = join(tmpdir(), `vn-transport-test-${process.pid}.sock`);
let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  try { rmSync(sockPath); } catch { /* already gone */ }
});

/** Spin up a server that wraps its one connection in SocketServerTransport. */
function listenWithTransport(): Promise<SocketServerTransport> {
  return new Promise((resolve) => {
    server = createServer((socket: Socket) => {
      const t = new SocketServerTransport(socket);
      void t.start();
      resolve(t);
    });
    server.listen(sockPath);
  });
}

describe('SocketServerTransport', () => {
  it('parses newline-delimited JSON-RPC into onmessage', async () => {
    const transportPromise = listenWithTransport();
    const client = connect(sockPath);
    await new Promise<void>((r) => client.on('connect', () => r()));
    const transport = await transportPromise;

    const received: JSONRPCMessage[] = [];
    transport.onmessage = (m) => received.push(m);

    client.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
    await new Promise<void>((r) => setTimeout(r, 50));

    expect(received).toEqual([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
    client.destroy();
  });

  it('serializes send() as one JSON line', async () => {
    const transportPromise = listenWithTransport();
    const client = connect(sockPath);
    await new Promise<void>((r) => client.on('connect', () => r()));
    const transport = await transportPromise;

    const chunks: string[] = [];
    client.setEncoding('utf8');
    client.on('data', (c: string) => chunks.push(c));

    await transport.send({ jsonrpc: '2.0', id: 2, result: { ok: true } });
    await new Promise<void>((r) => setTimeout(r, 50));

    expect(chunks.join('')).toBe(
      JSON.stringify({ jsonrpc: '2.0', id: 2, result: { ok: true } }) + '\n',
    );
    client.destroy();
  });
});
