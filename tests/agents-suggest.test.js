// @ts-check

/**
 * Backlog 086c6656c5df: the UI confirms proposals in one click — the
 * engine side stays pure: schedule proposals for a phrase with no
 * frequency, the per-turn cost proposal and the new-agent draft.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UNCLEAR_SCHEDULE_PROPOSALS,
  suggestScheduleProposals,
  suggestCostCents,
  suggestNewAgent,
} from '../packages/agents/src/agents.js';

test('schedule proposals: daily, monthly and once — never a weekday guess', () => {
  assert.deepEqual(UNCLEAR_SCHEDULE_PROPOSALS.map((entry) => entry.id), ['daily', 'monthly', 'once']);
  const proposals = suggestScheduleProposals();
  assert.deepEqual(proposals.find((entry) => entry.id === 'daily')?.plan, { cadence: 'daily', timeOfDay: '08:00' });
  assert.deepEqual(proposals.find((entry) => entry.id === 'once')?.plan, { cadence: 'once' });
  proposals[0].plan.cadence = 'weekly';
  assert.equal(suggestScheduleProposals()[0].plan.cadence, 'daily', 'a confirm never mutates the shared proposal');
});

test('cost proposal: the median of the agent’s own positive runs, ten cents with none', () => {
  const runs = [
    { agentSourceKey: 'a', costCents: 30 },
    { agentSourceKey: 'a', costCents: 10 },
    { agentSourceKey: 'a', costCents: 20 },
    { agentSourceKey: 'a', costCents: 0 },
    { agentSourceKey: 'a', costCents: -5 },
    { agentSourceKey: 'b', costCents: 9999 },
  ];
  assert.equal(suggestCostCents(runs, 'a'), 20);
  assert.equal(suggestCostCents([{ agentSourceKey: 'a', costCents: 7 }, { agentSourceKey: 'a', costCents: 9 }], 'a'), 8, 'an even count splits the middle');
  assert.equal(suggestCostCents([], 'a'), 10);
  assert.equal(suggestCostCents(runs, 'nessuno'), 10, 'another agent never moves it');
  assert.equal(suggestCostCents(runs, ''), 10);
  assert.equal(suggestCostCents([], 'a', 25), 25, 'the caller fallback wins when there is nothing to learn from');
  assert.equal(suggestCostCents([], 'a', 0), 10, 'a bad fallback stays ten cents');
});

test('new-agent draft: the name skips schedule words, role and instructions keep the phrase', () => {
  const draft = suggestNewAgent('ogni lunedì segue i lead nuovi');
  assert.equal(draft?.name, 'Segue i lead');
  assert.equal(draft?.role, 'Esegue: ogni lunedì segue i lead nuovi');
  assert.match(draft?.instructions ?? '', /ogni lunedì segue i lead nuovi/);
  assert.match(draft?.instructions ?? '', /chiede sempre l’ok/);
  const once = suggestNewAgent('occupati dei lead adesso');
  assert.equal(once?.name, 'Occupati dei lead', '«adesso» never names the agent');
  assert.equal(suggestNewAgent(''), null);
  assert.equal(suggestNewAgent('   '), null);
  assert.equal(suggestNewAgent(null), null);
  const long = suggestNewAgent(`${'parola '.repeat(100)}fine`);
  assert.ok((long?.name.length ?? 0) <= 120, 'the name stays bounded');
  assert.ok((long?.role.length ?? 0) <= 120, 'the role stays bounded');
  assert.ok((long?.instructions.length ?? 0) <= 4000, 'the instructions stay bounded');
});
