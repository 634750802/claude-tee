import cp from 'node:child_process';
import { inspect } from 'node:util';
import type { StreamClient } from '../client.js';

export abstract class BaseAgent {
  private readonly exec: string;
  private readonly args: string[];

  protected constructor (
    exec: string,
    args: string[],
  ) {
    this.exec = exec;
    this.args = args;
  }

  abstract handleLine (line: string): void

  abstract handleClose (code: number): void

  execute (client: StreamClient) {
    const child_process = cp.spawn(this.exec, this.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child_process.stdout
      .on('data', (data: Buffer) => {
        client.put(data);
        const output = data.toString('utf-8');
        output.split('\n').forEach(line => {
          if (line.trim()) {
            this.handleLine(line);
          }
        });
      })
      .on('end', () => {
        client.stop(false, 'stdout end');
      })
      .on('error', (err) => {
        client.stop(true, `stdout error: ${err.message}`);
      });

    child_process
      .on('error', async (err) => {
        process.stderr.write(`[code-tee ${Date.now()} ERROR]: failed to spawn claude code: ${inspect(err)}\n`);
        client.stop(true, `spawn error: ${err.message}`);
        process.exit(1);
      })
      .on('close', (code, signal) => {
        process.stderr.write(`[code-tee ${Date.now()}  INFO]: claude code close with code ${code}\n`);
        if (code != null) {
          this.handleClose(code);
          process.exitCode = code;
        } else {
          process.stderr.write(`${signal}\n`);
          process.exitCode = -1;
        }
        client.wait()
          .finally(() => {
            process.exit();
          });
      });

    return child_process;
  }
}

