// @ts-check

import { AppError, ValidationError, definePackage } from '../../../../packages/core/index.js';

/**
 * **A customer-authored package that consumes `intelligence@1`.**
 *
 * It exists to answer a question the extraction could not otherwise answer:
 * *is the capability that replaced the ambient field actually consumable?*
 *
 * Before this package, `intelligence@1` was offered, conformance-checked and
 * resolvable — and `crm app inspect` reported it with `consumers: []`. A
 * capability nothing consumes is proved to *resolve*, not proved to *work*, and
 * "the registry did not complain" is exactly the kind of self-report the
 * framework refuses everywhere else.
 *
 * What it models, honestly: a reviewer disclosing **which declared scoring
 * model** they are relying on for a lead, and freezing that model's
 * declared-definition fingerprint at the moment of disclosure. If the model is
 * republished later, the disclosure still says what was declared when it was
 * made. That is a real use for the capability's read surface — explaining a
 * decision by naming the versioned definition behind it.
 *
 * What it proves about the seam:
 *   - a **customer-authored** package obtains `intelligence@1` by declaring it,
 *     with no privilege a first-party package has and it lacks (ADR-021 §6);
 *   - it reaches Intelligence **only** through `domains.capability(...)` — it
 *     imports nothing from `packages/intelligence/**` and could not, because
 *     that path is private;
 *   - a composition without Intelligence fails at **startup** with the edge
 *     named, not at runtime inside a transaction.
 *
 * What it deliberately does not do: score anything, read an Intelligence
 * record, or reach Intelligence storage. The capability grants none of that,
 * which is the point.
 */

export const SCORE_DISCLOSURE_PACKAGE = 'score-disclosure';
export const SCORE_DISCLOSURE_RESOURCES = Object.freeze(['score-disclosure']);

/** The capability this package cannot work without. */
export const REQUIRED_CAPABILITY = Object.freeze({ package: 'intelligence', capability: 'intelligence', version: 1 });

/**
 * Open `intelligence@1` through the public package path.
 *
 * A missing or wrong-version capability is a stable, named refusal rather than
 * a `TypeError` on `undefined` — the same shape Delivery uses for
 * `delivery-obligations@1`.
 *
 * @param {{domains: any, modules: any, actor?: unknown, now?: () => string}} ctx
 */
function intelligenceCapability({ domains, modules, actor, now }) {
  try {
    return domains.capability({
      consumer: SCORE_DISCLOSURE_PACKAGE,
      capability: REQUIRED_CAPABILITY.capability,
      version: REQUIRED_CAPABILITY.version,
      context: { modules, actor, now },
    });
  } catch (error) {
    if (error instanceof AppError && error.status !== 404) throw error;
    throw new AppError(
      'The score-disclosure package requires the intelligence package capability intelligence@1, which is not available',
      { code: 'PACKAGE_DEPENDENCY_MISSING', status: 409 },
    );
  }
}

/** @param {Record<string, string>} [moduleNames] */
function resolvedNames(moduleNames = {}) {
  return {
    lead: moduleNames.lead ?? 'lead',
    disclosure: moduleNames['score-disclosure'] ?? 'score-disclosure',
  };
}

/** @param {Record<string, string>} [moduleNames] */
export function buildDiscloseScoringModelAction(moduleNames) {
  const names = resolvedNames(moduleNames);
  return {
    module: names.lead,
    name: 'disclose-scoring-model',
    label: 'Disclose scoring model',
    description:
      'Record which declared scoring model is being relied on for this lead, freezing the model\'s declared-definition fingerprint as it stands now.',
    actionContract: 1,
    input: [
      { name: 'model', type: 'string', required: true, hint: 'A declared scoring model name.' },
      { name: 'version', type: 'integer', required: true, hint: 'The declared version of that model.' },
    ],
    /** @param {any} ctx */
    async execute({ record, input, actor, modules, domains, now }) {
      // Human boundary: a disclosure is somebody saying "this is what I relied
      // on". An agent may compute a score; it may not sign for one.
      if (!actor || /** @type {any} */ (actor).type !== 'user') {
        throw new AppError('Disclosing a scoring model is a human decision', {
          code: 'HUMAN_APPROVAL_REQUIRED', status: 403,
        });
      }

      const intelligence = intelligenceCapability({ domains, modules, actor, now });
      // The whole interaction with the other domain: one read, of declared
      // metadata. No storage handle, no evaluation, no record of theirs.
      const model = intelligence.scoringModel(input.model, input.version);
      if (!model) {
        throw new ValidationError(
          `Scoring model "${input.model}@${input.version}" is not declared by this application`,
          { field: 'model' },
        );
      }

      const disclosedAt = now();
      // The package's own record, written through the trusted managed path —
      // every field is `writable: "managed"`, so no generic client can forge a
      // disclosure and none can be edited after the fact.
      const disclosures = modules.get(names.disclosure)?.service;
      if (!disclosures?.createManaged) {
        throw new AppError(
          `The score-disclosure package is installed without its "${names.disclosure}" records`,
          { code: 'DISCLOSURE_STORAGE_INVALID', status: 500 },
        );
      }
      return disclosures.createManaged({
        sourceKey: `disclosure:${record.id}:${model.name}@${model.version}`,
        leadId: record.id,
        modelName: model.name,
        modelVersion: model.version,
        modelLabel: model.label ?? model.name,
        modelFingerprint: model.fingerprint,
        ruleCount: Array.isArray(model.rules) ? model.rules.length : 0,
        disclosedBy: String(/** @type {any} */ (actor).id ?? 'unknown'),
        disclosedAt,
      }, { actor });
    },
  };
}

/** @param {{modules?: Record<string, string>}} [options] */
export function createScoreDisclosurePackage(options = {}) {
  return definePackage({
    packageContract: 1,
    name: SCORE_DISCLOSURE_PACKAGE,
    version: 1,
    label: 'Scoring model disclosure',
    description:
      'Records which declared scoring model a human relied on for a lead, with that model\'s declared-definition fingerprint frozen at disclosure time. A customer-authored consumer of intelligence@1.',
    resources: [...SCORE_DISCLOSURE_RESOURCES],
    requires: [{ ...REQUIRED_CAPABILITY }],
    capabilities: [],
    actions: [buildDiscloseScoringModelAction(options.modules)],
    policies: [],
    metadata() {
      return {
        scoreDisclosureContract: 1,
        consumes: 'intelligence@1 — declared scoring model identity, version and fingerprint',
        humanApproval:
          'disclose-scoring-model requires actor.type === "user"; agent actors are refused 403 HUMAN_APPROVAL_REQUIRED. A human-actor boundary, not a role',
        notModeled: [
          'scoring', 'routing', 'enrichment', 'reading any Intelligence record',
          'any claim that the disclosed model was the one that produced a stored score',
        ],
        limitation:
          'A disclosure records what was DECLARED at disclosure time. It does not prove the model was executed, and it is not linked to a score run.',
      };
    },
  });
}
