import type { StreamItem, ThreadCompleted } from 'pantheon-tdd-sdk/stream-items';
import { BaseAgent } from './base.js';

export class PantheonTdd extends BaseAgent {
  final_item: ThreadCompleted | undefined;

  constructor (args: string[]) {
    super('dev-agent', ['--headless', '--stream-json', ...args]);
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
}