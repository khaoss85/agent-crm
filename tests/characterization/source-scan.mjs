/**
 * A source scanner that measures code instead of prose.
 *
 * The architecture-evidence observations answer questions like *who reads the
 * ambient field* and *who imports an Intelligence internal*. Two ADRs are
 * decided on those answers, so the measurement has to mean what it says.
 *
 * A substring `git grep` does not. It was wrong in both directions, and both
 * were demonstrated rather than suspected:
 *
 * - **False positives.** A file whose only mention of `app.intelligence` is a
 *   comment, a string or a template literal was counted as a consumer. This
 *   already happened in the checked-in baseline: writing an ADR that names the
 *   field it decides about added `DECISIONS.md` to the list of files that read
 *   it. Excluding Markdown fixed that one document and left the class intact —
 *   a line comment in a `.js` file still counted.
 * - **False negatives.** `app['intelligence']`, `app?.intelligence`, a read
 *   split across a line break, and `const { intelligence } = app` are all real
 *   consumers that a `app.intelligence` substring never matches. An evidence
 *   list that a consumer can leave by changing its punctuation is not evidence.
 *
 * This is deliberately a lexical scanner and not a parser. The repository has
 * no parser dependency and this does not justify one: the question is "which
 * files mention this in code", and stripping comments and literals answers it
 * for every form that appears here. It is bounded, and its bounds are stated
 * in `SCANNER_LIMITS` and published with the observations that use it.
 */

/**
 * Remove everything that is not executable code: line comments, block
 * comments, and string, template and regex literals. What remains is code, so
 * a match in it is a real reference.
 *
 * Written as a single left-to-right pass because comment and literal syntax
 * nest inside each other — a `//` inside a string does not start a comment,
 * and a `'` inside a comment does not start a string. Anything removed is
 * replaced by a space so line and token boundaries survive.
 *
 * @param {string} source
 * @returns {string}
 */
export function stripNonCode(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  /** The previous meaningful code character, used to tell division from regex. */
  let prev = '';
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (c === '/' && next === '*') {
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) { out += source[i] === '\n' ? '\n' : ' '; i += 1; }
      out += '  '; i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += ' '; i += 1;
      while (i < n) {
        if (source[i] === '\\') { out += '  '; i += 2; continue; }
        if (source[i] === quote) { out += ' '; i += 1; break; }
        // A template substitution contains real code; keep it.
        if (quote === '`' && source[i] === '$' && source[i + 1] === '{') {
          out += '  '; i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            if (source[i] === '{') depth += 1;
            if (source[i] === '}') { depth -= 1; if (depth === 0) { out += ' '; i += 1; break; } }
            out += source[i]; i += 1;
          }
          continue;
        }
        out += source[i] === '\n' ? '\n' : ' '; i += 1;
      }
      prev = quote;
      continue;
    }
    // A regex literal, distinguished from division by what precedes it.
    if (c === '/' && !')]}'.includes(prev) && !/[\w$]/.test(prev)) {
      out += ' '; i += 1;
      let inClass = false;
      while (i < n && source[i] !== '\n') {
        if (source[i] === '\\') { out += '  '; i += 2; continue; }
        if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        else if (source[i] === '/' && !inClass) { out += ' '; i += 1; break; }
        out += ' '; i += 1;
      }
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return out;
}

/**
 * Remove comments only, keeping string and template literals intact.
 *
 * Two kinds of evidence live *inside* a literal and are still real: a computed
 * property key (`app['intelligence']` — the key is a string by definition), and
 * a generated import (the starter installer writes an import statement into a
 * file as a string). Stripping literals would destroy both, so these are read
 * from a source that keeps them and loses only the comments.
 *
 * @param {string} source
 * @returns {string}
 */
export function stripComments(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (c === '/' && next === '*') {
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) { out += source[i] === '\n' ? '\n' : ' '; i += 1; }
      out += '  '; i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c; i += 1;
      while (i < n) {
        if (source[i] === '\\') { out += source.slice(i, i + 2); i += 2; continue; }
        out += source[i];
        if (source[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    out += c; i += 1;
  }
  return out;
}

/**
 * Does this source really read `<object>.<property>`, in any form JavaScript
 * offers? Dotted access, optional chaining, a computed string key, a read split
 * across lines, and destructuring out of the named object all count.
 *
 * @param {string} source raw source; comments and literals are stripped here
 * @param {string} object e.g. `app`
 * @param {string} property e.g. `intelligence`
 */
export function readsProperty(source, object, property) {
  const code = stripNonCode(source);
  const obj = escapeRe(object);
  const prop = escapeRe(property);
  // Forms whose evidence is code: prose mentioning them must not count.
  const inCode = [
    // app.intelligence / app?.intelligence, tolerating whitespace and newlines
    new RegExp(`\\b${obj}\\s*\\??\\.\\s*${prop}\\b`),
    // const { intelligence } = app  (also `{ intelligence: x } = app`)
    new RegExp(`\\{[^{}]*\\b${prop}\\b[^{}]*\\}\\s*=\\s*${obj}\\b`),
  ];
  if (inCode.some((re) => re.test(code))) return true;
  // A computed key IS a string literal, so it cannot be found in a source
  // whose literals were removed. Read it from one that kept them; the bracket
  // and the quotes together make a prose false positive implausible.
  const computed = new RegExp(`\\b${obj}\\s*\\??\\[\\s*['"]${prop}['"]\\s*\\]`);
  return computed.test(stripComments(source));
}

/**
 * Does this source really import from a module whose specifier matches?
 * Matches `import ... from '<spec>'`, `export ... from '<spec>'`, and dynamic
 * `import('<spec>')` — and nothing in a comment or an unrelated string.
 *
 * The specifier is matched against the *quoted* text, so this deliberately
 * still sees a specifier that is built as a string, which is what the starter
 * installer does when it writes an import into a generated file.
 *
 * @param {string} source
 * @param {RegExp} specifier applied to the quoted module specifier
 */
export function importsFrom(source, specifier) {
  const code = stripComments(source);
  const found = [];
  // Anchored at a statement boundary, or immediately inside a quote — the
  // second because the starter installer writes an import statement into a
  // generated file as a string, which is a real dependency of a different
  // kind. Prose like `"imported from './x.js' once"` matches neither, because
  // both forms require `import` or `export` as the first token.
  const statements = [
    /(?:^|[;{}\n]|['"`])\s*import\s[^;'"`]*?\bfrom\s*(['"])([^'"]+)\1/g,
    /(?:^|[;{}\n]|['"`])\s*export\s[^;'"`]*?\bfrom\s*(['"])([^'"]+)\1/g,
    /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
  ];
  for (const re of statements) {
    let m;
    while ((m = re.exec(code))) if (specifier.test(m[2])) found.push(m[2]);
  }
  return [...new Set(found)];
}

/** What this scanner does not claim, published with every observation using it. */
export const SCANNER_LIMITS = Object.freeze([
  'LEXICAL_NOT_SYNTACTIC — comments and literals are stripped, but no AST is built',
  'ALIASING_NOT_TRACKED — a consumer that copies the field to another name first is not followed',
  'DYNAMIC_KEYS_NOT_RESOLVED — a computed property name built at runtime is not evaluated',
]);

/** @param {string} value */
function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
