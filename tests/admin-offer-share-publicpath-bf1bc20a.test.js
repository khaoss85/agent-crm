import test from 'node:test';
import assert from 'node:assert/strict';
import { offerShareUrlFromAnswer } from '../apps/admin/public/admin-offer-panel.js';

/**
 * backlog:bf1bc20a — VERIFIER_BACK repro (supervisor 2026-11-19.md 08:13Z,
 * Mac sul live: testo pronto e «Apri il link» mostrano /q/<token> senza
 * spazio -> 404 «Workspace unavailable», mentre lo stesso token sotto
 * /w/<spazio>/q/<token> apre 200).
 *
 * Il ponte /bo (pilota #729, unita) nomina già result.publicPath, ma la
 * shell lo ignora e ricompone da sola /q/<token>. Su questo codice il file
 * è rosso — offerShareUrlFromAnswer non esiste e la pagina dipinge l'URL
 * nudo — e verde dopo la cura: l'URL mostrato è esattamente publicPath.
 */

const ORIGIN = 'https://spazio.example';
const SPACE = '2f07eeb9-1234-4abc-9def-0123456789ab';
const TOKEN = 'c'.repeat(64);
const PUBLIC_PATH = `/w/${SPACE}/q/${TOKEN}`;
const PUBLIC_URL = `${ORIGIN}${PUBLIC_PATH}`;

test('bf1bc20a repro: the shown URL is the bridge publicPath, never the recomposed /q/<token>', () => {
  assert.equal(
    offerShareUrlFromAnswer(ORIGIN, { token: TOKEN, publicPath: PUBLIC_PATH }),
    PUBLIC_URL,
    'red before the cure: the shell recomposes origin + /q/<token> and the live edge 404s',
  );
});

test('bf1bc20a: publicPath wins, the token is only the fallback', () => {
  assert.equal(offerShareUrlFromAnswer(ORIGIN, { token: TOKEN }), `${ORIGIN}/q/${TOKEN}`);
  assert.equal(offerShareUrlFromAnswer(ORIGIN, {}), null, 'no token and no path: no URL, never a throw');
  assert.equal(offerShareUrlFromAnswer(ORIGIN, null), null);
  assert.equal(offerShareUrlFromAnswer(ORIGIN, undefined), null);
  assert.equal(
    offerShareUrlFromAnswer('https://spazio.example///', { token: TOKEN, publicPath: PUBLIC_PATH }),
    PUBLIC_URL,
    'trailing slashes never double the path slash',
  );
});

test('bf1bc20a: a forged or shapeless publicPath never paints — the token fallback holds', () => {
  assert.equal(
    offerShareUrlFromAnswer(ORIGIN, { token: TOKEN, publicPath: `https://evil.example${PUBLIC_PATH}` }),
    `${ORIGIN}/q/${TOKEN}`,
    'an absolute URL in publicPath is not followed',
  );
  assert.equal(
    offerShareUrlFromAnswer(ORIGIN, { token: TOKEN, publicPath: `/q/${TOKEN}` }),
    `${ORIGIN}/q/${TOKEN}`,
    'the bare mount-less path is not trusted as a mount',
  );
  assert.equal(
    offerShareUrlFromAnswer(ORIGIN, { token: TOKEN, publicPath: `/w/${SPACE}/q/short` }),
    `${ORIGIN}/q/${TOKEN}`,
    'a bad token inside publicPath falls back, never paints',
  );
  assert.equal(
    offerShareUrlFromAnswer(ORIGIN, { token: TOKEN, publicPath: '/w/not-a-space/q/' + TOKEN }),
    `${ORIGIN}/q/${TOKEN}`,
    'a bad space id inside publicPath falls back, never paints',
  );
  assert.equal(
    offerShareUrlFromAnswer(ORIGIN, { token: TOKEN, publicPath: 'javascript:alert(1)' }),
    `${ORIGIN}/q/${TOKEN}`,
    'a script scheme is not followed',
  );
});

test('bf1bc20a: no origin, no URL — even with a good publicPath', () => {
  assert.equal(offerShareUrlFromAnswer('', { token: TOKEN, publicPath: PUBLIC_PATH }), null);
  assert.equal(offerShareUrlFromAnswer('ftp://spazio.example', { token: TOKEN, publicPath: PUBLIC_PATH }), null);
  assert.equal(offerShareUrlFromAnswer(null, { token: TOKEN, publicPath: PUBLIC_PATH }), null);
});
