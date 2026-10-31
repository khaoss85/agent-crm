// @ts-check

/**
 * File parsing and column mapping for the Clienti import tool
 * (backlog:5b164ab5). Pure functions: no DOM, no network.
 *
 * Only CSV is read here. An Excel workbook (.xlsx/.xls) is a zip of XML
 * documents: parsing it by hand in the Admin app would mean guessing dates
 * (serial numbers) and silently mangling them into customer records, so the
 * tool refuses workbooks with an honest Italian line and the operator saves
 * the sheet as CSV. The refusal lives here so the view and the tests share
 * the exact same wording.
 */

export const WORKBOOK_EXTENSIONS = Object.freeze(['.xlsx', '.xls']);

/** @param {string} name */
export function isWorkbookName(name) {
  const lower = String(name ?? '').toLowerCase();
  return WORKBOOK_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export const WORKBOOK_REFUSAL =
  'Questo è un foglio Excel: per ora si importa solo in CSV. Salva il foglio come CSV e ricaricalo.';

/**
 * The server row contract (packages/customer-data/src/import.js
 * `normalizeRow`): only these keys travel. `phone` is not one of them — a
 * phone rides a second governed apply under the `phone` system beside the
 * record, exactly like the manual form (admin-cliente-nuovo.js) does.
 */
export const IMPORT_FIELDS = Object.freeze([
  { value: 'ignore', label: 'Ignora questa colonna' },
  { value: 'firstName', label: 'Nome' },
  { value: 'lastName', label: 'Cognome' },
  { value: 'email', label: 'Email' },
  { value: 'companyName', label: 'Azienda' },
  { value: 'externalId', label: 'Codice esterno' },
  { value: 'domain', label: 'Sito web' },
  { value: 'phone', label: 'Telefono' },
]);

/** Italian column header for a mapped field, for the preview table. @param {string} value */
export function fieldLabel(value) {
  return IMPORT_FIELDS.find((field) => field.value === value)?.label ?? value;
}

/**
 * Guess the delimiter from the first non-empty lines: the winner between
 * comma, semicolon and tab, counted outside quotes.
 * @param {string[]} lines
 */
function detectDelimiter(lines) {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  for (const line of lines.slice(0, 5)) {
    if (line.trim() === '') continue;
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (!inQuotes && (char === ',' || char === ';' || char === '\t')) {
        counts[char] += 1;
      }
    }
  }
  if (counts[';'] >= counts[','] && counts[';'] >= counts['\t'] && counts[';'] > 0) return ';';
  if (counts['\t'] >= counts[','] && counts['\t'] > 0) return '\t';
  return ',';
}

/**
 * Parse CSV text (quotes, escaped quotes, newlines inside quotes).
 * @param {string} text
 * @returns {{ columns: string[], rows: string[][], delimiter: string }}
 */
export function parseCsvText(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  if (source.trim() === '') return { columns: [], rows: [], delimiter: ',' };
  const delimiter = detectDelimiter(source.split(/\r?\n/));
  const rows = [];
  let record = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      record.push(field);
      field = '';
    } else if (char === '\r') {
      // Handled with the \n below; a lone \r still ends the record.
      if (source[i + 1] !== '\n') {
        record.push(field);
        field = '';
        rows.push(record);
        record = [];
      }
    } else if (char === '\n') {
      record.push(field);
      field = '';
      rows.push(record);
      record = [];
    } else {
      field += char;
    }
  }
  record.push(field);
  rows.push(record);
  const nonEmpty = rows.filter((row) => row.some((cell) => String(cell).trim() !== ''));
  if (nonEmpty.length === 0) return { columns: [], rows: [], delimiter };
  const [header, ...body] = nonEmpty;
  const width = header.length;
  const columns = header.map((cell) => String(cell).trim());
  const data = body.map((row) => {
    const cells = row.map((cell) => String(cell).trim());
    while (cells.length < width) cells.push('');
    return cells.slice(0, width);
  });
  return { columns, rows: data, delimiter };
}

