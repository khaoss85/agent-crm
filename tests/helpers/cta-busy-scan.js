// @ts-check

/**
 * backlog:07895caaa4be (seguito della review Muse di #775): the per-button
 * scan behind tests/admin-cta-busy.test.js.
 *
 * For every `X.addEventListener('click' | 'submit', handler)` in a /bo view
 * file it answers two questions, reading source only (no browser):
 *
 * 1. Does pressing X write? The handler's own code, or a function of the
 *    same file it calls (up to WRITE_DEPTH calls deep), sends a
 *    POST/PATCH/PUT/DELETE or a `submissions.submit(`. Code that runs later
 *    is not "pressing X": listeners wired inside a render and nested
 *    functions (arrows, function expressions) are cut out, so a render that
 *    builds a Salva form does not count as writing itself.
 * 2. Does X show it is waiting? The handler, or a function it calls (up to
 *    BUSY_DEPTH deep), goes through uiBusy / uiHold / uiMarkBusy or sets
 *    aria-busy.
 *
 * A button that writes without showing it is reported with the call chain
 * that reaches the write. Views that rebuild the pressed button while the
 * write runs (the wait is painted from state) cannot be seen this way: the
 * guard lists them by name, with the reason.
 *
 * It is a source scan, deliberately simple: a handler that writes through a
 * function of another module is not followed.
 */

