import { Agent, Dispatcher, fetch, type Response } from 'undici';
import { retryIfFailed } from '../utils/retry.js';
import type { ClientType } from './types.js';

export class AIStreamProxyClient implements ClientType {
  private buf: Buffer[] = [];

  private chunks: Promise<void>[] = [];
  private finalPending: (() => Promise<void>)[] = [];
  private agent: Dispatcher;
  private cursor: number = 0;
  private headers: Record<string, string> = {};
  public readonly init: Promise<void>;
  private initialized = false;

  private heartbeatTimeout: NodeJS.Timeout | undefined;
  private failed = false;

  constructor (
    private readonly streamServerUrl: string,
    private readonly streamServerToken: string,
    private readonly streamId: string,
    private readonly streamMessageId: string | undefined,
    private readonly contentType: string,
  ) {
    this.agent = new Agent();
    if (streamServerToken) {
      this.headers['Authorization'] = `Bearer ${streamServerToken}`;
    }
    this.scheduleHeartbeat();
    this.init = retryIfFailed('init stream', async () => {
      await fetch(`${this.streamServerUrl}/v2/streams`, {
        method: 'POST',
        headers: {
          ...this.headers,
          'Content-Type': 'application/json',
        },
        dispatcher: this.agent,
        body: JSON.stringify({
          stream_id: streamId,
          message_id: streamMessageId ?? streamId,
          content_type: contentType,
        }),
      }).then(handleResponse('init stream'));
    })
      .then(() => {
        this.initialized = true;
        this.buf.forEach(chunk => this.put(chunk));
        this.buf = [];
      })
      .catch(() => {
        this.failed = true;
        this.cancelHeartbeat();
      });
  }

  cancelHeartbeat () {
    clearTimeout(this.heartbeatTimeout);
  }

  scheduleHeartbeat () {
    clearTimeout(this.heartbeatTimeout);
    this.heartbeatTimeout = setTimeout(() => {
      fetch(`${this.streamServerUrl}/v2/streams/${encodeURIComponent(this.streamId)}/actions/heartbeat`, {
        method: 'POST',
        headers: {
          ...this.headers,
        },
        dispatcher: this.agent,
        keepalive: true,
      }).catch(() => {})
        .finally(() => {
          this.scheduleHeartbeat();
        });
    }, 5000);
  }

  async wait (): Promise<void> {
    await this.init;

    if (this.failed) {
      return;
    }

    const chunks = this.chunks;
    this.chunks = [];
    await Promise.allSettled(chunks);

    if (this.chunks.length > 0) {
      await this.wait();
    } else {
      await Promise.allSettled(this.finalPending.map(fp => fp()));
    }
  }

  put (data: Buffer) {
    if (this.failed) {
      return;
    }

    if (!this.initialized) {
      this.buf.push(data);
      return;
    }

    const range = `bytes ${this.cursor}-${this.cursor + data.length - 1}`;
    // process.stderr.write(`[code-tee ${Date.now()} DEBUG]: put ${this.cursor}: ${data.length} bytes\n`);
    this.cursor += data.length;

    this.chunks.push(retryIfFailed(`send range ${range}`, async () => {
      await fetch(`${this.streamServerUrl}/v2/streams/${encodeURIComponent(this.streamId)}/content`, {
        method: 'PUT',
        headers: {
          ...this.headers,
          'X-Content-Range': range,
        },
        body: data,
        dispatcher: this.agent,
        keepalive: true,
      }).then(handleResponse('put data'));
    }).catch(() => {
      this.stop(true, 'failed to send data');
      this.failed = true;
      this.cancelHeartbeat();
    }).finally(() => {
      if (!this.failed) {
        this.scheduleHeartbeat();
      }
    }));
  }

  stop (abort: boolean, reason: string) {
    this.init.then(() => {
      if (this.failed) {
        return;
      }

      process.stderr.write(`[code-tee ${Date.now()}  INFO]: ${abort ? 'abort' : 'stop'} stream ${this.cursor}: ${reason}\n`);
      this.cancelHeartbeat();
      this.finalPending.push(() => retryIfFailed(`end stream`, async () => {
        await fetch(`${this.streamServerUrl}/v2/streams/${encodeURIComponent(this.streamId)}/actions/stop`, {
          method: 'POST',
          headers: {
            ...this.headers,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            stop_state: abort ? 'abort' : 'done',
            stop_reason: reason,
            final_size: this.cursor,
          }),
          dispatcher: this.agent,
          keepalive: true,
        }).then(handleResponse('stop stream'));
      }));
    });
  }
}

function handleResponse (action: string) {
  return async (res: Response) => {
    if (!res.ok) {
      throw new Error(`failed to ${action}: ${res.status} ${await res.text().catch(() => res.statusText)}`);
    }
  };
}
