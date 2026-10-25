// @ts-check

/**
 * Per-space composition of packages and skills (backlog:7543aabbd901,
 * BO-F4-01 Personalizzazione).
 *
 * The backoffice Personalizzazione screen activates framework packages and
 * agent skills per space. Activation records the composition here — one
 * `space-package` row per (space, unit) — and never rewires the running
 * application: the application's graph stays exactly what the project
 * composed, and this registry says which parts of it the space switched on.
 *
 * The catalog below is static and checked in, like the connectors catalog the
 * Admin already keeps (`apps/admin/public/admin-connectors.js`): every unit
 * names real manifests on disk (packages) or real frontmatter (skills), and
 * `tests/space-packages.test.js` fails when a unit drifts from either.
 * Units with no record modules are not activatable and stay out by rule:
 * there would be nothing to demonstrate and nothing to record.
 */

import { randomUUID } from 'node:crypto';
import { AppError, ValidationError, nowIso, writeTrace } from '../../core/index.js';
import { checkSpaceId, resolveSpacePermissions } from './permissions.js';
import { escapeKeyPart } from './proposals.js';
import { buildSetPermissionAction, isUniqueConflict, requireIdentifiedActor } from './actions.js';

/**
 * One activatable unit. Packages list the space-scoped record modules their
 * preview counts; every listed module MUST carry a `spaceId` field (the
 * coverage test enforces it), so a preview never mixes another space's rows
 * in. `demo` names the module the preview samples for its real case, or null
 * when the package keeps no space-scoped records.
 */
const PACKAGE_UNITS = Object.freeze([
  {
    name: 'appointments', kind: 'package', label: 'Appuntamenti',
    blurb: 'Prenotazioni in Accordo, sincronizzate con Google Calendar.',
    modules: Object.freeze([]), demo: null,
  },
  {
    name: 'calendar-sync', kind: 'package', label: 'Sincronizzazione calendario',
    blurb: 'Collegamento e sincronizzazione a due vie con Google Calendar.',
    modules: Object.freeze(['calendar-sync-state']), demo: 'calendar-sync-state',
  },
  {
    name: 'channels', kind: 'package', label: 'Canali',
    blurb: 'WhatsApp, Instagram, Facebook, TikTok, SMS, email, voce e form del sito in un unico inbox.',
    modules: Object.freeze([
      'channel-connection', 'channel-inbox-event', 'channel-dead-letter',
      'channel-import-state', 'channel-import-outcome',
    ]),
    demo: 'channel-connection',
  },
  {
    name: 'commercial', kind: 'package', label: 'Catalogo e preventivi',
    blurb: 'Listino, prodotti, offerte e preventivi con approvazione.',
    modules: Object.freeze([]), demo: null,
  },
  {
    name: 'contracts', kind: 'package', label: 'Contratti',
    blurb: 'Contratti commerciali, attivazioni e successioni.',
    modules: Object.freeze([]), demo: null,
  },
  {
    name: 'customer-data', kind: 'package', label: 'Dati clienti',
    blurb: 'Import, doppioni, qualità dati e profilo consolidato.',
    modules: Object.freeze([]), demo: null,
  },
  {
    name: 'delivery', kind: 'package', label: 'Consegne',
    blurb: 'Progetti di consegna, milestone e accettazione.',
    modules: Object.freeze([]), demo: null,
  },
  {
    name: 'intelligence', kind: 'package', label: 'Intelligenza chiamate',
    blurb: 'Segnali, trascrizione e arricchimento AI delle chiamate.',
    modules: Object.freeze(['call-notice', 'call-signal', 'call-transcript']),
    demo: 'call-notice',
  },
  {
    name: 'interactions', kind: 'package', label: 'Conversazioni',
    blurb: 'Thread, assegnazioni e letture delle conversazioni.',
    modules: Object.freeze([]), demo: null,
  },
  {
    name: 'lifecycle', kind: 'package', label: 'Ciclo di vita',
    blurb: 'Rinnovi, modifiche e follow-up commerciali.',
    modules: Object.freeze([]), demo: null,
  },
  {
    name: 'llm', kind: 'package', label: 'Assistente AI',
    blurb: 'Chiamate e consumi del modello, per spazio.',
    modules: Object.freeze(['llm-call-audit', 'llm-usage-day']),
    demo: 'llm-usage-day',
  },
  {
    name: 'marketing', kind: 'package', label: 'Campagne',
    blurb: 'Proposte di campagna e funnel.',
    modules: Object.freeze([]), demo: null,
  },
  {
    name: 'payments', kind: 'package', label: 'Pagamenti',
    blurb: 'Richieste di pagamento e riconciliazione.',
    modules: Object.freeze(['payment-connection', 'payment-event', 'payment-request']),
    demo: 'payment-request',
  },
  {
    name: 'sequences', kind: 'package', label: 'Sequenze',
    blurb: 'Sequenze di follow-up multicanale con stop alla risposta.',
    modules: Object.freeze(['sequence', 'sequence-enrollment', 'sequence-step', 'sequence-send']),
    demo: 'sequence',
  },
  {
    name: 'service', kind: 'package', label: 'Assistenza',
    blurb: 'Coperture, casi di supporto e SLA.',
    modules: Object.freeze([]), demo: null,
  },
  {
    name: 'signature', kind: 'package', label: 'Firme',
    blurb: 'Buste di firma, firmatari e ordini firmati.',
    modules: Object.freeze([]), demo: null,
  },
  {
    name: 'site-forms', kind: 'package', label: 'Form del sito',
    blurb: 'Invii dai form con antispam e deduplicazione.',
    modules: Object.freeze(['site-form-submission']),
    demo: 'site-form-submission',
  },
  {
    name: 'space-permissions', kind: 'package', label: 'Permessi AI',
    blurb: 'Interruttori AI per spazio e proposte in attesa di un umano.',
    modules: Object.freeze(['space-permission-override', 'space-ai-proposal']),
    demo: 'space-permission-override',
  },
  {
    name: 'work', kind: 'package', label: 'Attività',
    blurb: 'Code di lavoro e attività con promemoria.',
    modules: Object.freeze([]), demo: null,
  },
]);

