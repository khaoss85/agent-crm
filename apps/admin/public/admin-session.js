// @ts-check

// BO-F6-03 — Session identity contract between an embedding host (the shared
// pilot web) and the Admin shell (backlog:5feaea014dca).
//
// Until this story the shell rendered a fixed development identity
// ("Operatore locale / sviluppo locale", "Spazio locale") even in a shared
// deployment, where the person arrived with a real session. The host now
// injects the verified session profile as JSON in the served HTML:
//
//   <script id="bo-session" type="application/json">{"space":{...},...}</script>
//
// and the shell reads it here. The contract, kept deliberately narrow:
//
// - **Shape.** `{ space: { id, name }, role, name, email, logoutUrl }` —
//   every string trimmed and non-empty; `role` is one of
//   `owner | operator | observer`; `logoutUrl` is a same-origin absolute
//   path (the space login the host owns, e.g. `/w/<id>/auth/logout`).
//   Anything else — missing script, malformed JSON, a wrong shape, a
//   foreign logout URL — reads as no session, never as a half identity.
// - **No client names.** The values travel per request from the host that
//   verified the session; nothing here names a customer, a tenant or a
//   deployment (agent-crm is public).
// - **Local parity.** Without the script (the standalone server injects
//   nothing: local development has no verifier) the shell keeps the
//   development identity it always had — `DEV_USER` below — so criterion 3
//   holds by construction, not by a flag somebody must remember.
// - **Text, never markup.** Values are inert strings; renderers insert them
//   with textContent (see admin-shell.js), and the mount serializes the
//   script with `<` escaped, so a hostile value cannot close the tag.

/** DOM id of the injected session-profile script. */
export const BO_SESSION_SCRIPT_ID = 'bo-session';

/**
 * Development identity: local only, until a deployment injects a session
 * profile (criterion 3). The same name greets in the shell and in Oggi.
 */
export const DEV_USER = Object.freeze({ name: 'Operatore locale', email: 'sviluppo locale' });

const KNOWN_ROLES = Object.freeze(['owner', 'operator', 'observer']);

/** Italian labels for the workspace roles, in prototype order. */
const ROLE_LABELS = Object.freeze({
  owner: 'Titolare',
  operator: 'Operatore',
  observer: 'Osservatore',
});

/**
 * @param {unknown} role
 */
export function sessionRoleLabel(role) {
  if (typeof role !== 'string') return '';
  return ROLE_LABELS[/** @type {keyof typeof ROLE_LABELS} */ (role)] ?? '';
}

/**
 * @param {unknown} value
 */
function cleanText(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed === '' ? '' : trimmed;
}

/**
 * @param {unknown} value
 */
function cleanLogoutUrl(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  // Same-origin absolute path only: no scheme, no protocol-relative URL, no
  // whitespace or markup that could smuggle a target out of the host.
  if (!/^\/[^/]/.test(trimmed) || /[\s\\<>"']/.test(trimmed)) return '';
  return trimmed;
}

/**
 * Validate and normalize an injected session profile. Unknown extra keys are
 * ignored; an unknown role hides the role line instead of sinking the
 * session (space, name and email still show, never the development
 * identity); a foreign logout URL is dropped, never followed.
 * @param {unknown} jsonText
 */
export function parseSessionProfile(jsonText) {
  if (typeof jsonText !== 'string' || jsonText.trim() === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const space = /** @type {any} */ (parsed).space;
  const spaceId = space !== null && typeof space === 'object' ? cleanText(space.id) : '';
  const spaceName = space !== null && typeof space === 'object' ? cleanText(space.name) : '';
  const roleRaw = cleanText(/** @type {any} */ (parsed).role);
  const name = cleanText(/** @type {any} */ (parsed).name);
  const email = cleanText(/** @type {any} */ (parsed).email);
  if (spaceId === '' || spaceName === '' || name === '' || email === '') return null;
  return Object.freeze({
    space: Object.freeze({
      id: spaceId,
      name: spaceName,
      initials: spaceName.slice(0, 2).toUpperCase(),
    }),
    role: KNOWN_ROLES.includes(roleRaw) ? roleRaw : null,
    name,
    email,
    logoutUrl: (() => {
      const url = cleanLogoutUrl(/** @type {any} */ (parsed).logoutUrl);
      return url === '' ? null : url;
    })(),
  });
}

/**
 * Read the injected session profile from the served document. Absent without
 * a verifier (local development): the caller keeps the development identity.
 * @param {{ querySelector?: Function } | undefined} [doc]
 */
export function readSessionProfile(doc) {
  try {
    const source = doc
      ?? (typeof globalThis.document === 'undefined' ? undefined : globalThis.document);
    const script = source?.querySelector?.('script[id="bo-session"]');
    if (!script || typeof script.textContent !== 'string') return null;
    return parseSessionProfile(script.textContent);
  } catch {
    return null;
  }
}

/**
 * Where Esci goes: the space login the host named for a real session, or
 * null for the local reset (no session, no verifier). A session without a
 * usable logout URL keeps the local behavior rather than guessing a route
 * the host does not own.
 * @param {{ profile?: unknown }} [input]
 */
export function resolveLogoutTarget({ profile } = {}) {
  if (profile === null || typeof profile !== 'object') return null;
  const url = cleanLogoutUrl(/** @type {any} */ (profile).logoutUrl);
  return url === '' ? null : url;
}
