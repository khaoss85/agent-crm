// @ts-check
/**
 * Lost session under a mount (backlog:b059cdd714ce).
 *
 * A cached /bo page can outlive its space session: the next API read then
 * fails — 401/403 with a session code, or the host's login redirect followed
 * by fetch (a 200 that is not JSON). The shell must land the browser on the
 * space login, never render the development identity («Spazio locale» /
 * «Operatore locale») with «non composto» states. Standalone keeps the
 * local behavior: there is no login to land on.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSessionLostCode,
  spaceLoginUrl,
  sessionLostTarget,
} from '../apps/admin/public/admin-session.js';

test('session-shaped codes send the shell to the login', () => {
  for (const code of [
    'SESSION_EXPIRED',
    'SESSION_REVOKED',
    'SESSION_MALFORMED',
    'SESSION_SIGNATURE_INVALID',
    'SHARED_SESSION_REQUIRED',
    'SHARED_MEMBERSHIP_REFUSED',
    'SHARED_SESSION_SCOPE_REFUSED',
    'WORKSPACE_MEMBER_REQUIRED',
    'WORKSPACE_SESSION_REQUIRED',
    'WORKSPACE_SESSION_REFUSED',
  ]) {
    assert.equal(isSessionLostCode(code), true, code);
    assert.equal(
      sessionLostTarget({ status: 403, code, adminBase: '/w/abc/bo' }),
      '/w/abc/',
      code,
    );
  }
  assert.equal(sessionLostTarget({ status: 401, code: 'WHATEVER', adminBase: '/w/abc/bo' }), '/w/abc/');
});

test('anything else keeps the current behavior: no navigation', () => {
  // A failure the login cannot cure must not bounce the shell into a login
  // loop — signing in again would return to the same refusal.
  for (const code of ['UNKNOWN', 'NOT_FOUND', 'FORBIDDEN', 'RECORD_FAILED', '', null, undefined, 42]) {
    assert.equal(isSessionLostCode(code), false, String(code));
  }
  assert.equal(sessionLostTarget({ status: 403, code: 'UNKNOWN', adminBase: '/w/abc/bo' }), null);
  assert.equal(sessionLostTarget({ status: 500, code: 'SESSION_EXPIRED', adminBase: '/w/abc/bo' }), null);
  assert.equal(sessionLostTarget({ status: 200, adminBase: '/w/abc/bo' }), null);
  assert.equal(sessionLostTarget({}), null);
});

test('a followed redirect or a non-JSON 200 counts as a lost session', () => {
  assert.equal(sessionLostTarget({ redirected: true, adminBase: '/w/abc/bo' }), '/w/abc/');
  assert.equal(sessionLostTarget({ invalidResponse: true, adminBase: '/w/abc/bo' }), '/w/abc/');
  assert.equal(sessionLostTarget({ redirected: false, adminBase: '/w/abc/bo' }), null);
});

test('the space login is the space root, one segment above the mount', () => {
  assert.equal(spaceLoginUrl('/w/f201c1d2-a127-429a-8f3d-5b1d78d402cf/bo'), '/w/f201c1d2-a127-429a-8f3d-5b1d78d402cf/');
  assert.equal(spaceLoginUrl('/w/abc/bo'), '/w/abc/');
  // Standalone, an unknown base or a hostile one: no guessed route.
  assert.equal(spaceLoginUrl(''), null);
  assert.equal(spaceLoginUrl('/'), null);
  assert.equal(spaceLoginUrl('/bo'), null);
  assert.equal(spaceLoginUrl('/w/abc'), null);
  assert.equal(spaceLoginUrl('/w/abc/bo/'), null);
  assert.equal(spaceLoginUrl('/w/abc/other'), null);
  assert.equal(spaceLoginUrl('/w/../x/bo'), null);
  assert.equal(spaceLoginUrl('/w/abc/bo?x=1'), null);
  assert.equal(spaceLoginUrl(null), null);
  assert.equal(spaceLoginUrl(undefined), null);
});

test('without a derivable login there is no navigation, even when lost', () => {
  assert.equal(sessionLostTarget({ status: 401, adminBase: '' }), null);
  assert.equal(sessionLostTarget({ redirected: true, adminBase: '' }), null);
  assert.equal(sessionLostTarget({ invalidResponse: true }), null);
});
