import type { AgentMessageItem, ThreadEvent, TurnFailedEvent } from '@openai/codex-sdk';
import { BaseAgent } from './base.js';

export class Codex extends BaseAgent {
  final_message: AgentMessageItem | undefined;
  final_turn_failed: TurnFailedEvent | undefined;

  constructor (args: string[]) {
    super('codex', ['exec', '--json', ...args]);
  }

  handleLine (line: string) {
    try {
      const chunk: ThreadEvent = JSON.parse(line);
      if (chunk.type === 'item.completed') {
        if (chunk.item.type === 'agent_message') {
          this.final_message = chunk.item;
        }
      }
      if (chunk.type === 'turn.failed') {
        this.final_turn_failed = chunk;
      }
    } catch {
    }
  }

  handleClose (code: number) {
    if (code === 0) {
      if (this.final_message) {
        process.stdout.write(this.final_message.text + '\n');
      } else {
        process.stdout.write('No final message.\n');
      }
    } else {
      if (this.final_turn_failed) {
        process.stderr.write(this.final_turn_failed.error.message + '\n');
      } else {
        process.stderr.write(`codex exit (${code}) with no error result.\n`);
      }
    }
  }
}