/**
 * The agent skills shipped in `.claude/skills` (mirrored for the other
 * harnesses, published subset in `skills/`). `requires` and `degradesTo`
 * repeat the frontmatter of each `SKILL.md` word for word — the coverage
 * test reads the frontmatter and fails on any drift — while `label` and
 * `blurb` are backoffice presentation copy.
 */
const SKILL_UNITS = Object.freeze([
  {
    name: 'skill:adversarial-review', kind: 'skill', label: 'Revisione pre-merge',
    blurb: 'Revisione avversariale di una PR prima del merge, per severità.',
    requires: Object.freeze({ tier: 'repository', command: 'crm app inspect' }),
    degradesTo: 'a clean-clone verification run plus the boundaries in `crm app inspect --json`; the standing review categories and the JTBD evidence rules live in this repository\'s documents and have no substitute',
  },
  {
    name: 'skill:build-commercial-operations', kind: 'skill', label: 'Operazioni commerciali',
    blurb: 'Catalogo, listino, preventivi e sconti con approvazione.',
    requires: Object.freeze({ tier: 'generated-project', command: 'crm app inspect' }),
    degradesTo: 'the composed commercial packages, actions, policies and providers reported by `crm app inspect --json`',
  },
  {
    name: 'skill:build-contract-activation', kind: 'skill', label: 'Attivazione contratti',
    blurb: 'Da ordine firmato a contratto, subscription e rinnovi.',
    requires: Object.freeze({ tier: 'generated-project', command: 'crm app inspect' }),
    degradesTo: 'the composed packages, capabilities and policies reported by `crm app inspect --json`, plus `crm package validate` for the contract a package must satisfy',
  },
  {
    name: 'skill:build-custom-domain-package', kind: 'skill', label: 'Pacchetti su misura',
    blurb: 'Un nuovo pacchetto di dominio con risorse e policy proprie.',
    requires: Object.freeze({ tier: 'generated-project', command: 'crm app inspect' }),
    degradesTo: '`crm package validate <dir>` and `crm package inspect <dir>` \u2014 the same validator startup runs \u2014 plus the composition reported by `crm app inspect --json`',
  },
  {
    name: 'skill:build-delivery-handover', kind: 'skill', label: 'Consegne e handover',
    blurb: 'Progetti di consegna, milestone, partner e accettazione.',
    requires: Object.freeze({ tier: 'generated-project', command: 'crm app inspect' }),
    degradesTo: 'the capability graph in `crm app inspect --json` \u2014 which reports whether `contracts/delivery-obligations@1` resolves for this project \u2014 plus `crm package validate`',
  },
  {
    name: 'skill:build-lead-intelligence', kind: 'skill', label: 'Lead intelligence',
    blurb: 'Arricchimento, punteggio e instradamento dei lead.',
    requires: Object.freeze({ tier: 'generated-project', command: 'crm app inspect' }),
    degradesTo: 'the composed providers, policies and actions reported by `crm app inspect --json`',
  },
  {
    name: 'skill:build-service-operations', kind: 'skill', label: 'Assistenza operativa',
    blurb: 'Coperture, casi di supporto e SLA con policy.',
    requires: Object.freeze({ tier: 'generated-project', command: 'crm app inspect' }),
    degradesTo: 'the composed packages, capabilities and policies reported by `crm app inspect --json`, plus `crm package test` for the contract a package must satisfy',
  },
  {
    name: 'skill:build-signature-order', kind: 'skill', label: 'Firme e ordini',
    blurb: 'Buste di firma, webhook verificati e ordini immutabili.',
    requires: Object.freeze({ tier: 'generated-project', command: 'crm app inspect' }),
    degradesTo: 'the composed signature providers, actions and records reported by `crm app inspect --json`',
  },
  {
    name: 'skill:create-crm-module', kind: 'skill', label: 'Nuovi oggetti',
    blurb: 'Un nuovo oggetto CRM con campi, API e test.',
    requires: Object.freeze({ tier: 'generated-project', command: 'crm app inspect' }),
    degradesTo: 'the module factory CLI \u2014 `crm module validate|plan|create` \u2014 which checks a manifest, prints the deterministic plan and refuses an unsafe evolution before any write, reading no document',
  },
  {
    name: 'skill:create-crm-workflow', kind: 'skill', label: 'Nuovi processi',
    blurb: 'Processi tra moduli con policy, traccia e approvazione.',
    requires: Object.freeze({ tier: 'generated-project', command: 'crm app inspect' }),
    degradesTo: 'the actions, policies and records reported by `crm app inspect --json`, plus the workflow engine and the existing workflows in the project\'s own source',
  },
  {
    name: 'skill:debug-crm-run', kind: 'skill', label: 'Diagnosi',
    blurb: 'Diagnosi di un workflow fallito da tracce e audit.',
    requires: Object.freeze({ tier: 'any-project', command: 'crm app inspect' }),
    degradesTo: 'nothing \u2014 this skill already reaches the project only through commands, the trace API and MCP tools',
  },
  {
    name: 'skill:solve-business-goal', kind: 'skill', label: 'Obiettivo commerciale',
    blurb: 'Da un obiettivo espresso in parole a una soluzione verificata.',
    requires: Object.freeze({ tier: 'generated-project', command: 'crm app inspect' }),
    degradesTo: '`crm app inspect --json` for what exists and `crm solution validate|check` for whether the plan is sound against it; both read the project, not a document',
  },
]);

