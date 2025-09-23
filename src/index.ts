#!/usr/bin/env node

import type { SDKResultMessage } from '@anthropic-ai/claude-code';
import { InvalidArgumentError, program } from 'commander';
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { Agent, Dispatcher, fetch, type Response } from 'undici';

const packageJsonDir = path.resolve(fileURLToPath(import.meta.url), '../../package.json');
const VERSION = JSON.parse(fs.readFileSync(packageJsonDir, 'utf-8')).version;

const command = program
  .version(VERSION)
  .requiredOption('--stream-server-url <string>', 'ai stream proxy server url e.g. http://localhost:8888.')
  .requiredOption('--stream-id <string>', 'stream id for this claude execution.')
  .option('--stream-message-id <string>', 'message id for this claude execution. Default to stream-id.')
  .option('--stream-protocol', 'v1 or v2. default to v1.', 'v2')
  .option('--stream-server-token <string>', 'auth token')
  .requiredOption('-p,--print', 'Required. See claude --help.')
  .requiredOption('--output-format <format>', 'Must be "stream-json". See claude --help.', value => {
    if (value !== 'stream-json') {
      throw new InvalidArgumentError('output format must be stream-json.');
    }
  })
  .requiredOption('--verbose', 'Required. See claude --help.')
  .requiredOption('--include-partial-messages', 'Required. See claude --help.')
  .allowUnknownOption()
  .allowExcessArguments()
  .action(async function (options) {
    const { operands, unknown } = this.parseOptions(process.argv.slice(2));

    const {
      streamServerUrl,
      streamServerToken,
      streamId,
      streamProtocol,
      streamMessageId,
    } = options as {
      streamServerUrl: string;
      streamServerToken: string;
      streamId: string;
      streamProtocol: 'v1' | 'v2';
      streamMessageId?: string;
    };

    const cp = spawn('claude', ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose', ...unknown, ...operands], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    process.stderr.write(`[claude-tee ${Date.now()}  INFO]: ${VERSION}\n`);
    cp.stderr.on('close', () => {
      process.stderr.write(`[claude-tee ${Date.now()}  INFO]: claude stderr close\n`);
    }).pipe(process.stderr, { end: false });

    let result: SDKResultMessage | undefined;

    const headers: Record<string, string> = {};

    if (streamServerToken) {
      headers['Authorization'] = `Bearer ${streamServerToken}`;
    }

    if (streamProtocol === 'v1') {
      const request = http.request(`${streamServerUrl}/v1/streams/${encodeURIComponent(streamId)}`, {
        method: 'POST',
        headers,
        timeout: 0,
      });

      request.on('error', (err) => {
        process.stderr.write(`[claude-tee ${Date.now()} ERROR]: failed to send stream to server: ${inspect(err)}\n`);
      });

      request.on('response', response => {
        if (response.statusCode !== 200) {
          process.stderr.write(`[claude-tee ${Date.now()} ERROR]: failed to send stream to server\n`);
          process.stderr.write(`[claude-tee ${Date.now()} ERROR][resp]: ${response.statusCode} ${response.statusMessage}\n`);
          response
            .map((dat: Buffer) => {
              return `[claude-tee ${Date.now()} ERROR][resp]: ` + dat.toString('utf-8') + '\n';
            })
            .pipe(process.stderr, { end: false });

          request.destroy();
        } else {
          response.on('data', () => {});
        }
      });

      cp.on('spawn', () => {
        process.stderr.write(`[claude-tee ${Date.now()}  INFO]: spawned claude code ${cp.pid}\n`);
        request.write('\x00\x00claude code spawned\x00\x00\n');
      });

      cp.stdout
        .on('data', (data: Buffer) => {
          if (request.writable) {
            try {
              request.write(data);
            } catch {
            }
          }
          const output = data.toString('utf-8');
          output.split('\n').forEach(line => {
            if (line.trim()) {
              try {
                const chunk = JSON.parse(line);
                if (chunk.type === 'result') {
                  result = chunk;
                }
              } catch {
              }
            }
          });
        })
        .on('close', () => {
          request.end();
          process.stderr.write(`[claude-tee ${Date.now()}  INFO]: claude stdout close\n`);
        });

      cp
        .on('error', (err) => {
          request.destroy(err);
          process.stderr.write(`[claude-tee ${Date.now()} ERROR]: failed to spawn claude code: ${inspect(err)}\n`);
          process.exit(1);
        })
        .on('close', async (code, signal) => {
          process.stderr.write(`[claude-tee ${Date.now()}  INFO]: claude code close with code ${code}\n`);
          if (code != null) {
            if (result) {
              if (result.subtype === 'success') {
                if (result.is_error) {
                  // Force exit with error
                  process.stderr.write(result.result + '\n');
                } else {
                  process.stdout.write(result.result + '\n');
                }
              } else {
                process.stderr.write(result.subtype + '\n');
              }
            } else {
              process.stderr.write(`claude code exit (${code}) with no result message.`);
            }
            process.exitCode = code;
          } else {
            process.stderr.write(`${signal}\n`);
            process.exitCode = -1;
          }
          clearInterval(heartbeatInterval);
          scheduleExit(cp);

          if (request.destroyed) {
            process.stderr.write(`[claude-tee ${Date.now()}  INFO]: stream already closed, exit\n`);
            process.exit();
          } else {
            process.stderr.write(`[claude-tee ${Date.now()}  INFO]: wait for request stream ending\n`);
            request.on('close', () => {
              process.stderr.write(`[claude-tee ${Date.now()}  INFO]: stream closed, exit\n`);
              process.exit();
            });
          }

          request.destroy();
        });

      const heartbeatInterval = setInterval(() => {
        try {
          if (request.writable) {
            request.write('\x00\x00heartbeat\x00\x00\n');
          }
        } catch {
        }
        if (cp.exitCode != null && request.closed) {
          process.stderr.write(`[claude-tee ${Date.now()}  INFO]: force exit (claude exited ${cp.exitCode}, stream ended)\n`);
          process.exit(cp.exitCode);
        }
      }, 5000);
    }

    if (streamProtocol === 'v2') {
      const client = new V2Client(streamServerUrl, streamServerToken, streamId, streamMessageId);

      cp.stdout
        .on('data', (data: Buffer) => {
          client.put(data);
          const output = data.toString('utf-8');
          output.split('\n').forEach(line => {
            if (line.trim()) {
              try {
                const chunk = JSON.parse(line);
                if (chunk.type === 'result') {
                  result = chunk;
                }
              } catch {
              }
            }
          });
        })
        .on('end', () => {
          client.stop(false, 'stdout end');
        })
        .on('error', (err) => {
          client.stop(true, `stdout error: ${err.message}`);
        });

      cp
        .on('error', async (err) => {
          process.stderr.write(`[claude-tee ${Date.now()} ERROR]: failed to spawn claude code: ${inspect(err)}\n`);
          client.stop(true, `spawn error: ${err.message}`);
          process.exit(1);
        })
        .on('close', (code, signal) => {
          process.stderr.write(`[claude-tee ${Date.now()}  INFO]: claude code close with code ${code}\n`);
          if (code != null) {
            if (result) {
              if (result.subtype === 'success') {
                if (result.is_error) {
                  // Force exit with error
                  process.stderr.write(result.result + '\n');
                } else {
                  process.stdout.write(result.result + '\n');
                }
              } else {
                process.stderr.write(result.subtype + '\n');
              }
            } else {
              process.stderr.write(`claude code exit (${code}) with no result message.`);
            }
            process.exitCode = code;
          } else {
            process.stderr.write(`${signal}\n`);
            process.exitCode = -1;
          }
          client.wait()
            .finally(() => {
              process.exit();
            });
        });
    }
  });

function scheduleExit (cp: ChildProcess) {
  setTimeout(() => {
    process.stderr.write(`[claude-tee ${Date.now()}  INFO]: force exit (30s timeout)\n`);
    process.exit(cp.exitCode);
  }, 30000);
}

class V2Client {
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
          content_type: 'claude-code-stream-json+include-partial-messages',
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
    // process.stderr.write(`[claude-tee ${Date.now()} DEBUG]: put ${this.cursor}: ${data.length} bytes\n`);
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
    if (this.failed) {
      return;
    }

    process.stderr.write(`[claude-tee ${Date.now()}  INFO]: ${abort ? 'abort' : 'stop'} stream ${this.cursor}: ${reason}\n`);
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
  }
}

function handleResponse (action: string) {
  return (res: Response) => {
    if (!res.ok) {
      throw new Error(`failed to ${action}: ${res.status}`);
    }
  };
}

async function retryIfFailed (action: string, cb: () => Promise<void>, times: number = 3) {
  let attempt = 0;

  for (let i = 0; i < times; i++) {
    try {
      await cb();
      return;
    } catch (e) {
      attempt++;
      if (attempt < times) {
        process.stderr.write(`[claude-tee ${Date.now()}  INFO]: failed to ${action}, retrying after 1 second... (${attempt}/${times}) ${inspect(e)}\n`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else {
        process.stderr.write(`[claude-tee ${Date.now()}  INFO]: failed to ${action}, giving up. (${attempt}/${times})\n`);
        throw e;
      }
    }
  }
}

command.parse();
