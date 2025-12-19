#!/usr/bin/env node

import { program } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BaseAgent } from './agents/base.js';
import { Claude } from './agents/claude.js';
import { Codex } from './agents/codex.js';
import { PantheonTdd } from './agents/pantheon-tdd.js';
import { PantheonAgent } from './agents/pantheon.js';
import { StreamClient } from './client.js';

const packageJsonDir = path.resolve(fileURLToPath(import.meta.url), '../../package.json');
const VERSION = JSON.parse(fs.readFileSync(packageJsonDir, 'utf-8')).version;

const command = program
  .version(VERSION)
  .argument('<agent>', '`claude` or `codex`')
  .requiredOption('--stream-server-url <string>', 'ai stream proxy server url e.g. http://localhost:8888.')
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
        process.stderr.write(`[code-tee ${Date.now()}  WARN]: pantheon-tdd is deprecated, use code-tee pantheon dev\n`);
        break;
      case 'pantheon': {
        const [subAgent, ...otherOperands] = restOperands;
        a = new PantheonAgent(PantheonAgent.determineSubAgent(subAgent), [...unknown, ...otherOperands]);
        contentType = 'pantheon-agent-stream-json';
        break;
      }

      default:
        process.stderr.write(`[code-tee ${Date.now()} ERROR]: invalid agent ${agent}\n`);
        process.exit(1);
    }

    a.execute(new StreamClient(streamServerUrl, streamServerToken, streamId, streamMessageId, contentType), { execPath });
  });

command.parse();
