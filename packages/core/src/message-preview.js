// @ts-check
/**
 * Message previews that read like a mail client list (Dan 10/11): «Oggetto
 * — estratto pulito», never raw URLs, HTML residue, hidden preheaders,
 * decorative rules or the boilerplate lines newsletters open with.
 *
 * One rule for every preview: the Clienti row, the Oggi inbox and brief,
 * the Assistente lines, and the Gmail reader that picks the stored body.
 * The cleaning runs when a text is shown, so messages already stored read
 * clean too; the full body in the scheda keeps its text and loses only
 * markup residue (`htmlToText` on a body that carries markup).
 *
 * Pure and import-free on purpose: the /bo shell cannot import packages,
 * so this file ships twice, byte-identical — the core source
 * (packages/core/src/message-preview.js) and the shell copy
 * (apps/admin/public/admin-message-preview.js). The preview test fails
 * when the two differ. Regex literals spell quotes as \x22 and \x27: the
 * shell bundler reads quotes as string starts.
 */

/** Default bound of a preview, the Clienti cell's (LAST_CONTACT_PREVIEW_CHARS). */
export const MESSAGE_PREVIEW_CHARS = 140;

/** Inline styles that hide an element: the preheader trick newsletters use. */
const HIDDEN_STYLE = '(?:display\\s*:\\s*none|visibility\\s*:\\s*hidden|max-height\\s*:\\s*0(?![.\\d])|opacity\\s*:\\s*0(?![.\\d])|font-size\\s*:\\s*0(?![.\\d]))';
/** One tag attribute or bare tag text, quote-aware: a `>` inside a value never ends the tag. */
const IN_TAG = '(?:[^>\\x22\\x27]|\\x22[^\\x22]*\\x22|\\x27[^\\x27]*\\x27)';
/**
 * An element hidden by its inline style or its `hidden` attribute, content
 * included. Best effort on nesting: the element ends at the first closing
 * tag of the same name.
 */
const HIDDEN_ELEMENT_RE = new RegExp(
  '<([a-zA-Z][\\w-]*)\\b' + IN_TAG + '*?'
  + '(?:\\sstyle\\s*=\\s*(?:\\x22[^\\x22]*' + HIDDEN_STYLE + '[^\\x22]*\\x22|\\x27[^\\x27]*' + HIDDEN_STYLE + '[^\\x27]*\\x27)'
  + '|\\shidden(?=[\\s/>=]))'
  + IN_TAG + '*>[\\s\\S]*?<\\/\\1\\s*>',
  'gi',
);
/**
 * A tag name, then a space, `/` or `>`: `<mario@example.com>` and
 * `<https://…>` are not tags and stay text.
 */
const TAG_NAME = '[a-zA-Z][\\w-]*(?::[\\w-]+)?(?=[\\s/>])';
/** A whole tag, quote-aware. */
const TAG_RE = new RegExp('<\\/?' + TAG_NAME + IN_TAG + '*>', 'g');
/** A tag cut by a length fence: `<div style=…` with no `>` until the end. */
const CUT_TAG_RE = /<\/?[a-zA-Z][\w-]*(?:\s[^<>]*)?$/;
const BLOCK_OPEN_RE = /<(p|div|li|tr|table|blockquote|h[1-6])(?=[\s/>])/gi;
const BLOCK_CLOSE_RE = /<\/(p|div|li|tr|table|blockquote|h[1-6])\s*>/gi;
const BREAK_RE = /<br\b[^<>]*>/gi;
/**
 * Attribute residue left in stored text by an older stripper: `id="…"
 * style="…" data-…="…">` with no tag around it. Only HTML attribute names
 * count, never a generic `word="…"`, so quoted prose survives. A value cut
 * by a length fence (no closing quote) still counts up to the end.
 */
const ATTRIBUTE_NAMES = '(?:id|class|style|width|height|align|valign|bgcolor|background|border|cellpadding|cellspacing|role|dir|lang|href|src|alt|target|rel|colspan|rowspan|data-[\\w-]+|aria-[\\w-]+|xmlns(?::\\w+)?)';
const ATTRIBUTE = ATTRIBUTE_NAMES + '\\s*=\\s*(?:\\x22[^\\x22]*(?:\\x22|$)|\\x27[^\\x27]*(?:\\x27|$))';
const ATTRIBUTE_RESIDUE_RE = new RegExp('(^|[\\s>])' + ATTRIBUTE + '(?:\\s+' + ATTRIBUTE + ')*\\s*\\/?>?', 'gi');
/** Any sign of markup: a tag, a cut tag or attribute residue. */
const MARKUP_HINT_RE = new RegExp('<\\/?' + TAG_NAME + '|<\\/?[a-zA-Z][\\w-]*$|(?:^|\\s)' + ATTRIBUTE_NAMES + '\\s*=\\s*[\\x22\\x27]', 'i');

