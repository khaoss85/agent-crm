import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sslFromEndpoint } from '../packages/app/src/create-app-async.js';

/**
 * A managed database that issues a per-instance certificate names no host in
 * it. Hostname verification therefore cannot pass — and `servername` cannot
 * rescue it, because `pg` copies the caller's TLS options and then overwrites
 * `servername` with the host for any non-IP host. The seam existed and was
 * inert; these tests pin what replaced it.
 */

const FINGERPRINT = 'E5:FC:0C:9C:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC';
const SAME_BARE = FINGERPRINT.replace(/:/g, '').toLowerCase();
const OTHER = SAME_BARE.replace(/^e5/, 'a1');

function caFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'accordo-pinned-ca-'));
  const path = join(dir, 'ca.pem');
  writeFileSync(path, '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n');
  // The trusted reader refuses anything another user could write: the
  // requirement is integrity, not confidentiality — a certificate someone else
  // can replace is a pin that proves nothing.
  chmodSync(path, 0o600);
  return path;
}

function endpoint(t, tls) {
  return { host: 'dpg-instance-a', port: 5432, database: 'd', user: 'u', tls: { caFile: caFile(t), ...tls } };
}

test('without a pinned fingerprint nothing changes: hostname verification stands', (t) => {
  const ssl = sslFromEndpoint(endpoint(t, {}), '/');
  assert.equal(ssl.rejectUnauthorized, true);
  assert.equal(ssl.checkServerIdentity, undefined, 'no pin must mean no substitute check');
});

test('a pinned fingerprint accepts the certificate it names', (t) => {
  const ssl = sslFromEndpoint(endpoint(t, { pinnedCertificateSha256: FINGERPRINT }), '/');
  assert.equal(ssl.rejectUnauthorized, true, 'pinning must never relax the chain check');
  assert.equal(ssl.checkServerIdentity('any-host', { fingerprint256: FINGERPRINT }), undefined);
});

test('the two written forms of one fingerprint are the same fingerprint', (t) => {
  const ssl = sslFromEndpoint(endpoint(t, { pinnedCertificateSha256: SAME_BARE }), '/');
  assert.equal(ssl.checkServerIdentity('h', { fingerprint256: FINGERPRINT }), undefined,
    'colon-separated and bare hex must not disagree about the same certificate');
});

/** The refusal the whole seam exists for: a different certificate, same host. */
test('a certificate that is not the pinned one is refused', (t) => {
  const ssl = sslFromEndpoint(endpoint(t, { pinnedCertificateSha256: FINGERPRINT }), '/');
  const refusal = ssl.checkServerIdentity('dpg-instance-a', { fingerprint256: OTHER });
  assert.ok(refusal instanceof Error);
  assert.equal(refusal.code, 'DEPLOYMENT_STORAGE_TLS_REFUSED');
});

test('a peer that presents no readable fingerprint is refused, not accepted by omission', (t) => {
  const ssl = sslFromEndpoint(endpoint(t, { pinnedCertificateSha256: FINGERPRINT }), '/');
  for (const cert of [undefined, {}, { fingerprint256: null }, { fingerprint256: 'nope' }]) {
    assert.ok(ssl.checkServerIdentity('h', cert) instanceof Error,
      `a certificate of shape ${JSON.stringify(cert)} must be refused`);
  }
});

/**
 * The reason this is a fingerprint and not a `checkServerIdentity` hook: a hook
 * accepts `() => undefined`, which turns the one seam that exists into the hole
 * that disables verification. A fingerprint can only exchange which property is
 * proved, never whether one is.
 */
test('a malformed pin is refused at configuration, not silently ignored', (t) => {
  for (const bad of ['', 'not-hex', SAME_BARE.slice(0, 40), 42, null, () => undefined]) {
    assert.throws(
      () => sslFromEndpoint(endpoint(t, { pinnedCertificateSha256: bad }), '/'),
      (error) => error.code === 'DEPLOYMENT_STORAGE_TLS_REFUSED',
      `a pin of ${JSON.stringify(String(bad))} must be refused rather than ignored`,
    );
  }
});