const WRITE = /method: ['"](POST|PATCH|PUT|DELETE)['"]|submissions\.submit\(/;
const BUSY = /\buiBusy\(|\buiHold\(|\buiMarkBusy\(|'aria-busy'/;
const WRITE_DEPTH = 4;
const BUSY_DEPTH = 2;

/**
 * Index of the closer matching the opener ( [ { or quote at `i`; strings,
 * template literals with ${…} and comments are skipped.
 * @param {string} src @param {number} i
 */
function closeOf(src, i) {
  /** @type {string[]} */
  const stack = [];
  for (let k = i; k < src.length; k += 1) {
    const c = src[k];
    const top = stack[stack.length - 1];
    if (top === "'" || top === '"') {
      if (c === '\\') k += 1;
      else if (c === top) {
        stack.pop();
        if (stack.length === 0) return k;
      }
      continue;
    }
    if (top === '`') {
      if (c === '\\') k += 1;
      else if (c === '`') {
        stack.pop();
        if (stack.length === 0) return k;
      } else if (c === '$' && src[k + 1] === '{') {
        stack.push('${');
        k += 1;
      }
      continue;
    }
    if (c === '/' && src[k + 1] === '/') {
      const end = src.indexOf('\n', k);
      if (end < 0) return src.length;
      k = end;
      continue;
    }
    if (c === '/' && src[k + 1] === '*') {
      const end = src.indexOf('*/', k + 2);
      if (end < 0) return src.length;
      k = end + 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`' || c === '(' || c === '[' || c === '{') {
      stack.push(c);
      continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      stack.pop();
      if (stack.length === 0) return k;
    }
  }
  return src.length;
}

/** End of an arrow's expression body from `j`: the first , ) ] } or ; at depth 0. */
function expressionEnd(text, j) {
  let k = j;
  while (k < text.length) {
    const c = text[k];
    if (c === "'" || c === '"' || c === '`' || c === '(' || c === '[' || c === '{') {
      k = closeOf(text, k) + 1;
      continue;
    }
    if (c === ',' || c === ')' || c === ']' || c === '}' || c === ';') return k;
    k += 1;
  }
  return k;
}

/**
 * The code that runs when `text` runs: nested listeners and nested
 * functions run later, if ever, so they are cut out.
 * @param {string} text
 */
export function immediateCode(text) {
  let out = '';
  let from = 0;
  const marker = /\.addEventListener\(|=>\s*|\bfunction\b[^(]*\(/g;
  let match;
  while ((match = marker.exec(text)) !== null) {
    if (match.index < from) continue;
    let cut;
    if (match[0].startsWith('.addEventListener')) {
      cut = closeOf(text, match.index + match[0].length - 1) + 1;
    } else if (match[0].startsWith('=>')) {
      const j = match.index + match[0].length;
      cut = text[j] === '{' ? closeOf(text, j) + 1 : expressionEnd(text, j);
    } else {
      const params = closeOf(text, match.index + match[0].length - 1);
      const brace = text.indexOf('{', params);
      cut = brace < 0 ? text.length : closeOf(text, brace) + 1;
    }
    out += text.slice(from, match.index);
    from = cut;
    marker.lastIndex = cut;
  }
  return out + text.slice(from);
}

/**
 * Every named function of the file — `function f(…) {…}` and
 * `const f = (…) => …` — by name, with its body.
 * @param {string} src
 */
function functionsOf(src) {
  /** @type {Map<string, string>} */
  const bodies = new Map();
  const declaration = /(?:async\s+)?function\s+(\w+)\s*\(|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>\s*/g;
  let match;
  while ((match = declaration.exec(src)) !== null) {
    const name = match[1] ?? match[2];
    let j = match.index + match[0].length;
    if (match[1]) j = closeOf(src, j - 1) + 1;
    while (/\s/.test(src[j] ?? '')) j += 1;
    const body = src[j] === '{' ? src.slice(j + 1, closeOf(src, j)) : src.slice(j, expressionEnd(src, j));
    bodies.set(name, `${bodies.get(name) ?? ''}\n${body}`);
  }
  return bodies;
}

/** @param {string} text @param {Map<string, string>} bodies */
function calledFunctions(text, bodies) {
  /** @type {Set<string>} */
  const names = new Set();
  for (const match of text.matchAll(/\b(\w+)\s*\(/g)) if (bodies.has(match[1])) names.add(match[1]);
  return names;
}

/**
 * The call chain from `text` to a write, or null.
 * @param {string} text @param {Map<string, string>} bodies @param {number} depth @param {Set<string>} seen
 * @returns {string[] | null}
 */
function writeChain(text, bodies, depth, seen) {
  const code = immediateCode(text);
  if (WRITE.test(code)) return [];
  if (depth === 0) return null;
  for (const name of calledFunctions(code, bodies)) {
    if (seen.has(name)) continue;
    seen.add(name);
    const rest = writeChain(bodies.get(name) ?? '', bodies, depth - 1, seen);
    if (rest !== null) return [name, ...rest];
  }
  return null;
}

/** @param {string} text @param {Map<string, string>} bodies @param {number} depth @param {Set<string>} seen */
function showsWait(text, bodies, depth, seen) {
  const code = immediateCode(text);
  if (BUSY.test(code)) return true;
  if (depth === 0) return false;
  for (const name of calledFunctions(code, bodies)) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (showsWait(bodies.get(name) ?? '', bodies, depth - 1, seen)) return true;
  }
  return false;
}

/** A handler's own code: the body after its arrow, or a call to the function it names. */
function handlerCode(argument) {
  const arrow = argument.match(/^\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>\s*/);
  if (arrow) {
    const j = arrow[0].length;
    return argument[j] === '{' ? argument.slice(j + 1, closeOf(argument, j)) : argument.slice(j);
  }
  const named = argument.trim().match(/^[\w.]*?(\w+)$/);
  return named ? `${named[1]}()` : argument;
}

/**
 * Every write button of one source file that shows no wait.
 * @param {string} src
 * @returns {Array<{ line: number, button: string, chain: string[] }>}
 */
export function writeButtonsWithoutWait(src) {
  const bodies = functionsOf(src);
  /** @type {Array<{ line: number, button: string, chain: string[] }>} */
  const found = [];
  for (const match of src.matchAll(/([\w.$]+)\.addEventListener\(\s*'(?:click|submit)'\s*,/g)) {
    const open = (match.index ?? 0) + match[1].length + '.addEventListener'.length;
    const argument = src.slice(open + 1, closeOf(src, open)).replace(/^\s*'(?:click|submit)'\s*,/, '');
    const code = handlerCode(argument);
    const chain = writeChain(code, bodies, WRITE_DEPTH, new Set());
    if (chain === null) continue;
    if (showsWait(code, bodies, BUSY_DEPTH, new Set())) continue;
    found.push({ line: src.slice(0, match.index).split('\n').length, button: match[1], chain });
  }
  return found;
}
