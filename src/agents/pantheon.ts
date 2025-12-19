import type { StreamItem, ThreadCompleted } from 'pantheon-tdd-sdk/stream-items';
import { BaseAgent } from './base.js';

export type PantheonAgentName = 'dev' | 'review';

export class PantheonAgent extends BaseAgent {
  final_item: ThreadCompleted | undefined;

  constructor (subAgent: string, args: string[]) {
    super(subAgent, ['--headless', '--stream-json', ...args]);
  }

  handleLine (line: string) {
    try {
      const chunk: StreamItem = JSON.parse(line);
      if (chunk.type === 'thread.completed') {
        this.final_item = chunk;
      }
    } catch {
    }
  }

  handleClose (code: number) {
    if (code === 0) {
      if (this.final_item) {
        if (this.final_item.status === 'error') {
          process.stderr.write(this.final_item.summary);
          process.exitCode = 1;
        } else {
          process.stdout.write(JSON.stringify(this.final_item.final_report, undefined, 2) + '\n');
        }
      } else {
        process.stdout.write('No final item.\n');
      }
    } else {
      process.stderr.write(`tdd exit (${code}).\n`);
    }
  }

  static determineSubAgent (name: string) {
    switch (name) {
      case 'dev':
      case 'tdd':
      case 'pantheon-tdd':
      case 'dev-agent':
        return 'dev-agent';
      case 'review':
      case 'pantheon-review':
      case 'review-agent':
        return 'review';
      default:
        throw new Error(`Invalid pantheon agent ${name}`);
    }
  }
}