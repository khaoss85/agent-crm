import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { AuditLog } from '../packages/core/src/audit.js';
import { createDatabase } from '../packages/core/src/database.js';
import { EventBus } from '../packages/core/src/event-bus.js';
import {
  createRecordModuleFromManifest,
  recordModuleMigrations,
} from '../packages/core/src/record-module-runtime.js';
import { createCallIntelligence } from '../packages/intelligence/src/call-intelligence.js';
import { createIntelligenceDomain } from '../packages/intelligence/src/index.js';
import { createLlmOperations, openLlmComplete } from '../packages/llm/src/operations.js';
import { createFixtureLlmAdapter } from '../packages/llm/src/fixture.js';

/**
 * Voce 5036bc435465 (telefonate: nota vocale dopo la chiamata): the
 * dictated text is structured into riassunto, decisioni and prossimi passi.
 *
 * What it must prove: a dictated text returns the three frozen sections;
 * the request leaves through the workspace LLM with the
 * `voice-note-structure` purpose (its own audited workload, like
 * `call-summary`); without a composed language model the operation
 * refuses 409 VOICE_NOTE_UNAVAILABLE instead of inventing a draft; an
 * empty or oversize text refuses before any spend; a malformed AI answer
 * refuses 502 and stores nothing (the operation is stateless anyway).
 */

const here = dirname(fileURLToPath(import.meta.url));
const loadManifest = (pkg, name) => JSON.parse(
  readFileSync(join(here, '..', 'packages', pkg, 'modules', `${name}.module.json`), 'utf8'),
);

const SPACE = 'voice-a';
const USER = { type: 'user', id: 'operator-elena' };
const LLM_SECRET = 'voice-note-llm-secret-1';
const NOW = '2026-11-15T08:00:00.000Z';

const DRAFT_ANSWER = JSON.stringify({
  riassunto: 'Chiamata andata bene: il cliente vuole provare prima di Natale.',
  decisioni: 'Prova gratuita di una settimana concordata.',
  prossimiPassi: 'Elena richiama lunedì per fissare il primo ingresso.',
});

const stubLlm = (seen, text = DRAFT_ANSWER) => ({
  async complete(request) {
    seen.push(request);
    return { text };
  },
});

const opsWith = (llm) => createCallIntelligence({ modules: new Map(), llm });

const outcome = (promise) => promise.then(
  (result) => ({ accepted: true, result }),
  (error) => ({ accepted: false, code: error.code, status: error.status, message: error.message }),
);

test('5036bc435465: dictated text structures into riassunto, decisioni and prossimi passi', async () => {
  const seen = [];
  const ops = opsWith(stubLlm(seen));
  const draft = await ops.structureVoiceNote({
    spaceId: SPACE, actor: USER,
    text: 'Ho chiamato il cliente, è andata bene, vuole provare prima di Natale, prova gratuita di una settimana, io lo richiamo lunedì.',
  });
  assert.deepEqual({ ...draft }, JSON.parse(DRAFT_ANSWER));
  assert.ok(Object.isFrozen(draft), 'the draft is frozen, like every shaped read');
  assert.equal(seen.length, 1, 'the AI is asked exactly once');
  assert.equal(seen[0].purpose, 'voice-note-structure', 'its own audited purpose, never assistant chatter');
  assert.equal(seen[0].spaceId, SPACE, 'the space stays explicit for the spend caps');
});

test('5036bc435465: without a language model the draft refuses instead of inventing one', async () => {
  for (const ops of [opsWith(null), opsWith(undefined)]) {
    const refused = await outcome(ops.structureVoiceNote({ spaceId: SPACE, actor: USER, text: 'detto' }));
    assert.equal(refused.accepted, false);
    assert.equal(refused.code, 'VOICE_NOTE_UNAVAILABLE');
    assert.equal(refused.status, 409, 'the card names the switched-off AI from this refusal');
  }
});

