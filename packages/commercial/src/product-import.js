// @ts-check

import { randomUUID } from 'node:crypto';
import {
  AppError,
  ValidationError,
  requireActor,
  requireAmount,
} from '../../core/index.js';
import { requireCurrency } from './money.js';
import { createManualCatalog } from './manual-catalog.js';

/**
 * Product import drafts (accordo BO-F2-07, "Aggiungi prodotto con l'AI"):
 * an import from a PDF/Excel/photo — or typed by hand — creates DRAFT
 * `product-import-row` records the operator confirms or rejects one by
 * one. The import never writes a product itself: confirming one row writes
 * exactly one manual product through `createManualCatalog` (the trusted
 * write path of BO-F2-05), so a draft the operator never confirmed stays
 * a draft forever.
 *
 * What it reuses, per MEM_ACC_REUSE: the manual product write (never a
 * second writer), the `llm-complete@1` capability's audited `suggest`
 * purpose for the AI extraction (the same suggest-path appointments
 * parses booking phrases through — a suggestion the human confirms), the
 * record-module factory for the import and row tables, and the caller's
 * actor on every mutation. The model is never trusted, only strictly
 * validated item by item; provider text is never stored (only validated
 * scalars and an opaque document reference).
 *
 * Without a key the AI import stays off: a dry-run answer (`dryRun: true`)
 * or a disabled space (`LLM_SPACE_DISABLED`) refuses the AI source with
 * `PRODUCT_IMPORT_AI_UNAVAILABLE` — never fixture-hallucinated drafts —
 * while the manual source keeps working.
 */

export const PRODUCT_IMPORT_AI_UNAVAILABLE = 'PRODUCT_IMPORT_AI_UNAVAILABLE';
/** The llm-complete purpose the extraction spends under (audited there). */
export const PRODUCT_IMPORT_PURPOSE = 'suggest';
/** One import carries at most this many draft rows: the operator checks each one. */
export const MAX_IMPORT_ROWS = 200;
/** The document text sent to the model is bounded like the suggest excerpts. */
export const MAX_DOCUMENT_CHARS = 64_000;
/** An opaque document reference (file name, upload id): never provider text. */
export const MAX_DOCUMENT_REF = 200;
const MAX_TEXT = 500;
const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** @param {unknown} value @param {string} field */
function requireDraftText(value, field, max = MAX_TEXT) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new ValidationError(`${field} must be non-empty text of at most ${max} characters`, { field });
  }
  return value.trim();
}

