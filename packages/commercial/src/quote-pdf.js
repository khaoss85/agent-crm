// @ts-check

import { createHash } from 'node:crypto';
import { AppError, ValidationError } from '../../core/index.js';
import { TERMS_SNAPSHOT_AMBIGUOUS, verifySelfConsistent } from './verify-terms.js';

/**
 * Frozen-version quote PDF (accordo BO-F2-03): subtotale, IVA and totale
 * per commercial period, all read from the frozen version — never the draft.
 *
 * The backoffice "06 Pipeline" scheda Offerta previews the quote as a PDF.
 * That preview must render the FROZEN quote version — the immutable rows
 * `quote.submit` wrote — never the live draft, which keeps moving after the
 * version exists. This module does exactly that split:
 *
 *   readQuoteVersionEvidence(services, versionId) — collects every frozen row
 *     of one quote version (version, lines, components, totals, terms) into a
 *     plain, JSON-able evidence object. It reads version rows only. A present
 *     term snapshot is verified with the package's own verifier before it is
 *     rendered: a corrupt or ambiguous snapshot refuses, so the document never
 *     presents an unverified term as signed.
 *   renderQuoteVersionPdf(evidence) — renders that evidence to deterministic
 *     PDF 1.4 bytes (uncompressed text, Helvetica), with a sha256 document
 *     hash over the canonical evidence bytes.
 *
 * Deliberately dependency-free: no PDF library, no timestamps and no random
 * ids inside the bytes, so the same frozen version always renders the same
 * bytes. What it reuses, per MEM_ACC_REUSE: the frozen rows `quote.submit`
 * already writes (quote-version, quote-version-line,
 * quote-version-component, quote-version-total, quote-version-term), the
 * same byte-order discipline the signature document package uses
 * (locale-independent ordering, never `localeCompare`), the frozen VAT view
 * inside the version row's `totalsJson` (rate and amounts pinned at submit,
 * never read from the live catalog), and the integer-cents money vocabulary
 * of `./money.js`.
 *
 * What it does NOT do (follow-ups, named in the PR): AI-suggested lines,
 * and wiring as a `quote.preview-pdf` action.
 */

/**
 * @typedef {object} QuoteVersionPdfServices
 * @property {{ get: (id: string) => any }} versions quote-version record service
 * @property {{ listWhere: (query: any) => any[] }} lines quote-version-line record service
 * @property {{ listWhere: (query: any) => any[] }} components quote-version-component record service
 * @property {{ listWhere: (query: any) => any[] }} totals quote-version-total record service
 * @property {{ listWhere: (query: any) => any[] } | null} [terms] quote-version-term record service, or null when the manifest is not composed
 */

/**
 * Locale-independent byte order (the signature document package uses the
 * same discipline so hashes never depend on the host's ICU data).
 * @param {string} a @param {string} b
 */
