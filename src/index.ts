#!/usr/bin/env node

import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-code';
import { InvalidArgumentError, program } from 'commander';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { TextDecoderStream } from 'node:stream/web';
import { createClient } from 'redis';

const command = program
  .requiredOption('--redis-url <string>', 'Redis URL.')
  .requiredOption('--redis-stream-prefix <string>', 'Redis stream prefix.')
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
      redisUrl,
      redisStreamPrefix,
    } = options;

    const redis = createClient({
      url: options.redisUrl,
    });

    await redis.connect();

    const cp = spawn('claude', ['-p', '--output-format', 'stream-json', '--verbose', ...unknown, ...operands], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let i = 0;

    const promises: Promise<void>[] = [];

    let result: SDKResultMessage | undefined;

    promises.push(
      Readable.toWeb(cp.stdout)
        .pipeThrough(new TextDecoderStream())
        .pipeTo(new WritableStream<string>({
          async write (chunk) {
            const index = i;
            i++;

            const message: SDKMessage = JSON.parse(chunk);

            if (message.type === 'result') {
              result = message;
            }

            await redis.rPush(`${redisStreamPrefix}:list`, chunk);
            await redis.publish(`${redisStreamPrefix}:channel`, JSON.stringify({ type: 'delta', index: index.toString() }));
          },
          async close () {
            await redis.publish(`${redisStreamPrefix}:signal`, JSON.stringify({ type: 'done' }));
          },
          async abort () {
            await redis.publish(`${redisStreamPrefix}:signal`, JSON.stringify({ type: 'cancel' }));
          },
        })),
    );

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
        await Promise.all(promises);
        await redis.close();
        let reason: string;
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
