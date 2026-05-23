import type { Socket } from 'node:net';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js';

/** MCP Transport over a net.Socket; newline-delimited JSON-RPC framing. */
export class SocketServerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  private buffer = '';

  constructor(private readonly socket: Socket) {}

  async start(): Promise<void> {
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string) => this.ingest(chunk));
    this.socket.on('close', () => this.onclose?.());
    this.socket.on('error', (err) => this.onerror?.(err));
  }

  private ingest(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      try {
        this.onmessage?.(JSON.parse(line) as JSONRPCMessage);
      } catch (err) {
        this.onerror?.(err as Error);
      }
    }
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    this.socket.write(JSON.stringify(message) + '\n');
  }

  async close(): Promise<void> {
    this.socket.end();
  }
}
