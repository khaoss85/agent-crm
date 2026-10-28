// @ts-check
/**
 * BO-F6-06 — login form behavior (backlog:27a0b924a3a6).
 *
 * Progressive enhancement over the plain POST form in `login.html`: the page
 * works without JavaScript (native submit to the deployment-owned
 * `POST /api/auth/magic-link/request`), and with JavaScript the same request
 * goes through `fetch` so the page can show the Italian loading / sent /
 * error states from the spec without ever navigating away.
 *
 * Boundaries (see specs/login.arch.md, "Cosa NON fare"):
 * - no Google machinery here: the "Continua con Google" entry stays a plain
 *   link to the deployment's `/auth/google` (pinned by
 *   tests/admin-login.test.js);
 * - no transport, no SMTP, no secret: the request is a JSON `POST {email}`
 *   to the form's own action; the deployment answers 2xx when the link mail
 *   was accepted, anything else on failure;
 * - no reason codes, no English internals, no stack: every user-visible
 *   string comes from `LOGIN_COPY` below, never from a response body.
 */

/** Every string the login form can show. Italian only, no codes. */
export const LOGIN_COPY = Object.freeze({
  emptyEmail: 'Inserisci il tuo indirizzo email di lavoro.',
  invalidEmail: 'Questo indirizzo non sembra valido. Controlla e riprova.',
  sending: 'Invio in corso…',
  sentTitle: 'Ti abbiamo inviato il link.',
  sentBody: 'Controlla la tua email: il link resta valido 10 minuti.',
  failed: 'Qualcosa non ha funzionato. Riprova tra poco.',
});

/** Same bounds as `normalizeLoginEmail` in packages/magic-link/src/rules.js. */
export const LOGIN_EMAIL_MAX = 200;

const EMAIL_SHAPE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Client-side send gate: mirror the server normalization bounds (trimmed,
 * 1-200 characters, one @ with a dotted domain) so obvious junk never
 * leaves the page. The server still normalizes and refuses authoritatively.
 *
 * @param {unknown} value
 */
export function isSendableLoginEmail(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > LOGIN_EMAIL_MAX) return false;
  return EMAIL_SHAPE_RE.test(trimmed);
}

/**
 * POST one magic-link request. Resolves true on any 2xx, false on any
 * failure (non-2xx, network error, timeout): the caller shows the fixed
 * Italian copy either way, so response bodies are never read and nothing
 * technical can leak into the page.
 *
 * @param {string} url the form action (deployment-owned route)
 * @param {string} email the trimmed address the visitor typed
 * @param {(url: string, init: Record<string, unknown>) => Promise<{ ok: boolean }>} fetchImpl
 * @param {{ timeoutMs?: number }} [options]
 */
export async function postMagicLinkRequest(url, email, fetchImpl, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000;
  // The timeout races: aborting alone would not settle a call that
  // ignores the signal, and the page must never hang on a dead send.
  let controller = null;
  if (typeof AbortController !== 'undefined') {
    try {
      controller = new AbortController();
    } catch {
      controller = null;
    }
  }
  let timer = null;
  const timeout =
    timeoutMs > 0 && typeof setTimeout === 'function'
      ? new Promise((resolve) => {
          timer = setTimeout(() => {
            if (controller) controller.abort();
            resolve(false);
          }, timeoutMs);
        })
      : null;
  try {
    const attempt = fetchImpl(String(url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ email: String(email) }),
      ...(controller ? { signal: controller.signal } : {}),
    });
    const response = timeout ? await Promise.race([attempt, timeout]) : await attempt;
    return !!(response && response.ok);
  } catch {
    return false;
  } finally {
    if (timer && typeof clearTimeout === 'function') clearTimeout(timer);
  }
}

/**
 * Wire the static login form. All nodes are passed in so the logic stays
 * testable without a browser; the inline module in `login.html` does the
 * trivial `querySelector` lookups.
 *
 * @param {{
 *   doc: { createElement: (tag: string) => any },
 *   form: any,
 *   email: any,
 *   submit: any,
 *   google: any,
 *   request: (email: string) => Promise<boolean>,
 * }} nodes
 */
export function createLoginForm(nodes) {
  const { doc, form, email, submit, google, request } = nodes;
  // Missing hooks: leave the native POST alone. The markup test pins the
  // hooks, so drift fails there instead of dying inside a submit.
  const noop = async () => {};
  if (!doc || !form || !email || !submit || typeof request !== 'function') return { onSubmit: noop };
  // The custom handler owns validation from here on: native constraint
  // validation would stop the submit event and show the browser bubble
  // instead of the Italian inline guidance. Without JavaScript this line
  // never runs, so `required` + `type="email"` still guard the plain POST.
  form.noValidate = true;
  let busy = false;
  let statusNode = null;
  const idleLabel = String(submit.textContent ?? '');

  const clearStatus = () => {
    if (statusNode && statusNode.parentNode === form && typeof form.removeChild === 'function') {
      form.removeChild(statusNode);
    }
    statusNode = null;
  };

  /**
   * @param {'error' | 'status'} kind
   * @param {string} text
   */
  const showStatus = (kind, text) => {
    clearStatus();
    const node = doc.createElement('p');
    node.setAttribute('class', kind === 'error' ? 'login-error' : 'login-sent');
    node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    node.textContent = text;
    form.appendChild(node);
    statusNode = node;
  };

  const setBusy = (on) => {
    busy = on;
    email.disabled = on;
    submit.disabled = on;
    if (on) {
      submit.setAttribute('aria-busy', 'true');
      submit.textContent = LOGIN_COPY.sending;
      if (google && typeof google.setAttribute === 'function') {
        google.setAttribute('aria-disabled', 'true');
      }
    } else {
      submit.setAttribute('aria-busy', 'false');
      submit.textContent = idleLabel;
      if (google && typeof google.setAttribute === 'function') {
        google.setAttribute('aria-disabled', 'false');
      }
    }
  };

  if (google && typeof google.addEventListener === 'function') {
    google.addEventListener('click', (event) => {
      if (!busy) return;
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
    });
  }

  const onSubmit = async (event) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    if (busy) return;
    const typed = String(email.value ?? '').trim();
    if (typed === '') {
      email.setAttribute('aria-invalid', 'true');
      showStatus('error', LOGIN_COPY.emptyEmail);
      return;
    }
    if (!isSendableLoginEmail(typed)) {
      email.setAttribute('aria-invalid', 'true');
      showStatus('error', LOGIN_COPY.invalidEmail);
      return;
    }
    email.setAttribute('aria-invalid', 'false');
    clearStatus();
    setBusy(true);
    let sent = false;
    try {
      sent = await request(typed);
    } catch {
      sent = false;
    }
    setBusy(false);
    if (sent) {
      showStatus('status', `${LOGIN_COPY.sentTitle} ${LOGIN_COPY.sentBody}`);
    } else {
      showStatus('error', LOGIN_COPY.failed);
    }
  };

  if (form && typeof form.addEventListener === 'function') {
    form.addEventListener('submit', onSubmit);
  }
  return { onSubmit };
}
