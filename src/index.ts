#!/usr/bin/env node

import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-code';
import { InvalidArgumentError, Option, program } from 'commander';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { TextDecoderStream } from 'node:stream/web';
import { fileURLToPath } from 'node:url';

const packageJsonDir = path.resolve(fileURLToPath(import.meta.url), '../../package.json');
const VERSION = JSON.parse(fs.readFileSync(packageJsonDir, 'utf-8')).version;

const command = program
  .version(VERSION)
  .requiredOption('--stream-server-url <string>', 'ai stream proxy server url e.g. http://localhost:8888.')
  .requiredOption('--stream-id <string>', 'stream id for this claude execution.')
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
    } = options as {
      streamServerUrl: string;
      streamServerToken: string;
      streamId: string;
    };

    const cp = spawn('claude', ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose', ...unknown, ...operands], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const promises: Promise<void>[] = [];

    let result: SDKResultMessage | undefined;

    const headers: Record<string, string> = {
      'Content-Type': 'claude-code-stream-json+include-partial-messages',
    };

    if (streamServerToken) {
      headers['Authorization'] = `Bearer ${streamServerToken}`;
    }

    promises.push(fetch(streamServerUrl + `/v1/streams/${encodeURIComponent(streamId)}`, {
      method: 'POST',
      headers,
      duplex: 'half',
      body: Readable.toWeb(cp.stdout)
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new TransformStream<string, string>({
          transform (chunk, controller) {
            chunk.split('\n').forEach(line => {
              line = line.trim();

              if (line) {
                try {
                  const message: SDKMessage = JSON.parse(line);

                  if (message.type === 'result') {
                    result = message;
                  }

                  controller.enqueue(line + '\n');
                } catch {
                }
              }
            });
          },
        }))
        .pipeThrough(new TextEncoderStream()),
    }).then((res) => {
      if (!res.ok) {
        res.text()
          .then(text => {
            console.error('[ai-stream-proxy]', res.status, text);
          })
          .catch(() => {
            console.error('[ai-stream-proxy]', res.status, res.statusText);
          });
        process.exit(1);
      }
    }, (err) => console.error(err)));

    promises.push(
      Readable.toWeb(cp.stderr)
        .pipeThrough(new TextDecoderStream())
        .pipeTo(new WritableStream<string>({
          async write (chunk) {
            process.stderr.write(chunk);
          },
        })),
    );

    cp.on('exit', async (code, signal) => {
      if (code != null) {
        await Promise.all(promises).catch(e => {
          console.error(e);
          return Promise.reject(e);
        });
        if (result) {
          if (result.subtype === 'success') {
            if (result.is_error) {
              // Force exit with error
              console.error(result.result);
              process.exit(code || -1);
            } else {
              console.log(result.result);
            }
          } else {
            console.error(result.subtype);
          }
        }
        process.exit(code);
      } else {
        process.stderr.write(`${signal}\n`);
        process.exit(-1);
      }
    });
  });

command.parse();
