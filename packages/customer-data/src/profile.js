// @ts-check

import { deciding, newestFirst, optional, subjectKey, subjectOf, trusted } from './store.js';

/**
 * **The consolidated profile: a projection, never a table.**
 *
 * Nothing here is stored. The profile is computed on read from records the
 * owning packages already hold, which is the whole reason this foundation does
 * not need a master customer row: the truth stays where it is, and this reads
 * across it.
 *
 * The rule that matters most is how **absence** is reported. Every contributing
 * package is optional. When one is not composed, its section answers
 * `available: false` with a reason — never `[]`, never `0`, never "none". An
 * empty list from a package that is not installed would be a lie in the exact
 * place a reader is most likely to believe it.
 *
 * The profile also refuses to call itself a timeline: marketing, analytics and
 * any external channel are absent by construction, so it says
 * `completeTimeline: false` and names what it does not span.
 */

/** Sections, and the record each needs to exist for the section to be real. */
const SECTIONS = Object.freeze([
  { key: 'opportunities', module: 'opportunity', owner: 'host', label: 'open opportunities' },
  { key: 'quotes', module: 'quote', owner: 'commercial', label: 'quotes' },
  { key: 'orders', module: 'order', owner: 'signature', label: 'signed orders' },
  { key: 'contracts', module: 'commercial-contract', owner: 'contracts', label: 'commercial contracts' },
  { key: 'subscriptions', module: 'subscription', owner: 'contracts', label: 'subscriptions' },
  { key: 'deliveryProjects', module: 'delivery-project', owner: 'delivery', label: 'delivery projects' },
  { key: 'serviceCoverages', module: 'service-coverage', owner: 'service', label: 'service coverage' },
  { key: 'supportCases', module: 'support-case', owner: 'service', label: 'support cases' },
  { key: 'workTasks', module: 'work-task', owner: 'work', label: 'work tasks' },
  { key: 'successions', module: 'contract-succession', owner: 'lifecycle', label: 'renewal and amendment lineage' },
]);

const NOT_AVAILABLE = (label, owner) => Object.freeze({
  available: false,
  reason: `the ${owner} package is not composed in this application, so ${label} are not available — this is not a claim that there are none`,
  items: null,
  count: null,
});

/**
 * Every canonical-link member of the cluster this subject belongs to, or just
 * the subject itself when no human has linked anything.
 *
 * @param {{modules: any, names: any, subject: {resource: string, id: string}}} input
 */
export function canonicalClusterFor({ modules, names, subject }) {
  // Complete reads, not display pages: a cluster that loses members once the
  // link table outgrows a page would deny a human decision that was recorded.
  const links = trusted(modules, names.link);
  const mine = deciding(links, {
    subjectResource: subject.resource, subjectId: subject.id, status: 'active',
  })[0];
  if (!mine) {
    return Object.freeze({
      clusterKey: null,
      canonical: Object.freeze({ ...subject, role: 'canonical' }),
      members: Object.freeze([Object.freeze({ ...subject, role: 'canonical' })]),
      linked: false,
      note: 'no canonical identity decision has been recorded for this record; it stands for itself',
    });
  }
  const members = deciding(links, { clusterKey: mine.clusterKey, status: 'active' })
    .map((row) => Object.freeze({ ...subjectOf(row), role: row.role, decisionId: row.decisionId, decidedAt: row.decidedAt }))
    .sort((a, b) => (a.role === b.role ? subjectKey(a).localeCompare(subjectKey(b)) : a.role === 'canonical' ? -1 : 1));
  return Object.freeze({
    clusterKey: mine.clusterKey,
    canonical: members.find((member) => member.role === 'canonical') ?? null,
    members: Object.freeze(members),
    linked: true,
    note: 'this is a LOGICAL canonical merge: every record below still exists, still resolves and was never rewritten',
  });
}

/**
 * The profile for one subject.
 *
 * @param {{modules: any, core: any, names: any, subject: {resource: string, id: string}}} input
 */
