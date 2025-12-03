export interface ClientType {
  put (data: Buffer): void;

  stop (abort: boolean, reason: string): void

  wait (): Promise<void>
}