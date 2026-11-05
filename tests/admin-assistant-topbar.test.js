// Dan 05/11: the words typed in the top bar are never dropped. With free
// questions off they run the closest suggestion, and channels read in Italian.
import test from 'node:test';
import assert from 'node:assert/strict';
import { closestSuggestion, channelName, suggestionsFor } from '../apps/admin/public/admin-assistant.js';

test('a typed question runs the closest suggestion of the screen', () => {
  const titles = suggestionsFor('clienti').map((s) => s.title);
  assert.ok(titles.includes('Chi devo ricontattare?'));
  assert.equal(closestSuggestion('clienti', 'chi devo ricontattare oggi?')?.title, 'Chi devo ricontattare?');
  assert.equal(closestSuggestion('clienti', 'quali lead sono più caldi')?.title, 'Quali lead mostrano segnali caldi?');
});

test('no overlap, empty or non-string questions match nothing', () => {
  assert.equal(closestSuggestion('clienti', 'meteo a Milano'), null);
  assert.equal(closestSuggestion('clienti', '   '), null);
  assert.equal(closestSuggestion('clienti', undefined), null);
});

test('channel ids read in Italian, unknown ids stay short and as they are', () => {
  assert.equal(channelName('phone'), 'Telefono');
  assert.equal(channelName('facebook'), 'Facebook');
  assert.equal(channelName('WhatsApp'), 'WhatsApp');
  assert.equal(channelName('carrier-pigeon'), 'carrier-pigeon');
});
