// @ts-check

/**
 * One share-link mint in its own OS process (backlog:a3b394dd, P1 giro 6).
 *
 * The parent test spawns two of these at once against the same PostgreSQL
 * data plane but with a DIFFERENT control database each: the writer lease
 * lives in the control plane (one writer per tenant), so two full writers
 * cannot share it — exactly like web and worker in production. The mint
 * gate under test (same-row fence + SERIALIZABLE + runtime retry) lives on
 * the data plane, which both workers share, so the race is real while each
 * process keeps its own in-process mint lock.
 *
 * Each worker boots, prints READY, waits for the parent's gate file, then
 * mints: the gate makes both transactions overlap instead of serializing
 * on boot skew. Prints exactly one `SHARE_MINT_RESULT {...}` line and exits.
 *
 * argv[2]: JSON { control, data, tenantId, quoteId, gateFile }.
 */

import { existsSync } from 'node:fs';
import { bootStubShareApp } from './quote-share-mint-app.mjs';

const params = JSON.parse(process.argv[2] ?? '{}');

/** Wait for the parent's release file; boot skew must not serialize the mints. */
async function awaitGate(path, timeoutMs = 60_000) {
  const started = Date.now();
  for (;;) {
    if (path && existsSync(path)) return;
    if (Date.now() - started > timeoutMs) throw new Error('mint gate file never appeared');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const app = await bootStubShareApp({
  control: params.control,
  data: params.data,
  tenantId: params.tenantId ?? 'acme',
});
process.stdout.write('READY\n');
try {
  await awaitGate(params.gateFile);
  const ran = await app.runAction({
    module: 'quote',
    action: 'share-link',
    recordId: params.quoteId,
    input: {},
    actor: { type: 'user', id: 'mint-race' },
  });
  console.log(`SHARE_MINT_RESULT ${JSON.stringify({
    ok: true,
    alreadyExisted: ran.result.alreadyExisted,
    hasToken: ran.result.token !== null && ran.result.token !== undefined,
  })}`);
} catch (error) {
  console.log(`SHARE_MINT_RESULT ${JSON.stringify({
    ok: false,
    code: error?.code ?? null,
    message: String(error?.message ?? error).slice(0, 200),
  })}`);
} finally {
  await app.close();
}
