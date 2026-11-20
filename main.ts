// Entry lifecycle: bind an ephemeral port, register it with the trial env,
// then poll until the env reports the trial is done. The graded code lives
// in app.ts; this file only wires the server to the harness.

import { createApp } from './app.ts';

const ENV_ORIGIN = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_ORIGIN === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

const REQUEST_BUDGET_MS = 30_000;
const BACKOFF_START_MS = 250;
const BACKOFF_CEILING_MS = 2_000;
const BACKOFF_MAX_DOUBLINGS = 8;

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Backoff after `failures` failed attempts: doubles from the start, capped. */
function backoffMs(failures: number): number {
  const doublings = Math.min(failures, BACKOFF_MAX_DOUBLINGS);
  return Math.min(BACKOFF_CEILING_MS, BACKOFF_START_MS * 2 ** doublings);
}

type RegisterOutcome = 'registered' | 'retry';

async function tryRegister(port: number): Promise<RegisterOutcome> {
  try {
    const response = await fetch(`${ENV_ORIGIN}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
      signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
    });
    if (response.status === 200 || response.status === 409) return 'registered';
    if (response.status === 400 || response.status === 405) {
      throw new Error(`register answered HTTP ${response.status}: ${await response.text()}`);
    }
    return 'retry';
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('register answered HTTP ')) throw error;
    return 'retry';
  }
}

/** POST the bound port until the env accepts it; 409 means a first register already won. */
async function register(port: number): Promise<void> {
  let failures = 0;
  while ((await tryRegister(port)) !== 'registered') {
    await pause(backoffMs(failures));
    failures += 1;
  }
}

async function pollDoneOnce(): Promise<boolean> {
  try {
    const response = await fetch(`${ENV_ORIGIN}/done`, {
      signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { done?: unknown };
    return body.done === true;
  } catch {
    return false;
  }
}

/** Poll GET /done until it answers {"done":true}; never return before that. */
async function waitForDone(): Promise<void> {
  let failures = 0;
  while (!(await pollDoneOnce())) {
    await pause(backoffMs(failures));
    failures += 1;
  }
}

/** Bind the port, register it, then wait for the env: the whole life of the process. */
async function main(): Promise<void> {
  const server = createApp();
  const bound = new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  await bound;
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);
  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');
  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