export function profileFor({ modules, core, names, subject }) {
  const cluster = canonicalClusterFor({ modules, names, subject });

  // Identity: the host records themselves, read through their own services.
  const identity = readIdentity({ modules, subject, cluster });

  // External identities for every member of the cluster. Asked per member as a
  // complete query rather than filtered out of one page of the whole table.
  const identityService = trusted(modules, names.identity);
  const identities = newestFirst(cluster.members.flatMap((member) => deciding(identityService, {
    subjectResource: member.resource, subjectId: member.id, status: 'active',
  })))
    .map((row) => Object.freeze({
      system: row.system, externalId: row.externalId, subject: subjectOf(row),
      firstObservedAt: row.firstObservedAt, lastObservedAt: row.lastObservedAt,
    }));

  const companyIds = new Set(cluster.members.filter((m) => m.resource === 'company').map((m) => m.id));
  const contactIds = new Set(cluster.members.filter((m) => m.resource === 'contact').map((m) => m.id));
  if (identity.company?.id) companyIds.add(identity.company.id);
  if (identity.contact?.id) contactIds.add(identity.contact.id);

  // The customer's own opportunities are resolved first, because a quote names
  // an opportunity rather than a company. Following that one explicit reference
  // is how a commercial record reaches the customer it belongs to — and it is a
  // reference, not a guess: the hop goes through records this profile has
  // already resolved for this customer.
  const opportunityService = optional(modules, 'opportunity');
  let opportunityRead = null;
  if (opportunityService && typeof opportunityService.list === 'function') {
    try {
      opportunityRead = readSectionRows(opportunityService, { companyIds, contactIds, opportunityIds: new Set() });
    } catch { opportunityRead = null; }
  }
  const opportunityIds = new Set((opportunityRead?.rows ?? []).map((row) => row.id));
  const references = { companyIds, contactIds, opportunityIds };

  const sections = {};
  for (const section of SECTIONS) {
    const service = optional(modules, section.module);
    if (!service || typeof service.list !== 'function') {
      sections[section.key] = NOT_AVAILABLE(section.label, section.owner);
      continue;
    }
    let read;
    try {
      read = section.key === 'opportunities' && opportunityRead
        ? opportunityRead
        : readSectionRows(service, references);
    } catch {
      sections[section.key] = Object.freeze({
        available: false, reason: `${section.label} could not be read from this application`, items: null, count: null,
      });
      continue;
    }
    if (!read.readable) {
      // The package IS composed — but it declares no reference this projection
      // knows how to follow, so the honest answer is that it cannot be read
      // from here. Reporting `0` would say the customer has none, which is a
      // different and probably untrue statement.
      sections[section.key] = Object.freeze({
        available: false,
        reason: `the ${section.owner} package is composed, but its ${section.label} record declares no company, contact or `
          + 'opportunity reference this profile can follow, so they cannot be read from here — this is not a claim that there are none',
        items: null,
        count: null,
      });
      continue;
    }
    const rows = read.rows;
    sections[section.key] = Object.freeze({
      available: true,
      count: rows.length,
      // A count is a claim. When the owning service offers no exact query at
      // all — a handwritten core module — the only read available is a bounded
      // display page, and a number taken from a page is not a count of a table.
      countIsComplete: read.complete,
      ...(read.complete ? {} : {
        countNote: `${section.label} were read from a bounded page of the owning module, so this count is at least this many, not exactly this many`,
      }),
      items: Object.freeze(rows.slice(0, 50).map((row) => Object.freeze({
        id: row.id, status: row.status ?? null, name: row.name ?? row.title ?? row.customerName ?? null,
      }))),
      truncated: rows.length > 50,
    });
  }

  const issueService = trusted(modules, names.issue);
  const issues = newestFirst(cluster.members.flatMap((member) => deciding(issueService, {
    subjectResource: member.resource, subjectId: member.id, status: 'open',
  })))
    .map((row) => Object.freeze({ kind: row.kind, evidence: row.evidence, detectedAt: row.detectedAt, subject: subjectOf(row) }));

  // A candidate names two records, so each member is asked for on both sides
  // and the two answers are unioned by id rather than double-counted.
  const candidateService = trusted(modules, names.candidate);
  const candidateRows = new Map();
  for (const member of cluster.members) {
    for (const side of [{ leftResource: member.resource, leftId: member.id }, { rightResource: member.resource, rightId: member.id }]) {
      for (const row of deciding(candidateService, { ...side, status: 'unresolved' })) candidateRows.set(row.id, row);
    }
  }
  const candidates = newestFirst([...candidateRows.values()])
    .map((row) => Object.freeze({
      left: subjectOf(row, 'left'), right: subjectOf(row, 'right'), rule: row.rule, evidence: row.evidence,
    }));

  return Object.freeze({
    customerProfileContract: 1,
    subject: Object.freeze({ ...subject }),
    canonicalIdentity: cluster,
    identity,
    externalIdentities: Object.freeze(identities),
    ...sections,
    dataQualityIssues: Object.freeze(issues),
    duplicateCandidates: Object.freeze(candidates),
    completeTimeline: false,
    timelineNote:
      'This profile spans Accordo-managed records only. It is not a cross-channel customer timeline: marketing, '
      + 'analytics, product telemetry and any external system are not represented, and no package here emits one.',
    limitations: Object.freeze([
      'A section marked available: false means the owning package is not composed — it is NOT a statement that the customer has none.',
      'Canonical identity is a logical link: every listed record still exists and was never rewritten or deleted.',
      'No RBAC exists; the Production Spine is absent, so this is local-development posture.',
    ]),
  });
}

