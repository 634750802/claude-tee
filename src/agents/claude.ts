import type { SDKResultMessage } from '@anthropic-ai/claude-code';
import { BaseAgent } from './base.js';

export class Claude extends BaseAgent {
  constructor (args: string[]) {
    super('claude', ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose', ...args]);
  }

  result: SDKResultMessage | undefined;

  handleLine (line: string) {
    try {
      const chunk = JSON.parse(line);
      if (chunk.type === 'result') {
        this.result = chunk;
      }
    } catch {
    }
  }

  handleClose (code: number) {
    const result = this.result;
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
  }
}