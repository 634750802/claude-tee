export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

let silentMode = false;

export function setSilent (silent: boolean) {
  silentMode = true;
}

export function log (level: LogLevel, str: string) {
  if (silentMode) {
    if (level === 'INFO' || level === 'WARN') {
      return;
    }
  }
  process.stderr.write(`[code-tee ${Date.now()} ${level.padStart(5, ' ')}]: ${str}\n`);
}