function byteOrder(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Parse the frozen VAT view out of a version row's totalsJson. Anything
 * malformed degrades to null (a pre-VAT version), never throws: the rows
 * above are the authoritative frozen amounts, the view only adds tax.
 * @param {unknown} totalsJson
 */
function frozenVatView(totalsJson) {
  if (typeof totalsJson !== 'string' || totalsJson === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(totalsJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.vat || typeof parsed.vat !== 'object') {
    return null;
  }
  // The rate is a server-frozen basis-points figure; anything outside the
  // 0–10000 range is not a rate this document knows how to print, so the
  // version renders as pre-VAT rather than inventing tax.
  if (!Number.isInteger(parsed.vatRateBps) || parsed.vatRateBps < 0 || parsed.vatRateBps > 10_000) {
    return null;
  }
  if (!parsed.vat.oneTime || typeof parsed.vat.oneTime !== 'object' || !Array.isArray(parsed.vat.recurring)) {
    return null;
  }
  const keyOf = (entry) => `${entry?.currency ?? ''}|${entry?.interval ?? ''}|${entry?.intervalCount ?? ''}`;
  const recurringByKey = new Map();
  for (const entry of parsed.vat.recurring) {
    if (entry && typeof entry === 'object' && Number.isSafeInteger(entry.vatAmountCents) && Number.isSafeInteger(entry.grossAmountCents)) {
      recurringByKey.set(keyOf(entry), { vatAmountCents: entry.vatAmountCents, grossAmountCents: entry.grossAmountCents });
    }
  }
  const oneTime = parsed.vat.oneTime;
  if (!Number.isSafeInteger(oneTime.vatAmountCents) || !Number.isSafeInteger(oneTime.grossAmountCents)) return null;
  return {
    rateBps: parsed.vatRateBps,
    oneTime: { vatAmountCents: oneTime.vatAmountCents, grossAmountCents: oneTime.grossAmountCents },
    recurringByKey,
  };
}

/**
 * The frozen tax figures for one evidence total, or nulls when the version
 * predates VAT. Matched from the frozen view by commercial period — never
 * recomputed from the live catalog.
 */
function frozenTaxFor(frozenVat, total) {
  if (!frozenVat) return { vatAmountCents: null, grossAmountCents: null };
  if (total.kind === 'one_time') return { ...frozenVat.oneTime };
  const entry = frozenVat.recurringByKey.get(`${total.currency ?? ''}|${total.interval ?? ''}|${total.intervalCount ?? ''}`);
  if (!entry) return { vatAmountCents: null, grossAmountCents: null };
  return { ...entry };
}

/**
 * Collect the frozen evidence of one quote version. Reads version rows only —
 * never the draft quote, its lines, or the live catalog — so the evidence
 * cannot move after the version exists.
 * @param {QuoteVersionPdfServices} services
 * @param {string} versionId
 */
export async function readQuoteVersionEvidence(services, versionId) {
  if (!services || typeof services !== 'object') {
    throw new ValidationError('readQuoteVersionEvidence needs the quote-version record services', { field: 'services' });
  }
  if (typeof versionId !== 'string' || versionId === '') {
    throw new ValidationError('versionId must be a non-empty string', { field: 'versionId' });
  }
  const version = await services.versions?.get(versionId);
  if (!version) {
    throw new AppError(`No quote version "${versionId}"`, { code: 'VERSION_NOT_FOUND', status: 404 });
  }
  const lines = (await services.lines.listWhere({ versionId: version.id }))
    .sort((a, b) => (a.position === b.position ? byteOrder(a.id, b.id) : a.position - b.position));
  if (lines.length === 0) {
    throw new AppError('The quote version carries no frozen lines', { code: 'VERSION_SNAPSHOT_INCOMPLETE', status: 409 });
  }
  const components = await services.components.listWhere({ versionId: version.id });
  const totals = (await services.totals.listWhere({ versionId: version.id }))
    .sort((a, b) => byteOrder(
      `${a.kind}|${a.interval ?? ''}|${a.intervalCount ?? ''}`,
      `${b.kind}|${b.interval ?? ''}|${b.intervalCount ?? ''}`,
    ));
  if (totals.length === 0) {
    throw new AppError('The quote version carries no frozen totals', { code: 'VERSION_SNAPSHOT_INCOMPLETE', status: 409 });
  }
  // The frozen VAT view rides inside the version row's totalsJson (pinned at
  // submit, same transaction as the rows above). A version frozen before VAT
  // carries no view and renders no VAT section, exactly as before — the
  // evidence never derives tax from the live catalog.
  const frozenVat = frozenVatView(version.totalsJson);
  const termRows = services.terms ? await services.terms.listWhere({ versionId: version.id }) : [];
  // The document below prints the term and hashes it into the document hash,
  // so it presents the term as signed evidence. It therefore verifies the
  // frozen snapshot with the package's own verifier first — the same check
  // `commercial-quotes@2` runs — and refuses a corrupt or ambiguous snapshot
  // instead of rendering it. A version that predates terms carries no row and
  // renders without a terms section, exactly as before.
  if (termRows.length > 1) {
    throw new AppError(
      'This quote version carries more than one signed-term snapshot, so the rendered terms cannot be decided from the evidence',
      { code: TERMS_SNAPSHOT_AMBIGUOUS, status: 409, details: { quoteVersionId: version.id, count: termRows.length } },
    );
  }
  const verifiedTerm = termRows.length === 1
    ? verifySelfConsistent(termRows[0], { kind: 'quoteVersion', id: version.id })
    : null;
  return {
    version: {
      id: version.id,
      versionNumber: version.versionNumber,
      quoteId: version.quoteId,
      opportunityId: version.opportunityId ?? null,
      priceBookId: version.priceBookId,
      currency: version.currency,
      submittedAt: version.submittedAt,
      submittedBy: version.submittedBy ?? null,
      policy: version.policy ?? null,
      policyVersion: version.policyVersion ?? null,
      policyDecision: version.policyDecision ?? null,
      maxLineDiscountBps: version.maxLineDiscountBps ?? null,
      effectiveDiscountBps: version.effectiveDiscountBps ?? null,
      vatRateBps: frozenVat?.rateBps ?? null,
    },
    lines: lines.map((line) => ({
      offerName: line.offerName ?? null,
      offerLogicalKey: line.offerLogicalKey ?? null,
      offerRevision: line.offerRevision ?? null,
      sku: line.sku ?? null,
      quantity: line.quantity,
      discountBps: line.discountBps ?? 0,
      position: line.position,
      listAmountCents: line.listAmountCents,
      discountAmountCents: line.discountAmountCents,
      netAmountCents: line.netAmountCents,
      components: components
        .filter((component) => component.versionLineId === line.id)
        .sort((a, b) => byteOrder(a.componentKey ?? '', b.componentKey ?? '') || byteOrder(a.id, b.id))
        .map((component) => ({
          componentKey: component.componentKey ?? null,
          label: component.label ?? null,
          chargeType: component.chargeType,
          pricingModel: component.pricingModel,
          interval: component.interval ?? null,
          intervalCount: component.intervalCount ?? null,
          quantity: component.quantity,
          unitAmountCents: component.unitAmountCents ?? null,
          flatAmountCents: component.flatAmountCents ?? null,
          listAmountCents: component.listAmountCents,
          discountAmountCents: component.discountAmountCents,
          netAmountCents: component.netAmountCents,
          sourcePricingModel: component.sourcePricingModel ?? null,
        })),
    })),
    totals: totals.map((total) => ({
      kind: total.kind,
      currency: total.currency,
      interval: total.interval ?? null,
      intervalCount: total.intervalCount ?? null,
      listAmountCents: total.listAmountCents,
      discountAmountCents: total.discountAmountCents,
      netAmountCents: total.netAmountCents,
      ...frozenTaxFor(frozenVat, total),
    })),
    terms: verifiedTerm
      ? {
        effectiveDate: verifiedTerm.effectiveDate,
        termStartDate: verifiedTerm.termStartDate,
        termEndDate: verifiedTerm.termEndDate,
        termDays: verifiedTerm.termDays,
        autoRenew: verifiedTerm.autoRenew,
        renewalNoticeDays: verifiedTerm.renewalNoticeDays,
        termsFingerprint: termRows[0].termsFingerprint ?? null,
      }
      : null,
  };
}

/** Canonical JSON: sorted keys at every depth, so the hash is byte-stable. @param {unknown} value */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort(byteOrder).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * VAT + gross lines for one evidence total, from the FROZEN figures only.
 * A total from a pre-VAT version carries no frozen tax and yields no lines —
 * the document never invents tax from the live catalog.
 */
function vatLines(rateBps, total) {
  if (!Number.isSafeInteger(rateBps)
    || !Number.isSafeInteger(total?.vatAmountCents)
    || !Number.isSafeInteger(total?.grossAmountCents)) {
    return [];
  }
  const label = rateBps % 100 === 0 ? String(rateBps / 100) : (rateBps / 100).toFixed(2);
  const period = total.kind === 'recurring' ? ` (${total.interval} x${total.intervalCount})` : ' (una tantum)';
  return [
    `  IVA ${label}%${period}: ${formatMoney(total.vatAmountCents, total.currency)}`,
    `  Totale IVA inclusa${period}: ${formatMoney(total.grossAmountCents, total.currency)}`,
  ];
}

/** Format integer cents as `1234.56 EUR` with integer arithmetic only. */
function formatMoney(amountCents, currency) {
  const negative = amountCents < 0;
  const absolute = Math.abs(amountCents);
  const units = Math.trunc(absolute / 100);
  const cents = String(absolute % 100).padStart(2, '0');
  return `${negative ? '-' : ''}${units}.${cents} ${currency}`;
}

/**
 * Escape one PDF literal-string body. WinAnsi (latin-1 plus the euro sign)
 * covers the framework's Italian evidence; anything outside it becomes `?`
 * rather than silently producing undecodable bytes.
 * @param {string} text
 */
function escapePdfText(text) {
  let out = '';
  for (const char of String(text)) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '(' || char === ')' || char === '\\') out += `\\${char}`;
    else if (code === 0x20ac) out += '';
    else if (code >= 0x20 && code <= 0xff && code !== 0x7f) out += char;
    else if (code === 0x0a) out += ' ';
    else out += '?';
  }
  return out;
}

