// backlog:ecb26347d12c — reproTest: the shell menu tells apart two spaces
// that arrive with the same stored sigla, and the «Cambia spazio» button
// lists only the shortcuts that exist.
// Red on the code before 1d2849f2 (no dedup, fixed «(⌘1/2/3)» label),
// green after.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  spaceBadgeColor,
  spaceMenuItems,
  spaceSwitcherLabel,
} from '../apps/admin/public/admin-shell.js';

test('ecb26347d12c repro — two spaces with the same stored sigla read differently', () => {
  const rows = spaceMenuItems(
    [
      { id: 'b1', name: 'Prova Validazione B1', initials: 'PR' },
      { id: 'presti-group', name: 'Presti Group', initials: 'PR' },
    ],
    'b1',
  );
  assert.equal(rows.length, 2);
  const sameInitials = rows[0].initials === rows[1].initials;
  const sameColor = rows[0].color === rows[1].color;
  assert.ok(!sameInitials || !sameColor, 'sigla o colore diversi');
  assert.notEqual(rows[0].initials, rows[1].initials);
  assert.equal(rows[0].color, spaceBadgeColor('b1'));
});

test('ecb26347d12c repro — the button label lists only the shortcuts that exist', () => {
  assert.equal(spaceSwitcherLabel([{ id: 'a' }, { id: 'b' }]), 'Cambia spazio (⌘1/2)');
  assert.equal(
    spaceSwitcherLabel([{ id: 'a' }, { id: 'b' }, { id: 'c' }]),
    'Cambia spazio (⌘1/2/3)',
  );
});
