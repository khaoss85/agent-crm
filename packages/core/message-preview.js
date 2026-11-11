// @ts-check
/**
 * Narrow public entry of the kernel for message previews (Dan 10/11):
 * «Oggetto — estratto pulito», no URLs, markup, hidden preheaders or
 * boilerplate. Packages import it from here, never from `src/` (the
 * private-path rule), and not through `index.js`: every test imports the
 * index, so an export there would make every change to this one rule
 * select the whole suite. The /bo shell carries a byte-identical copy of
 * the source (apps/admin/public/admin-message-preview.js).
 */
export {
  MESSAGE_PREVIEW_CHARS,
  cleanMessageBody,
  cleanPreviewText,
  hasMarkup,
  htmlToText,
  isPlaceholderBody,
  messagePreview,
} from './src/message-preview.js';
