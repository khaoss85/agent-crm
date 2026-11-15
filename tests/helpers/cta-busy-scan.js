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
 * It is a source scan, deliberately simple. Followed: `function f`,
 * `const f = (…) =>` of the same file, and the callbacks that run with the
 * press (.then/.catch/.finally, array walks, setTimeout, IIFE). Not
 * followed: functions of another module, and object or class methods
 * (`view.save()`, `drawer.moveView.start()`) — those buttons are listed by
 * hand in the guard.
 */

const WRITE = /method: ['"](POST|PATCH|PUT|DELETE)['"]|submissions\.submit\(/;
const BUSY = /\buiBusy\(|\buiHold\(|\buiMarkBusy\(|['"]aria-busy['"]/;
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
 * Start of the arrow whose `=>` is at `arrowAt`: its parameter list (or
 * single name), with a leading `async`.
 * @param {string} text @param {number} arrowAt
 */
function arrowStart(text, arrowAt) {
  let k = arrowAt - 1;
  while (k >= 0 && /\s/.test(text[k])) k -= 1;
  if (text[k] === ')') {
    let depth = 0;
    for (; k >= 0; k -= 1) {
      if (text[k] === ')') depth += 1;
      else if (text[k] === '(') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
  } else {
    while (k > 0 && /[\w$]/.test(text[k - 1])) k -= 1;
  }
  const before = text.slice(0, k);
  const asyncWord = before.match(/\basync\s*$/);
  return asyncWord ? k - asyncWord[0].length : k;
}

/**
 * Review Muse #831 (P2): a callback that runs as part of the press — a
 * promise continuation, an array walk, a timer, an IIFE — is the press's own
 * code, so its body stays in. Only these shapes are kept; any other nested
 * function (a handler handed to a builder, an assigned arrow) runs later,
 * if ever.
 * @param {string} text @param {number} start @param {number} end
 */
function runsWithThePress(text, start, end) {
  const before = text.slice(Math.max(0, start - 60), start);
  if (/(?:\.(?:then|catch|finally|forEach|map|flatMap|filter|reduce|some|every|find)|\b(?:setTimeout|queueMicrotask))\(\s*$/.test(before)) return true;
  // (async () => { … })() — an IIFE.
  return /\(\s*$/.test(before) && /^\s*\)\s*\(/.test(text.slice(end));
}

/**
 * The code that runs when `text` runs: nested listeners run later, and so
 * do nested functions — except the callbacks that run as part of the press
 * (runsWithThePress), which stay in.
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
    let start = match.index;
    if (match[0].startsWith('.addEventListener')) {
      cut = closeOf(text, match.index + match[0].length - 1) + 1;
    } else if (match[0].startsWith('=>')) {
      const j = match.index + match[0].length;
      cut = text[j] === '{' ? closeOf(text, j) + 1 : expressionEnd(text, j);
      start = arrowStart(text, match.index);
    } else {
      const params = closeOf(text, match.index + match[0].length - 1);
      const brace = text.indexOf('{', params);
      cut = brace < 0 ? text.length : closeOf(text, brace) + 1;
      const asyncWord = text.slice(0, match.index).match(/\basync\s*$/);
      if (asyncWord) start = match.index - asyncWord[0].length;
    }
    if (!match[0].startsWith('.addEventListener') && runsWithThePress(text, start, cut)) continue;
    if (start < from) start = from;
    out += text.slice(from, start);
    from = cut;
    marker.lastIndex = cut;
  }
  return out + text.slice(from);
}

/**
 * The source with comments blanked (review Muse #831, P3): a comment that
 * mentions aria-busy or a POST never counts. Strings are kept.
 * @param {string} src
 */
export function withoutComments(src) {
  let out = '';
  let k = 0;
  while (k < src.length) {
    const c = src[k];
    if (c === "'" || c === '"' || c === '`') {
      const end = closeOf(src, k);
      out += src.slice(k, end + 1);
      k = end + 1;
      continue;
    }
    if (c === '/' && src[k + 1] === '/') {
      const end = src.indexOf('\n', k);
      k = end < 0 ? src.length : end;
      continue;
    }
    if (c === '/' && src[k + 1] === '*') {
      const end = src.indexOf('*/', k + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(k, stop).replace(/[^\n]/g, ' ');
      k = stop;
      continue;
    }
    out += c;
    k += 1;
  }
  return out;
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
  const head = argument.match(/^\s*(?:async\s*)?/)?.[0] ?? '';
  let afterParams = -1;
  if (argument[head.length] === '(') afterParams = closeOf(argument, head.length) + 1;
  else {
    const name = argument.slice(head.length).match(/^\w+/);
    if (name) afterParams = head.length + name[0].length;
  }
  const arrow = afterParams < 0 ? null : argument.slice(afterParams).match(/^\s*=>\s*/);
  if (arrow) {
    const j = afterParams + arrow[0].length;
    return argument[j] === '{' ? argument.slice(j + 1, closeOf(argument, j)) : argument.slice(j);
  }
  const named = argument.trim().match(/^[\w.]*?(\w+)$/);
  return named ? `${named[1]}()` : argument;
}

/**
 * Every write button of one source file that shows no wait.
 * @param {string} raw
 * @returns {Array<{ line: number, button: string, chain: string[] }>}
 */
export function writeButtonsWithoutWait(raw) {
  const src = withoutComments(raw);
  const bodies = functionsOf(src);
  /** @type {Array<{ line: number, button: string, chain: string[] }>} */
  const found = [];
  for (const match of src.matchAll(/([\w.$]+)\.addEventListener\(\s*(['"])(?:click|submit)\2\s*,/g)) {
    const open = (match.index ?? 0) + match[1].length + '.addEventListener'.length;
    const argument = src.slice(open + 1, closeOf(src, open)).replace(/^\s*(['"])(?:click|submit)\1\s*,/, '');
    const code = handlerCode(argument);
    const chain = writeChain(code, bodies, WRITE_DEPTH, new Set());
    if (chain === null) continue;
    if (showsWait(code, bodies, BUSY_DEPTH, new Set())) continue;
    found.push({ line: src.slice(0, match.index).split('\n').length, button: match[1], chain });
  }
  return found;
}