/** Every activatable unit, packages first in sidebar order, then skills. */
export const SPACE_PACKAGE_CATALOG = Object.freeze([...PACKAGE_UNITS, ...SKILL_UNITS]);

const UNIT_BY_NAME = new Map(SPACE_PACKAGE_CATALOG.map((entry) => [entry.name, entry]));

/** Grammar for unit names: a package slug, or `skill:` plus a skill slug. */
const PACKAGE_GRAMMAR = /^[a-z][a-z0-9-]{1,63}$/;
const SKILL_GRAMMAR = /^skill:[a-z][a-z0-9-]{1,63}$/;

/**
 * Resolve a unit name to its catalog entry. A malformed name is a 400; a
 * well-formed name the catalog does not list is a 404 — activating a ghost
 * would record a composition that means nothing.
 * @param {unknown} unit
 */
export function lookupSpacePackageUnit(unit) {
  if (typeof unit !== 'string' || (!PACKAGE_GRAMMAR.test(unit) && !SKILL_GRAMMAR.test(unit))) {
    throw new ValidationError('unit must be a package slug or skill:<slug> of at most 64 characters', { field: 'unit' });
  }
  const entry = UNIT_BY_NAME.get(unit);
  if (!entry) {
    throw new AppError(`Unknown personalization unit "${unit}": activate only a unit the catalog lists`, {
      code: 'SPACE_PACKAGE_UNKNOWN', status: 404,
    });
  }
  return entry;
}

/**
 * Scope identity for one unit of one space, escaped so two different
 * (space, unit) pairs never stringify identically (see `escapeKeyPart`).
 * Built in one place so the create path and the race re-read always agree.
 */
