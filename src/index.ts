#!/usr/bin/env node

import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-code';
import { InvalidArgumentError, program } from 'commander';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { TextDecoderStream } from 'node:stream/web';

const command = program
  .requiredOption('--target-url <string>', 'ai stream proxy server url e.g. http://localhost:8888.')
  .requiredOption('--stream-id <string>', 'stream id for this claude execution.')
  .requiredOption('-p,--print', 'Required. See claude --help.')
  .requiredOption('--output-format <format>', 'Must be "stream-json". See claude --help.', value => {
    if (value !== 'stream-json') {
      throw new InvalidArgumentError('output format must be stream-json.');
    }
  })
  .requiredOption('--verbose', 'Required. See claude --help.')
  .allowUnknownOption()
  .allowExcessArguments()
  .action(async function (options) {
    const { operands, unknown } = this.parseOptions(process.argv.slice(2));

    const {
      targetUrl,
      streamId,
    } = options;

    const cp = spawn('claude', ['-p', '--output-format', 'stream-json', '--verbose', ...unknown, ...operands], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const promises: Promise<void>[] = [];

    let result: SDKResultMessage | undefined;

    console.log(targetUrl);

    promises.push(fetch(targetUrl + `/v1/streams/${encodeURIComponent(streamId)}`, {
      method: 'POST',
      duplex: 'half',
      body: Readable.toWeb(cp.stdout)
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new TransformStream<string, string>({
          transform (chunk, controller) {
            chunk.split('\n').forEach(line => {
              line = line.trim();

              if (line) {
                const message: SDKMessage = JSON.parse(line);

                if (message.type === 'result') {
                  result = message;
                }

                controller.enqueue(line);
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
              console.error(result.result);
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