const PDF_LINES_PER_PAGE = 44;

/**
 * Render frozen quote-version evidence to deterministic PDF 1.4 bytes.
 * Pure: the same evidence always yields the same bytes (no timestamps, no
 * ids minted here). Throws on evidence that is not a frozen version shape.
 * @param {ReturnType<typeof readQuoteVersionEvidence> extends Promise<infer E> ? E : never} evidence
 */
export function renderQuoteVersionPdf(evidence) {
  if (!evidence || typeof evidence !== 'object' || !evidence.version || !Array.isArray(evidence.lines) || !Array.isArray(evidence.totals)) {
    throw new ValidationError('renderQuoteVersionPdf needs frozen quote-version evidence from readQuoteVersionEvidence', { field: 'evidence' });
  }
  const { version, lines, totals, terms } = evidence;
  if (lines.length === 0 || totals.length === 0) {
    throw new ValidationError('a quote PDF needs at least one frozen line and one frozen total', { field: 'evidence' });
  }
  const documentHash = createHash('sha256').update(canonical(evidence), 'utf8').digest('hex');

  const text = [];
  text.push(`Preventivo ${version.quoteId} — versione ${version.versionNumber}`);
  text.push(`Versione: ${version.id} · congelata il ${version.submittedAt ?? 'n/d'} · da ${version.submittedBy ?? 'n/d'}`);
  text.push(`Listino prezzi: ${version.priceBookId} · valuta ${version.currency}`);
  if (version.policy) text.push(`Regola sconto: ${version.policy}@${version.policyVersion} · esito ${version.policyDecision ?? 'n/d'}`);
  text.push('');
  text.push('Voci');
  for (const line of lines) {
    const discount = line.discountBps ? ` · sconto ${(line.discountBps / 100).toFixed(2)}%` : '';
    text.push(`${line.position}. ${line.offerName ?? line.offerLogicalKey ?? line.sku ?? '?'} × ${line.quantity}${discount}`);
    for (const component of line.components ?? []) {
      const period = component.chargeType === 'recurring' ? ` / ${component.interval} x${component.intervalCount}` : '';
      text.push(`    - ${component.label ?? component.componentKey ?? '?'}${period}: ${formatMoney(component.netAmountCents, version.currency)}`);
    }
    text.push(`    Riga: ${formatMoney(line.netAmountCents, version.currency)} netti`);
  }
  text.push('');
  text.push('Totali della versione congelata');
  for (const total of totals) {
    const period = total.kind === 'recurring' ? ` (${total.interval} x${total.intervalCount})` : ' (una tantum)';
    text.push(`  Subtotale${period}: ${formatMoney(total.netAmountCents, total.currency)} netti`);
    for (const line of vatLines(version.vatRateBps, total)) text.push(line);
  }
  if (terms) {
    text.push('');
    text.push(`Condizioni: dal ${terms.effectiveDate ?? 'n/d'} al ${terms.termEndDate ?? 'n/d'} · impronta ${terms.termsFingerprint ?? 'n/d'}`);
  }
  text.push('');
  text.push(`Impronta del documento: ${documentHash}`);

  const pages = [];
  for (let start = 0; start < text.length; start += PDF_LINES_PER_PAGE) pages.push(text.slice(start, start + PDF_LINES_PER_PAGE));

  // Minimal PDF 1.4: catalog, pages, one page per chunk, Helvetica, one
  // uncompressed content stream per page. Offsets are counted in bytes of
  // the latin-1 body, so multi-byte evidence never shifts the xref table.
  const objects = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + 2 * i} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((page, i) => {
    const content = [
      'BT /F1 10 Tf 50 800 Td 12 TL',
      ...page.map((line) => `(${escapePdfText(line)}) Tj T*`),
      'ET',
    ].join('\n');
    objects[4 + 2 * i] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R >>`;
    objects[5 + 2 * i] = `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;
  });
  const maxObject = 3 + 2 * pages.length;
  let body = '%PDF-1.4\n';
  const offsets = [];
  for (let id = 1; id <= maxObject; id += 1) {
    offsets[id] = Buffer.byteLength(body, 'latin1');
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefAt = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${maxObject + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxObject; id += 1) body += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${maxObject + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
  return { pdfBytes: Buffer.from(body, 'latin1'), documentHash, pageCount: pages.length, versionId: version.id };
}
