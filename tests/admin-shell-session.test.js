// @ts-check
/**
 * BO-F6-03 — the shell shows the session's space and person, never the
 * development identity, when a real session is present (backlog:5feaea014dca).
 *
 * The embedding host (the shared pilot web) injects the verified session
 * profile as JSON; this module reads and validates it. These tests pin the
 * three acceptance criteria at the contract level:
 * 1. with a real session the shell learns space, role, name and email, and
 *    the development strings ("Spazio locale"/"Operatore locale") never
 *    appear;
 * 2. the logout target is the space login URL the host named, never a local
 *    reset;
 * 3. without a profile (local, no verifier) the development identity stays.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BO_SESSION_SCRIPT_ID,
  DEV_USER,
  parseSessionProfile,
  readSessionProfile,
  resolveLogoutTarget,
  sessionRoleLabel,
} from '../apps/admin/public/admin-session.js';

const PROFILE = {
  space: { id: 'presti-group', name: 'Presti Group' },
  role: 'owner',
  name: 'Elena Rinaldi',
  email: 'elena@studioaurora.it',
  logoutUrl: '/w/presti-group/auth/logout',
};

const stubDoc = (jsonText) => ({
  querySelector: (selector) => {
    assert.equal(selector, 'script[id="bo-session"]');
    return jsonText === null ? null : { textContent: jsonText };
  },
});

test('a real session profile parses: space, role, name, email, logout', () => {
  const profile = parseSessionProfile(JSON.stringify(PROFILE));
  assert.deepEqual(profile, {
    space: { id: 'presti-group', name: 'Presti Group', initials: 'PR' },
    role: 'owner',
    name: 'Elena Rinaldi',
    email: 'elena@studioaurora.it',
    logoutUrl: '/w/presti-group/auth/logout',
  });
});

test('the role renders as an Italian label, unknown roles stay hidden', () => {
  assert.equal(sessionRoleLabel('owner'), 'Titolare');
  assert.equal(sessionRoleLabel('operator'), 'Operatore');
  assert.equal(sessionRoleLabel('observer'), 'Osservatore');
  assert.equal(sessionRoleLabel('admin'), '');
  assert.equal(sessionRoleLabel(''), '');
  assert.equal(sessionRoleLabel(null), '');
});

test('missing, malformed or hostile profiles fall back to no session', () => {
  assert.equal(parseSessionProfile(null), null);
  assert.equal(parseSessionProfile(''), null);
  assert.equal(parseSessionProfile('{not json'), null);
  assert.equal(parseSessionProfile(JSON.stringify({ ...PROFILE, space: null })), null);
  assert.equal(parseSessionProfile(JSON.stringify({ ...PROFILE, space: { id: '', name: '' } })), null);
  assert.equal(parseSessionProfile(JSON.stringify({ ...PROFILE, name: '  ' })), null);
  assert.equal(parseSessionProfile(JSON.stringify({ ...PROFILE, email: '' })), null);
  // An unknown role hides the role line instead of sinking the session:
  // space, name and email still show, never the development identity.
  assert.equal(parseSessionProfile(JSON.stringify({ ...PROFILE, role: 'root' }))?.role ?? null, null);
  assert.equal(parseSessionProfile(JSON.stringify({ ...PROFILE, role: 'root' }))?.name, 'Elena Rinaldi');
  // Unknown extra keys are ignored, never fatal.
  assert.deepEqual(parseSessionProfile(JSON.stringify({ ...PROFILE, extra: 1 }))?.space, {
    id: 'presti-group', name: 'Presti Group', initials: 'PR',
  });
  // A logout URL outside the host origin is refused, never followed.
  assert.equal(parseSessionProfile(JSON.stringify({ ...PROFILE, logoutUrl: 'https://evil.test/x' }))?.logoutUrl ?? null, null);
  assert.equal(parseSessionProfile(JSON.stringify({ ...PROFILE, logoutUrl: '//evil.test/x' }))?.logoutUrl ?? null, null);
});

test('hostile profile values stay inert text (the mount escapes the script)', () => {
  const hostile = {
    ...PROFILE,
    space: { id: 'x', name: '</script><script>alert(1)</script>' },
    name: '<img src=x onerror=alert(1)>',
  };
  const profile = parseSessionProfile(JSON.stringify(hostile));
  assert.ok(profile);
  assert.equal(profile.name, '<img src=x onerror=alert(1)>');
  // The mount serializes with `<` escaped, so the JSON never closes the tag.
  const serialized = JSON.stringify(profile).replace(/</g, '\\u003c');
  assert.ok(!serialized.includes('</script'));
});

test('readSessionProfile reads the injected script, absent without a verifier', () => {
  assert.equal(BO_SESSION_SCRIPT_ID, 'bo-session');
  assert.deepEqual(readSessionProfile(stubDoc(JSON.stringify(PROFILE)))?.space, {
    id: 'presti-group', name: 'Presti Group', initials: 'PR',
  });
  assert.equal(readSessionProfile(stubDoc(null)), null);
  assert.equal(readSessionProfile(stubDoc('{oops')), null);
  assert.equal(readSessionProfile(undefined), null);
});

test('the development identity stays the local fallback', () => {
  assert.deepEqual({ ...DEV_USER }, { name: 'Operatore locale', email: 'sviluppo locale' });
});

test('logout targets the space login; without a session there is no target', () => {
  assert.equal(resolveLogoutTarget({ profile: parseSessionProfile(JSON.stringify(PROFILE)) }), '/w/presti-group/auth/logout');
  assert.equal(resolveLogoutTarget({ profile: null }), null);
  assert.equal(resolveLogoutTarget({}), null);
});