export function compositionKeyFor(spaceId, unit) {
  return `${escapeKeyPart(spaceId)}:${escapeKeyPart(unit)}`;
}

/** Read-only managed storage handle; a CRUD-writable module is refused. */
function trusted(modules, name, code) {
  const service = modules?.get?.(name)?.service;
  if (!service || typeof service.createManaged !== 'function' || typeof service.applyManaged !== 'function') {
    throw new AppError(`Module "${name}" is not a read-only managed record module — regenerate it from the current manifest`, {
      code, status: 500,
    });
  }
  return service;
}

/**
 * A readable module handle, or null when the app did not compose the module.
 * The real module registry throws NOT_FOUND for a missing module instead of
 * answering undefined, so only that absence is mapped to null — anything
 * else still fails loudly.
 */
function readable(modules, name) {
  let service;
  try {
    service = modules?.get?.(name)?.service;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'NOT_FOUND') return null;
    throw error;
  }
  if (!service || typeof service.listWhere !== 'function') return null;
  return service;
}

function serverNow(now) {
  return typeof now === 'function' ? now : () => new Date().toISOString();
}

/**
 * The `space-package` composition operations: activate, deactivate, preview.
 *
 * `activate` records that a space switched a unit on: the first activation
 * creates the row, repeating it replays the row, and flipping a removed unit
 * back on reactivates it. Every write names its actor; an anonymous write
 * stops with `SPACE_ACTOR_REQUIRED`.
 *
 * `preview` (the backoffice "Prova") demonstrates a unit on a real case of
 * the space — the unit's space-scoped rows, one real row as the example —
 * and performs zero writes by construction: this path never calls
 * `createManaged` or `applyManaged`, and the operation test asserts the
 * database is byte-identical before and after.
 *
 * @param {{modules?: any, now?: () => string}} context
 */