/** Read the host identity records this subject and its cluster name. */
function readIdentity({ modules, subject, cluster }) {
  const companies = optional(modules, 'company');
  const contacts = optional(modules, 'contact');
  const read = (service, id) => {
    if (!service || typeof service.get !== 'function') return null;
    try { return service.get(id); } catch { return null; }
  };
  const canonical = cluster.canonical ?? subject;
  let company = null;
  let contact = null;
  if (canonical.resource === 'company') company = read(companies, canonical.id);
  if (canonical.resource === 'contact') {
    contact = read(contacts, canonical.id);
    if (contact?.companyId) company = read(companies, contact.companyId);
  }
  return Object.freeze({
    company: company ? Object.freeze({ id: company.id, name: company.name, domain: company.domain ?? null }) : null,
    contact: contact ? Object.freeze({ id: contact.id, email: contact.email, firstName: contact.firstName, lastName: contact.lastName }) : null,
    note: company || contact ? null : 'the canonical record for this subject could not be read from the host application',
  });
}

/**
 * One section's rows for this customer.
 *
 * Preferred path: the **complete** exact-match query, asked once per reference
 * shape this projection understands. A generated module that declares none of
 * them is not readable from here at all, and says so — a `0` would be a claim
 * that the customer has none. A handwritten service with no exact query leaves
 * only the bounded display page, which is returned but flagged, because a
 * number taken from a page is not a count of the table.
 *
 * @param {any} service
 * @param {{companyIds: Set<string>, contactIds: Set<string>, opportunityIds: Set<string>}} references
 */
function readSectionRows(service, references) {
  const shapes = [
    { companyId: [...references.companyIds] },
    { contactId: [...references.contactIds] },
    { opportunityId: [...references.opportunityIds] },
    { subjectResource: 'company', subjectId: [...references.companyIds] },
    { subjectResource: 'contact', subjectId: [...references.contactIds] },
  ];
  if (typeof service.listWhere === 'function') {
    const byId = new Map();
    let queryable = false;
    for (const filters of shapes) {
      if (!Object.values(filters).some((value) => Array.isArray(value) && value.length > 0)) continue;
      try {
        for (const row of service.listWhere(filters)) byId.set(row.id, row);
        queryable = true;
      } catch {
        // The module does not declare this reference shape. Try the next one.
      }
    }
    return queryable
      ? { readable: true, rows: newestFirst([...byId.values()]), complete: true }
      : { readable: false };
  }
  return {
    readable: true,
    rows: service.list({ limit: 500 }).filter((row) => belongsToCustomer(row, references)),
    complete: false,
  };
}

/**
 * Does this row belong to the customer? Only by explicit reference — this
 * never guesses from a name or an email string, because a projection that
 * guesses is a projection that quietly attributes somebody else's contract.
 */
function belongsToCustomer(row, { companyIds, contactIds, opportunityIds }) {
  if (row.companyId && companyIds.has(row.companyId)) return true;
  if (row.contactId && contactIds.has(row.contactId)) return true;
  if (row.opportunityId && opportunityIds.has(row.opportunityId)) return true;
  if (row.subjectResource === 'company' && companyIds.has(row.subjectId)) return true;
  if (row.subjectResource === 'contact' && contactIds.has(row.subjectId)) return true;
  return false;
}