/** @param {unknown} value @param {string} field */
function optionalDraftText(value, field, max = MAX_TEXT) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be text when present`, { field });
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (value.length > max) {
    throw new ValidationError(`${field} must be at most ${max} characters`, { field });
  }
  return trimmed;
}

/**
 * Validate one draft candidate — operator-typed or model-extracted, one
 * rule for both sources — into the normalized row shape. Throws a
 * ValidationError naming the field; the caller maps it to a typed
 * per-item refuse code.
 * @param {unknown} candidate @param {string} label
 */
export function normalizeDraftRow(candidate, label) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new ValidationError(`${label} must be an object with sku, name and amountCents`, { field: label });
  }
  const row = /** @type {Record<string, unknown>} */ (candidate);
  const sku = requireDraftText(row.sku, `${label}.sku`, 100);
  if (!SKU_RE.test(sku)) {
    throw new ValidationError(`${label}.sku must start with a letter or digit (letters, digits, dot, underscore, hyphen, at most 100 characters)`, { field: `${label}.sku` });
  }
  const name = requireDraftText(row.name, `${label}.name`, 200);
  const description = optionalDraftText(row.description, `${label}.description`);
  const category = optionalDraftText(row.category, `${label}.category`, 100);
  let amountCents;
  try {
    amountCents = requireAmount(row.amountCents, `${label}.amountCents`);
  } catch {
    throw new ValidationError(`${label}.amountCents must be a non-negative safe integer in 1/100 currency units`, { field: `${label}.amountCents` });
  }
  return { sku, name, description, category, amountCents };
}

/** @param {unknown} value @param {string} field */
function requireDocumentRef(value, field) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_DOCUMENT_REF) {
    throw new ValidationError(`${field} must be a short opaque reference of at most ${MAX_DOCUMENT_REF} characters`, { field });
  }
  return value.trim();
}

/**
 * Validate the operator-typed rows of a manual import: every row through
 * the same `normalizeDraftRow` the AI path uses, item-by-item refusal
 * instead of one bad line killing the import.
 * @param {unknown} rows
 */
export function normalizeManualRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new ValidationError('rows must be a non-empty array of { sku, name, amountCents }', { field: 'rows' });
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new ValidationError(`rows carries at most ${MAX_IMPORT_ROWS} rows per import`, { field: 'rows' });
  }
  return rows.map((candidate, index) => normalizeDraftRow(candidate, `rows[${index}]`));
}

/**
 * Build the bounded messages for the model: the document text only. The
 * model answers with a JSON array; currency travels outside the model —
 * the import declares one currency, the model never invents one.
 * @param {string} documentText
 */
export function buildImportMessages(documentText) {
  return [
    {
      role: 'system',
      content: 'Sei l\u2019estrattore del catalogo prodotti del backoffice. Rispondi SOLO con un array JSON, senza testo fuori dall\u2019array. '
        + 'Ogni elemento: {"sku": string, "name": string, "description"?: string, "category"?: string, "amountCents": integer >= 0}. '
        + 'sku \u00e8 il codice prodotto come scritto nel documento, name il nome, amountCents il prezzo in centesimi (intero non negativo). '
        + 'Non inventare mai righe, codici o prezzi: solo ci\u00f2 che il documento dice. Se il documento non contiene prodotti, rispondi [].',
    },
    { role: 'user', content: `Documento da cui estrarre i prodotti:\n${documentText}` },
  ];
}

/** Strip fenced code blocks the model may wrap around the JSON array. */
function extractJsonArray(text) {
  const trimmed = String(text ?? '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new AppError('the extraction model did not answer a JSON array: no draft is created', {
      code: 'PRODUCT_IMPORT_AI_DRAFT_UNUSABLE', status: 502,
    });
  }
  if (!Array.isArray(parsed)) {
    throw new AppError('the extraction model did not answer a JSON array: no draft is created', {
      code: 'PRODUCT_IMPORT_AI_DRAFT_UNUSABLE', status: 502,
    });
  }
  return parsed;
}

/**
 * Extract product drafts from a document through the injected `complete`
 * (the opened `llm-complete@1` handle in production). The model is never
 * trusted: every item is validated, bad items refuse with a typed code,
 * and a dry-run answer is the AI-off state — never parsed drafts.
 *
 * @param {{
 *   documentText: unknown,
 *   complete?: ((request: {messages: Array<{role: string, content: string}>, maxTokens: number}) => Promise<{text: string, dryRun?: boolean}>) | null,
 *   maxDrafts?: number, maxTokens?: number
 * }} input
 */
export async function extractProductDrafts({ documentText, complete, maxDrafts = MAX_IMPORT_ROWS, maxTokens = 2048 }) {
  if (typeof documentText !== 'string' || documentText.trim() === '') {
    throw new ValidationError('documentText must be non-empty text extracted from the PDF, spreadsheet or photo', { field: 'documentText' });
  }
  const text = documentText.length > MAX_DOCUMENT_CHARS ? documentText.slice(0, MAX_DOCUMENT_CHARS) : documentText;
  const truncatedDocument = text !== documentText;
  if (!Number.isSafeInteger(maxDrafts) || maxDrafts < 1 || maxDrafts > MAX_IMPORT_ROWS) {
    throw new ValidationError(`maxDrafts must be an integer between 1 and ${MAX_IMPORT_ROWS}`, { field: 'maxDrafts' });
  }
  if (complete === undefined || complete === null) {
    return Object.freeze({
      status: 'llm-disabled',
      reason: 'no completion function was provided: the AI import stays off until the caller wires one (for example the llm-complete@1 capability)',
      drafts: Object.freeze([]),
      refused: Object.freeze([]),
      truncatedDocument,
    });
  }
  if (typeof complete !== 'function') {
    throw new ValidationError('complete must be a function or null', { field: 'complete' });
  }
  /** @type {{ text: string, dryRun?: boolean }} */
  let answer;
  try {
    answer = await complete({ messages: buildImportMessages(text), maxTokens });
  } catch (error) {
    if (error !== null && typeof error === 'object' && /** @type {any} */ (error).code === 'LLM_SPACE_DISABLED') {
      return Object.freeze({
        status: 'llm-disabled',
        reason: String(/** @type {any} */ (error).message ?? 'AI is not enabled for this space').slice(0, 200),
        drafts: Object.freeze([]),
        refused: Object.freeze([]),
        truncatedDocument,
      });
    }
    throw error;
  }
  if (answer?.dryRun === true) {
    return Object.freeze({
      status: 'llm-disabled',
      reason: 'the completion ran as a dry-run without a key: the AI import stays off, use the manual import instead',
      drafts: Object.freeze([]),
      refused: Object.freeze([]),
      truncatedDocument,
    });
  }
  const items = extractJsonArray(answer?.text);
  const drafts = [];
  const refused = [];
  for (let index = 0; index < items.length; index += 1) {
    const label = `drafts[${index}]`;
    try {
      drafts.push(Object.freeze({ ...normalizeDraftRow(items[index], label) }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const details = error instanceof AppError && error.details && typeof error.details === 'object'
        ? /** @type {Record<string, unknown>} */ (error.details)
        : null;
      const field = details !== null && typeof details.field === 'string' ? details.field : label;
      let code = 'PRODUCT_IMPORT_ITEM_INVALID';
      if (field.endsWith('.sku')) code = 'PRODUCT_IMPORT_SKU_MISSING';
      else if (field.endsWith('.name')) code = 'PRODUCT_IMPORT_NAME_MISSING';
      else if (field.endsWith('.amountCents')) code = 'PRODUCT_IMPORT_AMOUNT_INVALID';
      else if (field.endsWith('.description') || field.endsWith('.category')) code = 'PRODUCT_IMPORT_FIELD_INVALID';
      refused.push({ index, code, reason: message.slice(0, 200) });
      continue;
    }
    if (drafts.length >= maxDrafts) {
      for (let rest = index + 1; rest < items.length; rest += 1) {
        refused.push({ index: rest, code: 'PRODUCT_IMPORT_OVER_LIMIT', reason: `at most ${maxDrafts} drafts per import` });
      }
      break;
    }
  }
  return Object.freeze({
    status: 'ok',
    reason: null,
    drafts: Object.freeze(drafts),
    refused: Object.freeze(refused),
    truncatedDocument,
  });
}

/**
 * @param {{database: any, events: any, modules: any, moduleNames?: Record<string, string>}} deps
 */
export function createProductImport({ database, events, modules, moduleNames = {} }) {
  const names = {
    productImport: moduleNames.productImport ?? 'product-import',
    productImportRow: moduleNames.productImportRow ?? 'product-import-row',
  };
  const manual = createManualCatalog({ database, events, modules, moduleNames });
  const service = (name) => {
    const module = modules.get(name);
    if (typeof module?.service?.createManaged !== 'function') {
      throw new AppError(`Module "${name}" is not a managed record module — regenerate it from the current manifest`, {
        code: 'COMMERCIAL_STORAGE_INVALID',
        status: 500,
      });
    }
    return module.service;
  };

  /** The envelope every import mutation runs in: actor first, one transaction, events buffered. */
  async function runImport(operation, actor, write) {
    const who = requireActor(actor);
    return events.buffered(async () => database.transactionAsync(async () => write({ actor: who })));
  }

  const rowView = (row) => Object.freeze({
    id: row.id,
    importId: row.importId,
    rowIndex: row.rowIndex,
    status: row.status,
    sku: row.sku,
    name: row.name,
    description: row.description ?? null,
    category: row.category ?? null,
    currency: row.currency,
    amountCents: row.amountCents,
    productId: row.productId === '' ? null : (row.productId ?? null),
    errorCode: row.errorCode === '' ? null : (row.errorCode ?? null),
  });

  const importView = (record) => Object.freeze({
    id: record.id,
    sourceKey: record.sourceKey,
    sourceKind: record.sourceKind,
    status: record.status,
    currency: record.currency,
    priceBookId: record.priceBookId === '' ? null : (record.priceBookId ?? null),
    documentRef: record.documentRef === '' ? null : (record.documentRef ?? null),
    errorCode: record.errorCode === '' ? null : (record.errorCode ?? null),
  });

  async function closeWhenDecided(importId, context) {
    const rows = service(names.productImportRow);
    const pending = await rows.listWhere({ importId, status: 'pending' });
    if (pending.length === 0) {
      await service(names.productImport).applyManaged(importId, { status: 'closed' }, context);
      return 'closed';
    }
    return 'open';
  }

  return {
    /**
     * Start an import: validate the drafts (manual rows, or AI-extracted
     * from the document text), persist them as pending rows, write no
     * product. Refuses when no valid draft remains.
     */
    async startImport(input = {}, actor, hooks = {}) {
      const record = input && typeof input === 'object' ? input : {};
      const source = record.source;
      if (source !== 'manual' && source !== 'ai') {
        throw new ValidationError("source must be 'manual' or 'ai'", { field: 'source' });
      }
      const currency = requireCurrency(record.currency, 'currency');
      let priceBookId = null;
      if (record.priceBookId !== undefined && record.priceBookId !== null && record.priceBookId !== '') {
        if (typeof record.priceBookId !== 'string') {
          throw new ValidationError('priceBookId must be a string when present', { field: 'priceBookId' });
        }
        priceBookId = record.priceBookId;
      }
      const documentRef = source === 'ai' ? requireDocumentRef(record.documentRef, 'documentRef') : '';
      /** @type {Array<{sku: string, name: string, description: string|null, category: string|null, amountCents: number}>} */
      let drafts;
      let refused = [];
      let truncatedDocument = false;
      if (source === 'manual') {
        drafts = normalizeManualRows(record.rows);
      } else {
        const complete = hooks.complete ?? null;
        const extracted = await extractProductDrafts({
          documentText: record.documentText,
          complete,
          maxTokens: 2048,
        });
        if (extracted.status === 'llm-disabled') {
          throw new AppError(
            `the AI import is off (${extracted.reason}): import the rows by hand instead`,
            { code: PRODUCT_IMPORT_AI_UNAVAILABLE, status: 409 },
          );
        }
        drafts = [...extracted.drafts];
        refused = [...extracted.refused];
        truncatedDocument = extracted.truncatedDocument === true;
      }
      if (drafts.length === 0) {
        throw new AppError('the import produced no valid draft: nothing is stored', {
          code: 'PRODUCT_IMPORT_ALL_REFUSED', status: 422, details: { refused },
        });
      }
      return runImport('product-import.start', actor, async (context) => {
        const imports = service(names.productImport);
        const rows = service(names.productImportRow);
        const created = await imports.createManaged({
          sourceKey: `product-import:${randomUUID()}`,
          sourceKind: source,
          status: 'open',
          currency,
          priceBookId: priceBookId ?? '',
          documentRef,
          errorCode: '',
        }, context);
        const stored = [];
        for (let index = 0; index < drafts.length; index += 1) {
          const draft = drafts[index];
          stored.push(await rows.createManaged({
            importId: created.id,
            rowIndex: index,
            status: 'pending',
            sku: draft.sku,
            name: draft.name,
            description: draft.description ?? '',
            category: draft.category ?? '',
            currency,
            amountCents: draft.amountCents,
            productId: '',
            errorCode: '',
          }, context));
        }
        return Object.freeze({
          import: importView(created),
          drafts: Object.freeze(stored.map(rowView)),
          refused: Object.freeze(refused.map((entry) => Object.freeze({ ...entry }))),
          truncatedDocument,
        });
      });
    },

    /** Confirm one pending row: writes exactly one manual product, then marks the row. */
    async confirmRow(input = {}, actor) {
      const record = input && typeof input === 'object' ? input : {};
      const importId = typeof record.importId === 'string' && record.importId !== '' ? record.importId : null;
      const rowId = typeof record.rowId === 'string' && record.rowId !== '' ? record.rowId : null;
      if (!importId) throw new ValidationError('importId is required', { field: 'importId' });
      if (!rowId) throw new ValidationError('rowId is required', { field: 'rowId' });
      const who = requireActor(actor);
      const rows = service(names.productImportRow);
      const row = await rows.get(rowId);
      if (row.importId !== importId) {
        throw new AppError(`row "${rowId}" does not belong to import "${importId}"`, {
          code: 'PRODUCT_IMPORT_ROW_MISMATCH', status: 404,
        });
      }
      if (row.status === 'confirmed') {
        const current = await service(names.productImport).get(importId);
        return Object.freeze({ import: importView(current), row: rowView(row), product: { id: row.productId }, replay: true });
      }
      if (row.status !== 'pending') {
        throw new AppError(`row "${rowId}" is already decided (${row.status}): only pending rows confirm`, {
          code: 'PRODUCT_IMPORT_ROW_DECIDED', status: 409,
        });
      }
      const current = await service(names.productImport).get(importId);
      if (current.status !== 'open') {
        throw new AppError(`import "${importId}" is ${current.status}: only open imports confirm rows`, {
          code: 'PRODUCT_IMPORT_CLOSED', status: 409,
        });
      }
      const created = await manual.createProduct({
        sku: row.sku,
        name: row.name,
        description: row.description === '' ? undefined : row.description,
        category: row.category === '' ? undefined : row.category,
        currency: row.currency,
        priceBookId: current.priceBookId === '' ? undefined : current.priceBookId,
        components: [{
          key: 'import-price',
          label: row.name,
          chargeType: 'one_time',
          pricingModel: 'flat_fee',
          flatAmountCents: row.amountCents,
        }],
      }, who);
      return runImport('product-import.confirm', who, async (context) => {
        const updated = await rows.applyManaged(rowId, { status: 'confirmed', productId: created.product.id }, context);
        const status = await closeWhenDecided(importId, context);
        const latest = status === 'closed'
          ? await service(names.productImport).get(importId)
          : current;
        return Object.freeze({
          import: importView({ ...current, status: latest.status }),
          row: rowView(updated),
          product: Object.freeze({ ...created.product }),
          replay: false,
        });
      });
    },

    /** Reject one pending row: no product is written, the decision is stored. */
    async rejectRow(input = {}, actor) {
      const record = input && typeof input === 'object' ? input : {};
      const importId = typeof record.importId === 'string' && record.importId !== '' ? record.importId : null;
      const rowId = typeof record.rowId === 'string' && record.rowId !== '' ? record.rowId : null;
      if (!importId) throw new ValidationError('importId is required', { field: 'importId' });
      if (!rowId) throw new ValidationError('rowId is required', { field: 'rowId' });
      return runImport('product-import.reject', actor, async (context) => {
        const rows = service(names.productImportRow);
        const row = await rows.get(rowId);
        if (row.importId !== importId) {
          throw new AppError(`row "${rowId}" does not belong to import "${importId}"`, {
            code: 'PRODUCT_IMPORT_ROW_MISMATCH', status: 404,
          });
        }
        if (row.status !== 'pending') {
          throw new AppError(`row "${rowId}" is already decided (${row.status}): only pending rows reject`, {
            code: 'PRODUCT_IMPORT_ROW_DECIDED', status: 409,
          });
        }
        const current = await service(names.productImport).get(importId);
        if (current.status !== 'open') {
          throw new AppError(`import "${importId}" is ${current.status}: only open imports reject rows`, {
            code: 'PRODUCT_IMPORT_CLOSED', status: 409,
          });
        }
        const updated = await rows.applyManaged(rowId, { status: 'rejected' }, context);
        const status = await closeWhenDecided(importId, context);
        return Object.freeze({
          import: importView({ ...current, status }),
          row: rowView(updated),
        });
      });
    },

    /** Read one import with its rows in order and the decided counts. */
    async readImport(input = {}) {
      const record = input && typeof input === 'object' ? input : {};
      const importId = typeof record.importId === 'string' && record.importId !== '' ? record.importId : null;
      if (!importId) throw new ValidationError('importId is required', { field: 'importId' });
      const current = await service(names.productImport).get(importId);
      const all = await service(names.productImportRow).listWhere({ importId });
      const ordered = [...all].sort((a, b) => a.rowIndex - b.rowIndex);
      const counts = { pending: 0, confirmed: 0, rejected: 0 };
      for (const row of ordered) {
        if (row.status === 'confirmed') counts.confirmed += 1;
        else if (row.status === 'rejected') counts.rejected += 1;
        else counts.pending += 1;
      }
      return Object.freeze({
        import: importView(current),
        rows: Object.freeze(ordered.map(rowView)),
        counts: Object.freeze({ ...counts }),
      });
    },
  };
}

/**
 * Open the handed-over `llm-complete@1` capability for one runtime (BO-F2-07
 * AI import): the extraction drafts rows the operator confirms. Absent
 * until an AI import is requested — the manual import never touches it, so
 * a composition without llm imports exactly as before. The edge version
 * pins the provider capability contract, like the appointments handover.
 * @param {any} llmCapability the composed llm package definition (handover, optional)
 * @param {any} runtime
 */
export function openProductImportLlm(llmCapability, runtime) {
  if (llmCapability === undefined || llmCapability === null) return null;
  if (typeof llmCapability.create !== 'function') {
    throw new AppError(
      'The commercial package needs the llm package capability llm-complete@1: '
      + 'compose it with the provider definition, e.g. createCommercialDomain({ llm }) beside createLlmPackage()',
      { code: 'PACKAGE_DEPENDENCY_MISMATCH', status: 409 },
    );
  }
  const opened = llmCapability.create({ modules: runtime.modules });
  if (!opened || typeof opened.complete !== 'function') {
    throw new AppError(
      'The commercial package needs the llm package capability llm-complete@1: '
      + 'the created capability opens no complete',
      { code: 'PACKAGE_DEPENDENCY_MISMATCH', status: 409 },
    );
  }
  if (opened.capabilityContract !== 1) {
    throw new AppError(
      'The commercial package needs llm-complete@1 on provider capability contract 1: '
      + 'the handed-over handle settles on another contract',
      { code: 'PACKAGE_DEPENDENCY_MISMATCH', status: 409 },
    );
  }
  return opened;
}
