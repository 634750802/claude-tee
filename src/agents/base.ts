import cp from 'node:child_process';
import { inspect } from 'node:util';
import type { StreamClient } from '../client.js';
import { log } from '../log.js';

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

  execute (client: StreamClient, { execPath }: { execPath?: string }) {
    const child_process = cp.spawn(execPath ?? this.exec, this.args, {
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

    child_process.stderr.pipe(process.stderr, { end: false });

    child_process
      .on('error', async (err) => {
        log('ERROR', `failed to spawn claude code: ${inspect(err)}`)
        client.stop(true, `spawn error: ${err.message}`);
        process.exit(1);
      })
      .on('close', (code, signal) => {
        if (code != null) {
          this.handleClose(code);
          if (code === 0) {
            log('INFO', `${this.exec} close with code ${code}`)
          } else {
            log('ERROR', `${this.exec} close with code ${code}`)
          }
          process.exitCode = code;
        } else {
          log('ERROR', `${this.exec} close with signal: ${signal}`)
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

