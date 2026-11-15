import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const PUBLIC_DIR = new URL('../apps/admin/public/', import.meta.url);

/**
 * backlog:b545aca18b8f — the pilot serves the /bo client through a pass that
 * cuts `//` as a comment. A regex literal whose source holds `//` (an escaped
 * slash right before the closing slash, as in `/^https?:\/\//`) is truncated
 * there, the module throws «Invalid regular expression: missing /» and the
 * whole shell loses its sidebar (agent-crm#905, pilot red 2 on 2 on 34bcfe5,
 * green on fe6b7de). This guard scans every served client file and fails on
 * any regex literal containing `//`, so the shape cannot re-enter.
 */

const AFTER_OPERATOR = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '^', '~']);
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else']);

function skipString(src, i) {
  const q = src[i];
  i += 1;
  while (i < src.length && src[i] !== q) {
    if (src[i] === '\\') i += 1;
    i += 1;
  }
  return i + 1;
}

function skipTemplate(src, i, lines) {
  i += 1; // the opening backtick
  const stack = ['t'];
  while (i < src.length && stack.length > 0) {
    const top = stack[stack.length - 1];
    const c = src[i];
    if (top === 't') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { stack.pop(); i += 1; continue; }
      if (c === '$' && src[i + 1] === '{') { stack.push('b'); i += 2; continue; }
      if (c === '\n') lines.count += 1;
      i += 1; continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const before = i;
      i = c === '`' ? skipTemplate(src, i, lines) : skipString(src, i);
      if (c !== '`') lines.count += (src.slice(before, i).match(/\n/g) || []).length;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); i = e === -1 ? src.length : e; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      lines.count += (src.slice(i, e === -1 ? src.length : e + 2).match(/\n/g) || []).length;
      i = e === -1 ? src.length : e + 2;
      continue;
    }
    if (c === '{') { stack.push('b'); i += 1; continue; }
    if (c === '}') { stack.pop(); i += 1; continue; }
    if (c === '\n') lines.count += 1;
    i += 1;
  }
  return i;
}

function regexLiteralsWithDoubleSlash(src) {
  const hits = [];
  let i = 0;
  const lines = { count: 1 };
  let prev = 'start'; // 'start' | 'operand' | 'operator' | 'regexok'
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\n') { lines.count += 1; i += 1; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\v' || c === '\f') { i += 1; continue; }
    if (c === "'" || c === '"') {
      const before = i;
      i = skipString(src, i);
      lines.count += (src.slice(before, i).match(/\n/g) || []).length;
      prev = 'operand';
      continue;
    }
    if (c === '`') { i = skipTemplate(src, i, lines); prev = 'operand'; continue; }
    if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); i = e === -1 ? n : e; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      const chunk = src.slice(i, e === -1 ? n : e + 2);
      lines.count += (chunk.match(/\n/g) || []).length;
      i = e === -1 ? n : e + 2;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j += 1;
      prev = REGEX_KEYWORDS.has(src.slice(i, j)) ? 'regexok' : 'operand';
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) { let j = i + 1; while (j < n && /[0-9A-Za-z_.$]/.test(src[j])) j += 1; prev = 'operand'; i = j; continue; }
    if (c === ')' || c === ']') { prev = 'operand'; i += 1; continue; }
    if (c === '/') {
      const regexOk = prev === 'start' || prev === 'regexok' || prev === 'operator' || AFTER_OPERATOR.has(prev);
      if (!regexOk) { prev = 'operator'; i += 1; continue; }
      const startLine = lines.count;
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        const d = src[j];
        if (d === '\n') break;
        if (d === '\\') { j += 2; continue; }
        if (d === '[') { inClass = true; j += 1; continue; }
        if (d === ']' && inClass) { inClass = false; j += 1; continue; }
        if (d === '/' && !inClass) break;
        j += 1;
      }
      if (j >= n || src[j] !== '/') { prev = 'operator'; i += 1; continue; }
      let k = j + 1;
      while (k < n && /[a-z]/i.test(src[k])) k += 1;
      const span = src.slice(i, k);
      if (span.includes('//')) hits.push({ line: startLine, text: span.slice(0, 80) });
      prev = 'operand';
      i = k;
      continue;
    }
    prev = 'operator';
    i += 1;
  }
  return hits;
}

test('b545aca18b8f: no regex literal in the served /bo client holds `//`', () => {
  const files = readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.js')).sort();
  assert.ok(files.length > 10, 'the guard scans the real client directory');
  const violations = [];
  for (const file of files) {
    const src = readFileSync(new URL(file, PUBLIC_DIR), 'utf8');
    for (const hit of regexLiteralsWithDoubleSlash(src)) violations.push(`${file}:${hit.line}: ${hit.text}`);
  }
  assert.deepEqual(violations, [], `regex literals with // break the served /bo client: ${violations.join('; ')}`);
});