const NAMED_ENTITIES = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '\u0022', apos: '\u0027', nbsp: ' ',
  laquo: '«', raquo: '»', hellip: '…', ndash: '–', mdash: '—', euro: '€',
  rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201d', ldquo: '\u201c', copy: '©', reg: '®', trade: '™',
});

/** `<…url…>`, `[…url…]`, `(…url…)` and bare URLs, `mailto:` included. */
const URL_START = '(?:https?:\\/\\/|www\\.|mailto:)';
const URL_RES = Object.freeze([
  new RegExp('<\\s*' + URL_START + '[^>\\s]*\\s*>?', 'gi'),
  new RegExp('\\[\\s*' + URL_START + '[^\\]\\s]*\\s*\\]?', 'gi'),
  new RegExp('\\(\\s*' + URL_START + '[^)\\s]*\\s*\\)?', 'gi'),
  new RegExp(URL_START + '\\S+', 'gi'),
]);
/** Image placeholders: `[image: Logo]`, `[immagine: …]` and markdown `![alt](src)`. */
const IMAGE_RES = Object.freeze([
  /\[\s*(?:image|immagine|img|logo)\s*:[^\]]*\]/gi,
  /!\[[^\]]*\]\([^)]*\)/g,
]);
/** Rows of `*`, `=`, `_`, `~`, `#`, `-` or box drawing: four or more, single spaces allowed. */
const DECORATIVE_RE = /(?:[*=_~#\u2500-\u257f-][ \t]?){4,}/g;
/**
 * Service lines newsletters open with, Italian and English. Whole phrases
 * only, so a customer writing about «la versione web» keeps their words.
 */
const SERVICE_PHRASE_RES = Object.freeze([
  /\bse non (?:riesci a )?(?:visualizzi|vedi|leggi)(?: correttamente)?(?: (?:questa|la|il|questo) (?:e-?mail|mail|messaggio|newsletter|comunicazione))?(?: correttamente)?(?: o le immagini)?[,:]?(?: (?:clicca|apri|visualizza|vai)(?: qui| sul link)?(?: per (?:visualizzarla|vederla|aprirla|leggerla)| per visualizzare (?:la|questa) (?:e-?mail|mail|newsletter|versione (?:web|online)))?(?: (?:online|nel (?:tuo )?browser|sul web))?)?[.!:]?/gi,
  /\b(?:visualizza|apri|leggi|vedi) (?:la |questa )?(?:versione (?:web|online)(?: (?:della|di questa) (?:e-?mail|mail|newsletter))?|(?:e-?mail|mail|newsletter|messaggio) (?:nel (?:tuo )?browser|online|sul web|come pagina web))[.!:]?/gi,
  /\b(?:clicca|click) (?:qui|here) (?:per (?:visualizzarla|vederla|leggerla)(?: (?:online|nel (?:tuo )?browser))?|to view (?:it |this (?:e-?mail|message) )?(?:in (?:your |a )?(?:web )?browser|online))[.!:]?/gi,
  /\b(?:having )?trouble viewing this (?:e-?mail|message)\??/gi,
  /\b(?:please )?view this (?:e-?mail|message) in an? html[- ]capable (?:e-?mail )?(?:client|reader)\.?/gi,
  /\bview (?:this (?:e-?mail|message|newsletter) )?(?:in (?:your |a )?(?:web )?browser|as a web ?page)[.!:]?/gi,
  /\bview (?:this |the )?(?:e-?mail|message|newsletter) online[.!:]?/gi,
]);
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200d\u2060\ufeff\u00ad\u034f]/g;

/**
 * HTML to readable text, line breaks kept: comments, scripts, styles,
 * head, hidden elements (preheaders) gone; blocks broken; tags removed
 * quote-aware; a tag cut at the end removed; attribute residue removed.
 * Entities stay encoded — each reader decodes them its own way.
 * @param {unknown} html
 * @returns {string}
 */
export function htmlToText(html) {
  if (html === null || html === undefined) return '';
  return String(html)
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<(script|style|head|title|template)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(HIDDEN_ELEMENT_RE, '')
    .replace(BREAK_RE, '\n')
    .replace(BLOCK_OPEN_RE, '\n<$1')
    .replace(BLOCK_CLOSE_RE, '\n')
    .replace(TAG_RE, '')
    .replace(CUT_TAG_RE, '')
    .replace(ATTRIBUTE_RESIDUE_RE, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * True when the text carries markup a reader should never see: a tag, a
 * tag cut at the end, or attribute residue (`style="…"`).
 * @param {unknown} value
 */
export function hasMarkup(value) {
  return typeof value === 'string' && MARKUP_HINT_RE.test(value);
}

/**
 * A full message body for reading: unchanged unless it carries markup,
 * then `htmlToText` (line breaks, URLs and the rest of the text stay).
 * @param {unknown} value
 * @returns {string}
 */
export function cleanMessageBody(value) {
  if (typeof value !== 'string') return '';
  return hasMarkup(value) ? htmlToText(value).trim() : value;
}

/** @param {string} text */
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    const key = name.toLowerCase();
    return Object.hasOwn(NAMED_ENTITIES, key) ? NAMED_ENTITIES[/** @type {keyof typeof NAMED_ENTITIES} */ (key)] : whole;
  });
}