const GUESS_RULES = Object.freeze([
  { value: 'email', match: ['e-mail', 'email', 'mail', 'posta elettronica'] },
  { value: 'firstName', match: ['nome', 'firstname', 'first name', 'given name'] },
  { value: 'lastName', match: ['cognome', 'lastname', 'last name', 'family name'] },
  { value: 'phone', match: ['telefono', 'tel', 'cellulare', 'cell', 'phone', 'mobile'] },
  { value: 'companyName', match: ['azienda', 'società', 'societa', 'ragione sociale', 'company', 'ditta'] },
  { value: 'externalId', match: ['codice esterno', 'codice', 'external id', 'externalid', 'id esterno'] },
  { value: 'domain', match: ['sito web', 'sito', 'dominio', 'domain', 'website'] },
]);

/** @param {string} header */
function guessOne(header) {
  const clean = String(header ?? '').trim().toLowerCase();
  if (clean === '') return 'ignore';
  if (clean === 'id') return 'ignore';
  for (const rule of GUESS_RULES) {
    if (rule.match.includes(clean)) return rule.value;
  }
  return 'ignore';
}

/**
 * One mapping per column; a field is offered once (first column wins, the
 * rest stay on Ignora) so two columns never write the same field.
 * @param {string[]} columns
 */
export function guessMapping(columns) {
  const taken = new Set();
  return columns.map((column) => {
    const guess = guessOne(column);
    if (guess === 'ignore' || taken.has(guess)) return 'ignore';
    taken.add(guess);
    return guess;
  });
}

/**
 * Build the server rows from the mapped columns. Fully empty lines are
 * skipped and counted; extra keys never travel (the server contract above).
 * @param {string[]} columns @param {string[][]} rows @param {string[]} mapping
 */
export function buildImportRows(columns, rows, mapping) {
  const built = [];
  let skippedEmpty = 0;
  for (const [fileIndex, cells] of rows.entries()) {
    const values = {};
    for (let i = 0; i < columns.length; i += 1) {
      const target = mapping[i] ?? 'ignore';
      if (target === 'ignore' || target === 'phone') continue;
      const value = String(cells[i] ?? '').trim();
      if (value !== '') values[target] = value;
    }
    if (Object.keys(values).length === 0) {
      skippedEmpty += 1;
      continue;
    }
    built.push({ fileIndex, values });
  }
  return { rows: built, skippedEmpty };
}

/** @param {string} raw */
export function normalizePhone(raw) {
  return String(raw ?? '').replace(/[\s.\-()/]/g, '');
}

/** @param {string} raw */
export function isLinkablePhone(raw) {
  return /^\+?\d{6,15}$/.test(normalizePhone(raw));
}

/**
 * Split the phone column out: one `phone`-system row per file row that
 * carries both a usable phone and the email that names its owner — the same
 * shape the manual form sends. Phones without an email cannot be linked and
 * are counted, never smuggled into the main rows.
 * @param {string[][]} rows @param {string[]} mapping
 */
export function splitPhoneRows(rows, mapping) {
  const phoneIndex = mapping.indexOf('phone');
  const emailIndex = mapping.indexOf('email');
  if (phoneIndex === -1) return { phones: [], unlinkedPhones: 0 };
  const phones = [];
  let unlinkedPhones = 0;
  for (const cells of rows) {
    const rawPhone = String(cells[phoneIndex] ?? '').trim();
    if (rawPhone === '') continue;
    const email = emailIndex === -1 ? '' : String(cells[emailIndex] ?? '').trim();
    if (email === '' || !isLinkablePhone(rawPhone)) {
      unlinkedPhones += 1;
      continue;
    }
    phones.push({ externalId: normalizePhone(rawPhone), email });
  }
  return { phones, unlinkedPhones };
}
