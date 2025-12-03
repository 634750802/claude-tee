import type { ClientType } from './types.js';

export class NoopClient implements ClientType {

  constructor () {}

  put (data: Buffer): void {
  }

  stop (abort: boolean, reason: string): void {
  }

  async wait (): Promise<void> {
  }
}