test('5036bc435465: an empty or oversize text refuses before any spend', async () => {
  const seen = [];
  const ops = opsWith(stubLlm(seen));
  for (const text of ['', '   ', 'x'.repeat(2001)]) {
    const refused = await outcome(ops.structureVoiceNote({ spaceId: SPACE, actor: USER, text }));
    assert.equal(refused.accepted, false, JSON.stringify(text).slice(0, 20));
    assert.equal(refused.code, 'VALIDATION_ERROR');
  }
  assert.equal(seen.length, 0, 'a refused text never reaches the provider');
});

test('5036bc435465: a malformed AI answer refuses and structures nothing', async () => {
  const bad = [
    'not json at all',
    JSON.stringify({ riassunto: 'ok', decisioni: 'ok' }),
    JSON.stringify({ riassunto: '', decisioni: 'ok', prossimiPassi: 'ok' }),
    JSON.stringify({ riassunto: 'x'.repeat(401), decisioni: 'ok', prossimiPassi: 'ok' }),
    JSON.stringify({ riassunto: 'ok', decisioni: 'ok', prossimiPassi: 'y'.repeat(251) }),
    JSON.stringify(['riassunto']),
  ];
  for (const text of bad) {
    const seen = [];
    const refused = await outcome(opsWith(stubLlm(seen, text)).structureVoiceNote({
      spaceId: SPACE, actor: USER, text: 'detto vero',
    }));
    assert.equal(refused.accepted, false, text.slice(0, 40));
    assert.equal(refused.code, 'VOICE_NOTE_INVALID');
    assert.equal(refused.status, 502);
  }
});

test('5036bc435465: the longest draft still fits the cronologia note bound of 1000', () => {
  const body = `Riassunto: ${'r'.repeat(400)}\nDecisioni: ${'d'.repeat(250)}\nProssimi passi: ${'p'.repeat(250)}`;
  assert.ok(body.length <= 1000, `composed ${body.length} chars, bound is 1000`);
});

test('5036bc435465: the domain hands the composed llm-complete capability to the voice-note operation', async (t) => {
  const database = createDatabase({ path: ':memory:' });
  const manifests = ['llm-usage-day', 'llm-call-audit'].map((name) => ({ pkg: 'llm', name }));
  for (const { pkg, name } of manifests) {
    for (const { sql } of recordModuleMigrations([{ name, manifest: loadManifest(pkg, name) }])) {
      database.raw.exec(sql);
    }
  }
  const audit = new AuditLog(database);
  const events = new EventBus();
  const modules = new Map();
  for (const { pkg, name } of manifests) {
    const built = createRecordModuleFromManifest(loadManifest(pkg, name), { database, audit, events, references: {} });
    modules.set(name, { service: built.service });
  }
  t.after(() => database.close?.());
  const fixture = createFixtureLlmAdapter({ secret: LLM_SECRET, answers: [{ text: DRAFT_ANSWER }] });
  const domain = createIntelligenceDomain({
    llm: {
      capabilities: [{
        name: 'llm-complete',
        version: 1,
        create: ({ modules: runtimeModules }) => openLlmComplete(
          createLlmOperations({
            adapters: [fixture.definition],
            spaces: { [SPACE]: { enabled: true, adapter: 'fixture-llm', adapterVersion: 1 } },
            secretRef: `secret://${SPACE}/llm`,
            resolveSecret: async () => LLM_SECRET,
            clock: () => Date.parse(NOW),
          }),
          { modules: runtimeModules },
        ),
      }],
    },
  });
  const byName = Object.fromEntries(domain.operations.map((entry) => [entry.name, entry]));
  assert.ok(byName['structure-voice-note'], 'the operation is declared on the domain');
  const runtime = { modules };
  const draft = await byName['structure-voice-note'].create(runtime)({
    spaceId: SPACE, text: 'detto vero dalla scheda', actor: USER,
  });
  assert.equal(draft.riassunto, JSON.parse(DRAFT_ANSWER).riassunto);
  assert.equal(fixture.api.calls(), 1, 'exactly one audited completion');
});