/**
 * Any message text to one clean line for a preview: markup and hidden
 * preheaders out, entities decoded, URLs (bare, `<…>`, `[…]`, `(…)`) and
 * image placeholders out, decorative rows out, the known service lines
 * out, whitespace collapsed. '' when nothing readable remains.
 * @param {unknown} value
 * @returns {string}
 */
export function cleanPreviewText(value) {
  if (typeof value !== 'string' || value === '') return '';
  let text = decodeEntities(htmlToText(value)).replace(CONTROL_RE, ' ');
  for (const re of IMAGE_RES) text = text.replace(re, ' ');
  for (const re of URL_RES) text = text.replace(re, ' ');
  text = text.replace(DECORATIVE_RE, ' ');
  for (const re of SERVICE_PHRASE_RES) text = text.replace(re, ' ');
  return text
    .replace(/\(\s*\)|\[\s*\]|<\s*>/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/(?:\s*[|•·]\s*){2,}/g, ' | ')
    .replace(/^[\s|•·:,;–—-]+|[\s|•·:,;–—-]+$/g, '');
}

/**
 * True when a stored body is a stand-in rather than the message: nothing
 * readable after `cleanPreviewText`, or links make up at least half of its
 * visible characters (a plain part that is a list of tracking URLs).
 * @param {unknown} value
 */
export function isPlaceholderBody(value) {
  if (typeof value !== 'string') return true;
  if (cleanPreviewText(value) === '') return true;
  const visible = value.replace(/\s+/g, '').length;
  const links = (value.match(new RegExp(URL_START + '\\S+', 'gi')) ?? []).join('').length;
  return visible > 0 && links * 2 >= visible;
}

/**
 * The preview line of a message, like a mail client: «Oggetto — estratto»
 * when the message has a subject, the clean excerpt otherwise, the subject
 * alone when the body cleans to nothing. A body that opens with its own
 * subject does not repeat it. Bounded to `max` characters, an ellipsis
 * included. '' when there is nothing to show.
 * @param {unknown} body
 * @param {{ subject?: unknown, max?: number }} [options]
 * @returns {string}
 */
export function messagePreview(body, options = {}) {
  const max = Number.isInteger(options.max) && /** @type {number} */ (options.max) > 1
    ? /** @type {number} */ (options.max) : MESSAGE_PREVIEW_CHARS;
  const subject = cleanPreviewText(options.subject);
  let excerpt = cleanPreviewText(body);
  // Only a whole-word repeat: «Ricevuta» never eats the start of «Ricevuta del…».
  if (subject !== '' && excerpt.toLowerCase().startsWith(subject.toLowerCase())
    && (excerpt.length === subject.length || /[\s|•·:,;.!?–—-]/.test(excerpt[subject.length]))) {
    excerpt = excerpt.slice(subject.length).replace(/^[\s|•·:,;.!?–—-]+/, '');
  }
  const line = subject !== '' && excerpt !== '' ? `${subject} — ${excerpt}` : (subject || excerpt);
  if (line.length <= max) return line;
  return `${line.slice(0, max - 1).trimEnd()}…`;
}
