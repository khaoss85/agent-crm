// @ts-check

/**
 * One share-link mint in its own OS process (backlog:a3b394dd, P1 giro 6).
 *
 * The parent test spawns two of these at once against the same PostgreSQL
 * planes: each process has its own in-process mint lock, so only the
 * database gate can serialize them. Prints exactly one marked line and exits:
 * `SHARE_MINT_RESULT {...}`.
 *
 * argv[2]: JSON { control, data, tenantId, quoteId }.
 */

import { bootStubShareApp } from './quote-share-mint-app.mjs';

const params = JSON.parse(process.argv[2] ?? '{}');
const app = await bootStubShareApp({
  control: params.control,
  data: params.data,
  tenantId: params.tenantId ?? 'acme',
});
try {
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
