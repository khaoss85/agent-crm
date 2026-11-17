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
 * It is a source scan, deliberately simple. Followed: `function f` and
 * `const f = (…) =>` of the same file, the object or class methods of the
 * same file (`view.save()`, `drawer.moveView.start()`, `class C { save() }`,
 * read through their receiver, with `new` aliases), and the callbacks that
 * run with the press (.then/.catch/.finally, array walks, setTimeout, IIFE).
 * Not followed: functions of another module.
 * A wait found past the press's own helpers only counts when the path
 * reaches through one of the press's own methods: a wait painted that deep
 * by plain helpers belongs to another button's render, not to this press.
 */

const WRITE = /method: ['"](POST|PATCH|PUT|DELETE)['"]|submissions\.submit\(/;
const BUSY = /\buiBusy\(|\buiHold\(|\buiMarkBusy\(|['"]aria-busy['"]/;
const WRITE_DEPTH = 4;
const BUSY_DEPTH = 2;
const METHOD_BUSY_DEPTH = 5;
// Words that open `name (…) {` without defining a method.
const NOT_A_METHOD = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'with', 'do', 'else',
  'function', 'async', 'static', 'get', 'set', 'return', 'typeof', 'new',
]);

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
  const marker = /\.addEventListener\(|=>\s*|\bfunction\b[^(]*\(|[A-Za-z_$][\w$]*\s*\(/g;
  let match;
  while ((match = marker.exec(text)) !== null) {
    if (match.index < from) continue;
    // A shorthand method definition (`save() {…}`, `async save() {…}`) is a
    // definition, never press code: cut it whole. A call only looks the
    // same up to the `(` — leave calls alone.
    if (!match[0].startsWith('.addEventListener') && !match[0].startsWith('=>') && !match[0].startsWith('function')) {
      const name = match[0].slice(0, match[0].length - 1).trim();
      // Past the whole match: the tail of a keyword (`if (` leaves `f (`)
      // is never a definition of its own.
      if (NOT_A_METHOD.has(name)) {
        marker.lastIndex = match.index + match[0].length;
        continue;
      }
      const paren = match.index + match[0].length - 1;
      let k = closeOf(text, paren) + 1;
      while (/\s/.test(text[k] ?? '')) k += 1;
      if (text[k] !== '{') {
        marker.lastIndex = match.index + match[0].length;
        continue;
      }
      const cut = closeOf(text, k) + 1;
      if (runsWithThePress(text, match.index, cut)) {
        marker.lastIndex = match.index + match[0].length;
        continue;
      }
      const start = match.index < from ? from : match.index;
      out += text.slice(from, start);
      from = cut;
      marker.lastIndex = cut;
      continue;
    }
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
 * `const f = (…) => …` — by name, with its body. Object or class methods of
 * the same file join the same index under their own name AND owner:
 * `save() {…}` and `save: (…) => …` in literals, `class C { save() {…} }`,
 * and member assignments (`view.save = …`). A call reads its last segment
 * together with its receiver (`view.save()` calls `save` of `view`), so one
 * name may hold several bodies and a wait in `other.start()` never covers
 * `first.start()` (review Muse #974, P2).
 * @param {string} src
 * @returns {{ bodies: Map<string, Array<{ owner: string | null, body: string }>>, aliases: Map<string, string> }}
 */
function functionsOf(src) {
  /** @type {Map<string, Array<{ owner: string | null, body: string }>>} */
  const bodies = new Map();
  /** @param {string} name @param {string | null} owner @param {string} body */
  const add = (name, owner, body) => {
    if (NOT_A_METHOD.has(name)) return;
    const list = bodies.get(name) ?? [];
    list.push({ owner, body });
    bodies.set(name, list);
  };
  /**
   * Ranges of the literals and classes whose shorthand or `name:` methods
   * belong to a receiver: `const view = {…}`, `drawer.moveView = {…}` and
   * `class Editor {…}`. Innermost first.
   * @type {Array<{ owner: string, from: number, to: number }>}
   */
  const scopes = [];
  /** @param {RegExp} pattern @param {(match: RegExpMatchArray) => { owner: string, brace: number } | null} locate */
  const collectScopes = (pattern, locate) => {
    let match;
    while ((match = pattern.exec(src)) !== null) {
      const found = locate(match);
      if (found === null) continue;
      scopes.push({ owner: found.owner, from: found.brace, to: closeOf(src, found.brace) });
    }
  };
  collectScopes(/(?:const|let|var)\s+([\w$]+)\s*=\s*\{/g, (match) => ({
    owner: match[1], brace: match.index + match[0].length - 1,
  }));
  collectScopes(/((?:[\w$]+\.)+[\w$]+)\s*=\s*\{/g, (match) => ({
    owner: match[1], brace: match.index + match[0].length - 1,
  }));
  collectScopes(/\bclass\s+([\w$]+)[^{]*\{/g, (match) => ({
    owner: match[1], brace: match.index + match[0].length - 1,
  }));
  scopes.sort((a, b) => b.from - a.from);
  /** Owner of a definition at `index`: the innermost scope holding it, else null. */
  const ownerAt = (index) => scopes.find((scope) => index > scope.from && index < scope.to)?.owner ?? null;
  /** @param {number} paren @returns {string|null} the body inside the `{` after the params, or null */
  const bracedAfter = (paren) => {
    let j = closeOf(src, paren) + 1;
    while (/\s/.test(src[j] ?? '')) j += 1;
    return src[j] === '{' ? src.slice(j + 1, closeOf(src, j)) : null;
  };
  const declaration = /(?:async\s+)?function\s+(\w+)\s*\(|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>\s*/g;
  let match;
  while ((match = declaration.exec(src)) !== null) {
    const name = match[1] ?? match[2];
    let j = match.index + match[0].length;
    if (match[1]) j = closeOf(src, j - 1) + 1;
    while (/\s/.test(src[j] ?? '')) j += 1;
    const body = src[j] === '{' ? src.slice(j + 1, closeOf(src, j)) : src.slice(j, expressionEnd(src, j));
    add(name, null, body);
  }
  // `save: (…) => …` and `save: function …` in object literals.
  const property = /(\w+)\s*:\s*(?:async\s*)?(?:function\b\s*(?:\w+\s*)?\(|(?:\([^()]*\)|\w+)\s*=>\s*)/g;
  while ((match = property.exec(src)) !== null) {
    const name = match[1];
    if (NOT_A_METHOD.has(name)) continue;
    const tail = match[0].length;
    let j = match.index + tail;
    let body;
    if (/function\b/.test(match[0])) {
      body = bracedAfter(match.index + tail - 1);
      if (body === null) continue;
    } else {
      while (/\s/.test(src[j] ?? '')) j += 1;
      body = src[j] === '{' ? src.slice(j + 1, closeOf(src, j)) : src.slice(j, expressionEnd(src, j));
    }
    add(name, ownerAt(match.index), body);
  }
  // `view.save = (…) => …` and `view.save = function …`.
  const member = /((?:[\w$]+\.)+)(\w+)\s*=\s*(?:async\s*)?(?:function\b\s*(?:\w+\s*)?\(|(?:\([^()]*\)|\w+)\s*=>\s*)/g;
  while ((match = member.exec(src)) !== null) {
    const name = match[2];
    if (NOT_A_METHOD.has(name)) continue;
    const owner = match[1].replace(/\s+/g, '').replace(/\.$/, '');
    const tail = match.index + match[0].length;
    let body;
    if (/function\b/.test(match[0].slice(match[0].indexOf('=')))) {
      body = bracedAfter(tail - 1);
      if (body === null) continue;
    } else {
      let j = tail;
      while (/\s/.test(src[j] ?? '')) j += 1;
      body = src[j] === '{' ? src.slice(j + 1, closeOf(src, j)) : src.slice(j, expressionEnd(src, j));
    }
    add(name, owner, body);
  }
  // Shorthand methods of object literals and classes: `save() {…}`,
  // `async save() {…}`, `static save() {…}`. In valid code `name (…) {` is
  // always such a method, except for keywords and declarations.
  const shorthand = /([A-Za-z_$][\w$]*)\s*\(/g;
  while ((match = shorthand.exec(src)) !== null) {
    const name = match[1];
    if (NOT_A_METHOD.has(name)) continue;
    if (/function\s*\*?\s*$/.test(src.slice(Math.max(0, match.index - 16), match.index))) continue;
    const body = bracedAfter(match.index + match[0].length - 1);
    if (body === null) continue;
    add(name, ownerAt(match.index), body);
  }
  // `const editor = new Editor()`: a call to `editor.save()` reads the
  // methods of `Editor`.
  /** @type {Map<string, string>} */
  const aliases = new Map();
  const constructed = /(?:const|let|var)\s+([\w$]+)\s*=\s*new\s+([\w$]+)\s*\(/g;
  while ((match = constructed.exec(src)) !== null) {
    aliases.set(match[1], match[2]);
  }
  return { bodies, aliases };
}

/**
 * Receiver of a call, normalised (`drawer . moveView` → `drawer.moveView`).
 * @param {string | undefined} raw
 */
function normaliseReceiver(raw) {
  if (!raw) return null;
  return raw.replace(/\s+/g, '').replace(/\?/g, '').replace(/\.$/, '') || null;
}

/**
 * The bodies a call may run: when the call names its receiver, only the
 * methods of that receiver (through `new` aliases); otherwise every body
 * under the bare name, as the scan did before methods were followed.
 * @param {Map<string, Array<{ owner: string | null, body: string }>>} bodies
 * @param {Map<string, string>} aliases
 * @param {string | null} receiver
 * @param {string} name
 */
function candidatesFor(bodies, aliases, receiver, name) {
  const list = bodies.get(name) ?? [];
  if (receiver === null) {
    const plain = list.filter((entry) => entry.owner === null);
    return (plain.length > 0 ? plain : list).map((entry) => entry.body);
  }
  const target = aliases.get(receiver) ?? receiver;
  const owned = list.filter((entry) => entry.owner === target);
  return (owned.length > 0 ? owned : list).map((entry) => entry.body);
}

/**
 * Every call in `text` that resolves to an indexed body, with its receiver
 * (`view.save()` → `view`) and whether it reads as a method or a plain call.
 * @param {string} text @param {Map<string, Array<{ owner: string | null, body: string }>>} bodies
 * @returns {Array<{ name: string, receiver: string | null, isMethod: boolean }>}
 */
function calledFunctions(text, bodies) {
  /** @type {Array<{ name: string, receiver: string | null, isMethod: boolean }>} */
  const found = [];
  /** @type {Set<string>} */
  const seen = new Set();
  const call = /((?:[\w$]+(?:\s*\.\s*|\s*\?\.\s*))+)?([\w$]+)\s*(\?\.\s*)?\(/g;
  let match;
  while ((match = call.exec(text)) !== null) {
    const name = match[2];
    if (!bodies.has(name)) continue;
    const receiver = normaliseReceiver(match[1]);
    const key = `${receiver ?? ''}#${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ name, receiver, isMethod: receiver !== null || match[3] != null });
  }
  return found;
}

/**
 * The call chain from `text` to a write, or null.
 * @param {string} text @param {Map<string, Array<{ owner: string | null, body: string }>>} bodies
 * @param {Map<string, string>} aliases @param {number} depth @param {Set<string>} seen
 * @returns {string[] | null}
 */
function writeChain(text, bodies, aliases, depth, seen) {
  const code = immediateCode(text);
  if (WRITE.test(code)) return [];
  if (depth === 0) return null;
  for (const callee of calledFunctions(code, bodies)) {
    const candidates = candidatesFor(bodies, aliases, callee.receiver, callee.name);
    for (let i = 0; i < candidates.length; i += 1) {
      const key = `${callee.receiver ?? ''}#${callee.name}#${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const rest = writeChain(candidates[i], bodies, aliases, depth - 1, seen);
      if (rest !== null) return [callee.name, ...rest];
    }
  }
  return null;
}

/**
 * Whether the press shows it is waiting. The press's own helpers (two hops)
 * count as before; past them only a path through one of the press's own
 * object or class methods counts — a wait painted that deep by plain
 * helpers belongs to another button's render (a re-read paints its panels
 * aria-busy), not to this press.
 * @param {string} text @param {Map<string, Array<{ owner: string | null, body: string }>>} bodies
 * @param {Map<string, string>} aliases @param {number} level hops from the press @param {Set<string>} seen @param {boolean} wide the path reached through a method
 */
function showsWait(text, bodies, aliases, level, seen, wide) {
  const code = immediateCode(text);
  if (BUSY.test(code) && (wide || level <= BUSY_DEPTH)) return true;
  if (level >= METHOD_BUSY_DEPTH) return false;
  for (const callee of calledFunctions(code, bodies)) {
    const candidates = candidatesFor(bodies, aliases, callee.receiver, callee.name);
    for (let i = 0; i < candidates.length; i += 1) {
      const reachedWide = wide || callee.isMethod;
      const key = `${callee.receiver ?? ''}#${callee.name}#${i}:${level + 1}:${reachedWide ? 'wide' : 'plain'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (showsWait(candidates[i], bodies, aliases, level + 1, seen, reachedWide)) return true;
    }
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
  const { bodies, aliases } = functionsOf(src);
  /** @type {Array<{ line: number, button: string, chain: string[] }>} */
  const found = [];
  for (const match of src.matchAll(/([\w.$]+)\.addEventListener\(\s*(['"])(?:click|submit)\2\s*,/g)) {
    const open = (match.index ?? 0) + match[1].length + '.addEventListener'.length;
    const argument = src.slice(open + 1, closeOf(src, open)).replace(/^\s*(['"])(?:click|submit)\1\s*,/, '');
    const code = handlerCode(argument);
    const chain = writeChain(code, bodies, aliases, WRITE_DEPTH, new Set());
    if (chain === null) continue;
    if (showsWait(code, bodies, aliases, 0, new Set(), false)) continue;
    found.push({ line: src.slice(0, match.index).split('\n').length, button: match[1], chain });
  }
  return found;
}