export function createSpacePackageOperations(context = {}) {
  const modules = context?.modules;
  const clock = serverNow(context?.now);

  function compositionStore() {
    return trusted(modules, 'space-package', 'SPACE_PACKAGES_STORAGE_INVALID');
  }

  async function currentRow(spaceId, sourceKey) {
    const rows = await compositionStore().listWhere({ spaceId });
    return (Array.isArray(rows) ? rows : []).find((row) => row && row.sourceKey === sourceKey) ?? null;
  }

  /**
   * @param {{spaceId?: unknown, unit?: unknown, actor?: unknown}} params
   */
  async function activate(params) {
    const record = params && typeof params === 'object' ? params : {};
    const by = requireIdentifiedActor(record.actor, 'Activating a package or skill');
    const spaceId = checkSpaceId(record.spaceId);
    const entry = lookupSpacePackageUnit(record.unit);
    const sourceKey = compositionKeyFor(spaceId, entry.name);
    const at = clock();
    const existing = await currentRow(spaceId, sourceKey);
    if (existing && existing.status === 'active') {
      return Object.freeze({ spaceId, unit: entry.name, kind: entry.kind, status: 'active', replayed: true, id: existing.id });
    }
    if (existing) {
      const patched = await compositionStore().applyManaged(
        existing.id, { status: 'active', activatedBy: by, activatedAt: at, removedAt: null }, { actor: record.actor },
      );
      return Object.freeze({ spaceId, unit: entry.name, kind: entry.kind, status: 'active', replayed: false, reactivated: true, id: patched?.id ?? existing.id });
    }
    try {
      const created = await compositionStore().createManaged({
        spaceId, sourceKey, unit: entry.name, kind: entry.kind, status: 'active',
        activatedBy: by, activatedAt: at,
      }, { actor: record.actor });
      return Object.freeze({ spaceId, unit: entry.name, kind: entry.kind, status: 'active', replayed: false, id: created.id });
    } catch (error) {
      // A concurrent first activation won the unique sourceKey. Re-read the
      // winner and answer from it instead of surfacing a driver error.
      if (!isUniqueConflict(error)) throw error;
      const winner = await currentRow(spaceId, sourceKey);
      if (!winner) {
        throw new AppError('This activation raced a concurrent write; retry the activation', {
          code: 'SPACE_PACKAGE_CONFLICT', status: 409,
        });
      }
      if (winner.status === 'active') {
        return Object.freeze({ spaceId, unit: entry.name, kind: entry.kind, status: 'active', replayed: true, id: winner.id });
      }
      const patched = await compositionStore().applyManaged(
        winner.id, { status: 'active', activatedBy: by, activatedAt: at, removedAt: null }, { actor: record.actor },
      );
      return Object.freeze({ spaceId, unit: entry.name, kind: entry.kind, status: 'active', replayed: false, reactivated: true, id: patched?.id ?? winner.id });
    }
  }

  /**
   * @param {{spaceId?: unknown, unit?: unknown, actor?: unknown}} params
   */
  async function deactivate(params) {
    const record = params && typeof params === 'object' ? params : {};
    const by = requireIdentifiedActor(record.actor, 'Deactivating a package or skill');
    void by;
    const spaceId = checkSpaceId(record.spaceId);
    const entry = lookupSpacePackageUnit(record.unit);
    const sourceKey = compositionKeyFor(spaceId, entry.name);
    const existing = await currentRow(spaceId, sourceKey);
    if (!existing || existing.status !== 'active') {
      throw new AppError(`Unit "${entry.name}" is not active in this space: nothing to deactivate`, {
        code: 'SPACE_PACKAGE_NOT_ACTIVE', status: 409,
      });
    }
    await compositionStore().applyManaged(existing.id, { status: 'removed', removedAt: clock() }, { actor: record.actor });
    return Object.freeze({ spaceId, unit: entry.name, kind: entry.kind, status: 'removed', id: existing.id });
  }

  /**
   * @param {{spaceId?: unknown, unit?: unknown}} params
   */
  async function preview(params) {
    const record = params && typeof params === 'object' ? params : {};
    const spaceId = checkSpaceId(record.spaceId);
    const entry = lookupSpacePackageUnit(record.unit);
    const sourceKey = compositionKeyFor(spaceId, entry.name);
    const existing = await currentRow(spaceId, sourceKey);
    const active = existing?.status === 'active';
    if (entry.kind === 'skill') {
      const siblings = await compositionStore().listWhere({ spaceId });
      const activeUnits = (Array.isArray(siblings) ? siblings : [])
        .filter((row) => row && row.status === 'active')
        .map((row) => row.unit)
        .sort();
      return Object.freeze({
        spaceId, unit: entry.name, kind: entry.kind, label: entry.label,
        active, activatedAt: active ? (existing.activatedAt ?? null) : null,
        counts: Object.freeze([]), uncomposed: Object.freeze([]), realCase: null,
        requires: entry.requires, activeUnits: Object.freeze(activeUnits),
        headline: active
          ? `«${entry.label}» è attiva in questo spazio con ${activeUnits.length} unità accese.`
          : `«${entry.label}» richiede «${entry.requires.command}» (${entry.requires.tier}).`,
        writes: 0,
      });
    }
    const counts = [];
    const uncomposed = [];
    let realCase = null;
    for (const name of entry.modules) {
      const service = readable(modules, name);
      if (!service) {
        uncomposed.push(name);
        continue;
      }
      const rows = await service.listWhere({ spaceId });
      const list = Array.isArray(rows) ? rows : [];
      counts.push({ module: name, count: list.length });
      if (realCase === null && entry.demo === name && list.length > 0) {
        realCase = { module: name, id: list[0]?.id ?? null };
      }
    }
    const total = counts.reduce((sum, row) => sum + row.count, 0);
    const head = total === 0
      ? `«${entry.label}» non ha ancora righe in questo spazio: la prova non scrive nulla.`
      : `«${entry.label}»: ${total} righe in questo spazio, ad esempio ${realCase?.module ?? entry.demo} ${realCase?.id ?? ''}. La prova non scrive nulla.`;
    return Object.freeze({
      spaceId, unit: entry.name, kind: entry.kind, label: entry.label,
      active, activatedAt: active ? (existing?.activatedAt ?? null) : null,
      counts: Object.freeze(counts.map((row) => Object.freeze(row))),
      uncomposed: Object.freeze(uncomposed),
      realCase: realCase === null ? null : Object.freeze(realCase),
      headline: head.trim(),
      writes: 0,
    });
  }

  return Object.freeze({ activate, deactivate, preview });
}

