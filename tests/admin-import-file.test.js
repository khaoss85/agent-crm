import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildImportRows,
  guessMapping,
  isWorkbookName,
  parseCsvText,
  splitPhoneRows,
  WORKBOOK_REFUSAL,
} from '../apps/admin/public/admin-import-file.js';

/**
 * The CSV layer of the Clienti import tool (backlog:5b164ab5): parsing,
 * column guesses and row building. What it must prove: quoted fields and
 * semicolons parse, headers guess to the server fields without doubling a
 * field, and phone cells ride apart from the main rows.
 */

test('a semicolon file with quotes parses to columns and rows', () => {
  const parsed = parseCsvText('nome;email;note\n"Rossi; Mario";mario@esempio.it;"vuole la ""prova"", grazie"\n');
  assert.deepEqual(parsed.columns, ['nome', 'email', 'note']);
  assert.deepEqual(parsed.rows, [['Rossi; Mario', 'mario@esempio.it', 'vuole la "prova", grazie']]);
  assert.equal(parsed.delimiter, ';');
});

test('embedded newlines stay inside the quoted field', () => {
  const parsed = parseCsvText('nome,email\nAda,"riga uno\nriga due"\nBo,bo@esempio.it\n');
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0][1], 'riga uno\nriga due');
});

test('an empty file has no columns', () => {
  assert.deepEqual(parseCsvText('   \n'), { columns: [], rows: [], delimiter: ',' });
});

test('headers guess to the server fields, each offered once', () => {
  const mapping = guessMapping(['Nome', 'Cognome', 'E-mail', 'Telefono', 'Azienda', 'Codice', 'Sito web', 'Note']);
  assert.deepEqual(mapping, ['firstName', 'lastName', 'email', 'phone', 'companyName', 'externalId', 'domain', 'ignore']);
});

test('a repeated field stays on the first column only', () => {
  const mapping = guessMapping(['email', 'e-mail']);
  assert.deepEqual(mapping, ['email', 'ignore']);
});

test('a bare id column is left to the operator', () => {
  assert.deepEqual(guessMapping(['id']), ['ignore']);
});

test('empty lines are skipped and counted, extra columns never travel', () => {
  const { rows, skippedEmpty } = buildImportRows(
    ['nome', 'email', 'note'],
    [['Ada', 'ada@esempio.it', 'x'], ['', '', ''], ['Bo', '', 'y']],
    ['firstName', 'email', 'ignore'],
  );
  assert.equal(skippedEmpty, 1);
  assert.deepEqual(rows, [
    { fileIndex: 0, values: { firstName: 'Ada', email: 'ada@esempio.it' } },
    { fileIndex: 2, values: { firstName: 'Bo' } },
  ]);
});

test('the phone column leaves the main rows and rides apart', () => {
  const { phones, unlinkedPhones } = splitPhoneRows(
    [
      ['Ada', 'ada@esempio.it', '+39 333 1234567'],
      ['Bo', '', '+39 333 7654321'],
      ['Cid', 'cid@esempio.it', 'non un numero'],
      ['Dea', 'dea@esempio.it', ''],
    ],
    ['firstName', 'email', 'phone'],
  );
  assert.deepEqual(phones, [{ externalId: '+393331234567', email: 'ada@esempio.it' }]);
  assert.equal(unlinkedPhones, 2);
});

test('a workbook name is refused with the honest Italian line', () => {
  assert.ok(isWorkbookName('clienti.XLSX'));
  assert.ok(isWorkbookName('clienti.xls'));
  assert.ok(!isWorkbookName('clienti.csv'));
  assert.ok(WORKBOOK_REFUSAL.includes('CSV'), 'the refusal names the way out');
  assert.doesNotMatch(WORKBOOK_REFUSAL, /zip|XML|parse/i, 'no technical cause on the surface');
});
