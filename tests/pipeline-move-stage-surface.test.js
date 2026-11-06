import test from 'node:test';
import assert from 'node:assert/strict';

// The move-stage factory on the public kernel surface (backlog:c202d787):
// a consumer composition registers the returned definition in its
// `selected.actions` to make the staged opportunity module actionable.
// Reached through `packages/core/index.js` and nothing deeper: the index
// header names `packages/core/src/*` out of contract.
import { buildMoveStageAction } from '../packages/core/index.js';
import {
  ActionRegistry,
  validateActionDefinition,
} from '../packages/core/src/action-registry.js';

test('the public kernel surface publishes the move-stage factory', () => {
  assert.equal(typeof buildMoveStageAction, 'function');
  const definition = buildMoveStageAction({ module: 'opportunity' });
  assert.equal(definition.module, 'opportunity');
  assert.equal(definition.name, 'move-stage');
  assert.equal(definition.actionContract, 1);
});

test('the published factory builds a definition the registry accepts for opportunity', () => {
  const definition = buildMoveStageAction({ module: 'opportunity' });
  assert.doesNotThrow(() => validateActionDefinition(definition, {
    moduleExists: (name) => name === 'opportunity',
  }));
  const registry = new ActionRegistry({ moduleExists: (name) => name === 'opportunity' });
  registry.register(definition);
  // Registration IS the eligibility declaration the generic action surface
  // checks (`resolveActionableModule`): a core module with at least one
  // registered action resolves instead of 404.
  assert.equal(registry.listForModule('opportunity').length, 1);
});
