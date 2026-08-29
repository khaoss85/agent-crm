// @ts-check

import { ValidationError } from './errors.js';

/**
 * Core-module adapters for record actions (ADR-013).
 *
 * Actions target generated modules, but some jobs — lead conversion above all —
 * must create or reuse records in the handwritten core CRM modules (Company,
 * Contact, Opportunity). Instead of letting action code reach arbitrarily into
 * core services (or run raw SQL), this registry exposes a small, static,
 * frozen set of declared capabilities:
 *
 *   - writes go through the real module services, so validation, audit and
 *     domain events are preserved and buffered exactly like any other write
 *     inside an action's transaction;
 *   - normalized-match reads live here, not in action code, with one
 *     deterministic normalization documented per capability;
 *   - nothing here is exposed over HTTP, added to the SDK, or discoverable by
 *     introspection — the object is frozen and built per app instance.
 *
 * This is a framework boundary against accidental misuse, not a sandbox:
 * repository source is trusted (ADR-008 threat model).
 */

/**
 * Deterministic company-name normalization: Unicode NFC, trimmed, internal
 * whitespace runs collapsed to one space, lowercased in JavaScript (SQLite's
 * LOWER() is ASCII-only, so normalization never happens in SQL).
 *
 * @param {string} name
 */
export function normalizeCompanyName(name) {
  return name.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

/** @param {string} email */
export function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

/**
 * @param {{database: any, services: {companies: any, contacts: any, opportunities: any}, pipelines?: {forModule: (name: string) => any}}} deps
 */
export function createCoreAdapters({ database, services, pipelines }) {
  for (const name of ['companies', 'contacts', 'opportunities']) {
    if (!services[name] || typeof services[name].create !== 'function') {
      throw new ValidationError(`Core adapters need the ${name} service`);
    }
  }

  return Object.freeze({
    /**
     * Every company whose normalized name equals the normalized input, oldest
     * first (deterministic order). A full scan normalized in JS — correct for
     * the local-development scale this framework currently targets.
     *
     * @param {string} name
     * @returns {Array<{id: string, name: string, domain: string | null}>}
     */
    findCompaniesByNormalizedName(name) {
      if (typeof name !== 'string' || name.trim() === '') {
        throw new ValidationError('companyName is required to match a company', { field: 'companyName' });
      }
      const wanted = normalizeCompanyName(name);
      return database.storage.sync.many({
        kind: 'select',
        table: 'companies',
        columns: ['id', 'name', 'domain', 'created_at'],
        orderBy: [
          { column: 'created_at', direction: 'asc' },
          { column: 'id', direction: 'asc' },
        ],
      })
        .filter((row) => normalizeCompanyName(String(row.name)) === wanted)
        .map((row) => ({
          id: String(row.id),
          name: String(row.name),
          domain: row.domain === null || row.domain === undefined ? null : String(row.domain),
        }));
    },

    /**
     * The contact using this email (globally unique in the core schema,
     * stored lowercased), or null.
     *
     * @param {string} email
     * @returns {{id: string, companyId: string, email: string} | null}
     */
    findContactByEmail(email) {
      if (typeof email !== 'string' || email.trim() === '') {
        throw new ValidationError('email is required to match a contact', { field: 'email' });
      }
      const row = database.storage.sync.maybeOne({
        kind: 'select',
        table: 'contacts',
        columns: ['id', 'company_id', 'email'],
        where: [{ column: 'email', op: 'eq', value: normalizeEmail(email) }],
      });
      return row
        ? { id: String(row.id), companyId: String(row.company_id), email: String(row.email) }
        : null;
    },

    /** @param {{name: string, domain?: string | null}} input @param {{actor?: unknown}} [context] */
    createCompany(input, context) {
      return services.companies.create(input, context);
    },

    /** @param {{companyId: string, firstName: string, lastName: string, email: string, role?: string | null}} input @param {{actor?: unknown}} [context] */
    createContact(input, context) {
      return services.contacts.create(input, context);
    },

    /** @param {Record<string, unknown>} input @param {{actor?: unknown}} [context] */
    createOpportunity(input, context) {
      return services.opportunities.create(input, context);
    },

    /**
     * Place an opportunity on the pipeline registered for the opportunity
     * module (ADR-014), in its declared default stage — atomically with the
     * caller's transaction, via the service's managed write path. Returns
     * null when no pipeline is installed: the documented deterministic
     * default is legacy (pre-pipeline) behavior, never an invented stage.
     *
     * @param {string} opportunityId @param {{actor?: unknown, now?: () => string}} [context]
     */
    async enterOpportunityPipeline(opportunityId, context = {}) {
      const pipeline = pipelines && typeof pipelines.forModule === 'function' ? pipelines.forModule('opportunity') : null;
      if (!pipeline) return null;
      const enteredAt = typeof context.now === 'function' ? context.now() : new Date().toISOString();
      await services.opportunities.applyManaged(
        opportunityId,
        { pipelineKey: pipeline.name, pipelineStage: pipeline.defaultStage, stageEnteredAt: enteredAt },
        { actor: context.actor },
      );
      return { pipeline: pipeline.name, stage: pipeline.defaultStage };
    },
  });
}
