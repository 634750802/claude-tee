import { BufferTransport, send } from '@vercel/queue';
import { retryIfFailed } from '../utils/retry.js';
import type { ClientType } from './types.js';

const bufferTransport = new BufferTransport();

export class VercelQueueClient implements ClientType {
  private topic: string;
  private queue: Buffer[] = [];
  private count = 0;

  private sending: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;

  constructor (
    streamServerUrl: string,
    streamServerToken: string,
    private readonly streamId: string,
    private readonly streamMessageId: string | undefined,
    private readonly contentType: string,
  ) {
    const url = new URL(streamServerUrl);
    this.topic = url.pathname + '-' + streamId;

    this.sending = retryIfFailed('init stream', () => this._init());
  }

  put (data: Buffer): void {
    this.count++;
    this.queue.push(data);
    this._trigger();
  }

  stop (abort: boolean, reason: string): void {
    if (this.stopPromise) {
      return;
    }
    this.stopPromise = retryIfFailed('stop stream', async () => {
      while (this.sending != null) {
        await this.sending;
      }
      await this._stop(abort, reason);
    });
  }

  async wait (): Promise<void> {
    while (this.sending != null) {
      await this.sending;
    }
    await this.stopPromise;
  }

  async _sendNextItem () {
    const first = this.queue[0];
    if (!first) {
      this.sending = undefined;
      return;
    }

    await retryIfFailed('send', async () => this._send(first));
    this.queue = this.queue.slice(1);

    this.sending = undefined;
    if (this.queue.length > 0) {
      this._trigger();
    }
  }

  async _init () {
    await send(this.topic, Buffer.concat([
      Buffer.of(0),
      Buffer.from(JSON.stringify({
        stream_id: this.streamId,
        message_id: this.streamMessageId ?? this.streamId,
        content_type: this.contentType,
      }), 'utf-8'),
    ]), {
      transport: bufferTransport,
    });

    this.sending = undefined;
    this._trigger();
  }

  async _send (buffer: Buffer) {
    await send(this.topic, Buffer.concat([
      Buffer.of(1),
      buffer,
    ]), {
      transport: bufferTransport,
    });
  }

  async _stop (abort: boolean, reason: string) {
    await send(this.topic, Buffer.concat([
      Buffer.of(2),
      Buffer.from(JSON.stringify({
        stop_state: abort ? 'abort' : 'done',
        stop_reason: reason,
        final_size: this.count,
      }), 'utf-8'),
    ]), {
      transport: bufferTransport,
    });
  }

  _trigger () {
    if (this.sending) {
      return;
    }
    this.sending = this._sendNextItem();
  }
}
