import { inspect } from 'node:util';

export async function retryIfFailed (action: string, cb: () => Promise<void>, times: number = 3) {
  let attempt = 0;

  for (let i = 0; i < times; i++) {
    try {
      await cb();
      return;
    } catch (e) {
      attempt++;
      if (attempt < times) {
        process.stderr.write(`[code-tee ${Date.now()}  INFO]: failed to ${action}, retrying after 1 second... (${attempt}/${times}) ${inspect(e)}\n`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else {
        process.stderr.write(`[code-tee ${Date.now()}  INFO]: failed to ${action}, giving up. (${attempt}/${times})\n`);
        throw e;
      }
    }
  }
}
