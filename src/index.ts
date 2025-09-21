#!/usr/bin/env node

import type { SDKResultMessage } from '@anthropic-ai/claude-code';
import { InvalidArgumentError, program } from 'commander';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';

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

    let result: SDKResultMessage | undefined;

    const headers: Record<string, string> = {
      'Content-Type': 'claude-code-stream-json+include-partial-messages',
    };

    if (streamServerToken) {
      headers['Authorization'] = `Bearer ${streamServerToken}`;
    }

    const request = http.request(`${streamServerUrl}/v1/streams/${encodeURIComponent(streamId)}`, {
      method: 'POST',
      headers,
      timeout: 0,
    });

    request.on('error', (err) => {
      process.stderr.write(`[claude-tee]: failed to send stream to server: ${inspect(err)}\n`);
    });

    request.on('response', response => {
      if (response.statusCode !== 200) {
        process.stderr.write(`[claude-tee]: failed to send stream to server\n`);
        process.stderr.write(`[claude-tee][resp]: ${response.statusCode} ${response.statusMessage}\n`);
        response
          .map((dat: Buffer) => {
            return '[claude-tee][resp]: ' + dat.toString('utf-8') + '\n';
          })
          .pipe(process.stderr, { end: false });
      }
    });

    cp.stdout.on('data', (data: Buffer) => {
      try {
        const chunk = JSON.parse(data.toString('utf-8'));
        if (chunk.type === 'result') {
          result = chunk;
        }
      } catch {
      }
    });

    cp.stdout.pipe(request, { end: false });
    cp.stderr.pipe(process.stderr, { end: false });

    cp
      .on('error', (err) => {
        request.destroy(err);
        process.stderr.write(`failed to spawn claude code: ${inspect(err)}\n`);
        process.exitCode = 1;
      })
      .on('close', async (code, signal) => {
        request.end();

        if (code != null) {
          if (result) {
            if (result.subtype === 'success') {
              if (result.is_error) {
                // Force exit with error
                process.stderr.write(result.result + '\n');
                process.exitCode = code;
              } else {
                process.stdout.write(result.result + '\n');
                process.exitCode = code;
              }
            } else {
              process.stderr.write(result.subtype + '\n');
              process.exitCode = code;
            }
          } else {
            process.stderr.write('claude code no result.\n');
            process.exitCode = code;
          }
        } else {
          process.stderr.write(`${signal}\n`);
          process.exitCode = -1;
        }
      });
  });

command.parse();
