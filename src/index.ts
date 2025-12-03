#!/usr/bin/env node

import { program } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BaseAgent } from './agents/base.js';
import { Claude } from './agents/claude.js';
import { Codex } from './agents/codex.js';
import { PantheonTdd } from './agents/pantheon-tdd.js';
import { AIStreamProxyClient } from './clients/ai-stream-proxy-client.js';
import type { ClientType } from './clients/types.js';
import { NoopClient } from './clients/noop-client.js';
import { VercelQueueClient } from './clients/vercel-queue-client.js';

const packageJsonDir = path.resolve(fileURLToPath(import.meta.url), '../../package.json');
const VERSION = JSON.parse(fs.readFileSync(packageJsonDir, 'utf-8')).version;

const command = program
  .version(VERSION)
  .argument('<agent>', '`claude` or `codex`')
  .requiredOption('--stream-server-url <string>', 'ai stream proxy server url e.g. http://localhost:8888. For vercel queues, use vercel-queue-beta:{topic-prefix}')
  .requiredOption('--stream-id <string>', 'stream id for this agent execution.')
  .option('--stream-message-id <string>', 'message id for this agent execution. Default to stream-id.')
  .option('--stream-protocol <string>', 'v2', 'v2')
  .option('--stream-server-token <string>', 'auth token')
  .option('--exec-path <string>', 'path to agent executable. Default to standard agent name in PATH.')
  .allowUnknownOption()
  .allowExcessArguments()
  .action(async function (action, options) {
    process.stderr.write(`[code-tee ${Date.now()}  INFO]: ${VERSION}\n`);
    const { operands, unknown } = this.parseOptions(process.argv.slice(2));

    const {
      streamServerUrl,
      streamServerToken,
      streamId,
      streamMessageId,
      execPath,
    } = options as {
      streamServerUrl: string;
      streamServerToken: string;
      streamId: string;
      streamMessageId?: string;
      execPath?: string;
    };

    const [agent, ...restOperands] = operands;

    let a: BaseAgent;
    let contentType: string;

    switch (agent) {
      case 'claude':
        a = new Claude([...unknown, ...restOperands]);
        contentType = 'claude-code-stream-json+include-partial-messages';
        break;
      case 'codex':
        a = new Codex([...unknown, ...restOperands]);
        contentType = 'codex-stream-json';
        break;
      case 'pantheon-tdd':
        a = new PantheonTdd([...unknown, ...restOperands]);
        contentType = 'pantheon-tdd-stream-json';
        break;
      default:
        process.stderr.write(`[code-tee ${Date.now()} ERROR]: invalid agent ${agent}\n`);
        process.exit(1);
    }

    let client: ClientType;

    if (/^https?:\/\//.test(streamServerUrl)) {
      client = new AIStreamProxyClient(streamServerUrl, streamServerToken, streamId, streamMessageId, contentType);
    } else if (streamServerUrl.startsWith('vercel-queue-beta:')) {
      client = new VercelQueueClient(streamServerUrl, streamServerToken, streamId, streamMessageId, contentType)
    } else {
      process.stderr.write(`[code-tee ${Date.now()} ERROR]: invalid stream server url ${streamServerUrl}, stream will not be send to any server.\n`);
      client = new NoopClient();
    }

    a.execute(client, { execPath });
  });

command.parse();