/**
 * The `set-space-ai-permission` composition operation (BO-F0-06, backoffice
 * "08 Spazi e accessi"): the only HTTP-reachable flip path for the five AI
 * switches of one space.
 *
 * It runs the SAME code as the `space-permission-override.set-permission`
 * record action — same input checks, same human-only refusal, same
 * create-on-first-flip with the same concurrent-winner retry — never a copy
 * of it (MEM_ACC_REUSE). The action runtime's transaction, outbox and step
 * collector stay on the record path; here the switch write is one atomic
 * managed write, the unique `scopeKey` still serializes two concurrent first
 * flips, and the actor still names the human in the row and the audit. The
 * one thing the operation does NOT skip is the execution trace: it collects
 * the action's own steps and persists a `workflow_runs` row through the
 * published `writeTrace` surface (the e.g. catalog-sync ADR-016 envelope),
 * best-effort after the flip commits — a trace failure is logged and never
 * masks the flip's outcome.
 *
 * @param {{modules?: any, database?: any}} context
 */
export function createSetSpaceAiPermissionOperation(context = {}) {
  const modules = context?.modules;
  const database = context?.database;
  const action = buildSetPermissionAction();

  /**
   * @param {{spaceId?: unknown, permission?: unknown, enabled?: unknown, actor?: unknown}} params
   */
  async function setPermission(params) {
    const record = params && typeof params === 'object' ? params : {};
    const service = trusted(modules, 'space-permission-override', 'SPACE_PERMISSIONS_STORAGE_INVALID');
    const runId = randomUUID();
    const startedAt = nowIso();
    const steps = [];
    const step = (name, output) => {
      steps.push({ name, status: 'completed', output: output ?? null });
    };
    let failure = null;
    let output = null;
    try {
      const run = () => action.execute({
        input: { spaceId: record.spaceId, permission: record.permission, enabled: record.enabled },
        actor: record.actor,
        modules,
        managed: (id, patch) => service.applyManaged(id, patch, { actor: record.actor }),
        step,
      });
      if (database && typeof database.transactionAsync === 'function') {
        output = await database.transactionAsync(run);
      } else {
        output = await run();
      }
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      if (database) {
        try {
          await Promise.resolve(writeTrace(database, {
            runId,
            workflowName: 'space-permission-override.set-permission',
            status: failure ? 'failed' : 'completed',
            input: {
              spaceId: record.spaceId,
              permission: record.permission,
              enabled: record.enabled,
              actor: record.actor && typeof record.actor === 'object'
                ? { type: record.actor.type ?? null, id: record.actor.id ?? null }
                : null,
            },
            output: failure ? null : output,
            error: failure ? (failure.message ?? String(failure)) : null,
            startedAt,
            steps,
          }));
        } catch (traceError) {
          console.error(`[accordo] space-permission-override.set-permission run ${runId}: failed to persist trace: ${traceError instanceof Error ? traceError.message : String(traceError)}`);
        }
      }
    }
    return output;
  }

  return Object.freeze({ set: setPermission });
}

/**
 * The `effective-space-ai-permissions` composition operation (BO-F0-06,
 * backoffice "08 Spazi e accessi"): the only HTTP-reachable read path for the
 * five AI switches of one space.
 *
 * The generic `/api/modules/space-permission-override/records` surface cannot
 * serve this screen: that module's `filterableFields` is deliberately
 * index-backed only (ADR-008 addendum 2 — `id`, `scopeKey`), so a
 * `filter.spaceId` read is refused instead of answered. This operation reads
 * server-side with the store's own `listWhere({ spaceId })` — the same seam
 * `preview` uses — and resolves the five effective values with
 * `resolveSpacePermissions`, the same function the gate capability uses. No
 * row of another space ever leaves the server: the read is scoped before it
 * is shaped, so the browser cannot see what the operator must not see.
 *
 * @param {{modules?: any}} context
 */
export function createEffectiveSpaceAiPermissionsOperation(context = {}) {
  const modules = context?.modules;

  /**
   * @param {{spaceId?: unknown}} params
   */
  async function effective(params) {
    const record = params && typeof params === 'object' ? params : {};
    const id = checkSpaceId(record.spaceId);
    const service = trusted(modules, 'space-permission-override', 'SPACE_PERMISSIONS_STORAGE_INVALID');
    const rows = await service.listWhere({ spaceId: id });
    const list = Array.isArray(rows) ? rows : [];
    return Object.freeze({
      spaceId: id,
      overrides: Object.freeze(list.map((row) => Object.freeze({
        spaceId: row?.spaceId,
        permission: row?.permission,
        enabled: row?.enabled,
      }))),
      resolved: resolveSpacePermissions(id, list),
    });
  }

  return Object.freeze({ effective });
}
