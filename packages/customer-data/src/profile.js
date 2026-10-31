// @ts-check

import { deciding, newestFirst, optional, subjectKey, subjectOf, trusted } from './store.js';
import { deriveCustomerStatus } from './customer-status.js';

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
export async function canonicalClusterFor({ modules, names, subject }) {
  // Complete reads, not display pages: a cluster that loses members once the
  // link table outgrows a page would deny a human decision that was recorded.
  const links = trusted(modules, names.link);
  const mine = (await deciding(links, {
    subjectResource: subject.resource, subjectId: subject.id, status: 'active',
  }))[0];
  if (!mine) {
    return Object.freeze({
      clusterKey: null,
      canonical: Object.freeze({ ...subject, role: 'canonical' }),
      // Same member shape as a linked cluster, with the motivation fields
      // explicitly null: no decision was ever recorded for this record.
      members: Object.freeze([Object.freeze({
        ...subject, role: 'canonical',
        decisionId: null, decidedAt: null, reason: null, decidedBy: null,
      })]),
      linked: false,
      note: 'no canonical identity decision has been recorded for this record; it stands for itself',
    });
  }
  // The human motivation travels with the member: the scheda cliente shows
  // every linked identity with the reason its decider recorded, and a member
  // without that decision row carries an explicit null — never a guess.
  const members = (await deciding(links, { clusterKey: mine.clusterKey, status: 'active' }))
    .map((row) => Object.freeze({
      ...subjectOf(row),
      role: row.role,
      decisionId: row.decisionId,
      decidedAt: row.decidedAt,
      reason: typeof row.reason === 'string' && row.reason !== '' ? row.reason : null,
      decidedBy: typeof row.decidedById === 'string' && row.decidedById !== ''
        ? Object.freeze({ type: row.decidedByType ?? null, id: row.decidedById })
        : null,
    }))
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
export async function profileFor({ modules, core, names, subject }) {
  const cluster = await canonicalClusterFor({ modules, names, subject });

  // Voce 908f2eb9bbfb: the reads below are independent of each other, so
  // they run together. Sequentially they were dozens of round-trips per
  // profile, and the scheda computes three profiles per open (card,
  // timeline, profile) — the wait stacked past ten seconds and held pool
  // connections long enough to surface as intermittent STORAGE_UNAVAILABLE
  // (503). The results are joined exactly as before: same queries, same
  // order-independent shaping, same errors (a storage failure still fails
  // the profile rather than inventing a partial one).
  const identityService = trusted(modules, names.identity);
  const issueService = trusted(modules, names.issue);
  const candidateService = trusted(modules, names.candidate);
  const [identity, identityRowsNested, issueRowsNested, candidateRowsNested] = await Promise.all([
    // Identity: the host records themselves, read through their own services.
    readIdentity({ modules, subject, cluster }),
    // External identities for every member of the cluster. Asked per member
    // as a complete query rather than filtered out of one page of the whole
    // table.
    Promise.all(cluster.members.map((member) => deciding(identityService, {
      subjectResource: member.resource, subjectId: member.id, status: 'active',
    }))),
    Promise.all(cluster.members.map((member) => deciding(issueService, {
      subjectResource: member.resource, subjectId: member.id, status: 'open',
    }))),
    // A candidate names two records, so each member is asked for on both
    // sides and the answers are unioned by id rather than double-counted.
    Promise.all(cluster.members.flatMap((member) => [
      { leftResource: member.resource, leftId: member.id },
      { rightResource: member.resource, rightId: member.id },
    ].map((side) => deciding(candidateService, { ...side, status: 'unresolved' })))),
  ]);
  const identityRows = identityRowsNested.flat();
  const identities = newestFirst(identityRows)
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
      // Shaped for this subject: on a contact card a company match must not
      // pull in another contact's contact-scoped opportunity (and, through
      // the hop below, its quotes) — or every card shows the same offer.
      opportunityRead = await readSectionRows(
        opportunityService, { companyIds, contactIds, opportunityIds: new Set() }, subject);
    } catch { opportunityRead = null; }
  }
  const opportunityIds = new Set((opportunityRead?.rows ?? []).map((row) => row.id));
  // A quote carries no human name of its own; the scheda names it after the
  // opportunity it was made for, resolved here from the same read above.
  const opportunityNames = new Map((opportunityRead?.rows ?? []).map((row) => [row.id, row.name ?? null]));
  const references = { companyIds, contactIds, opportunityIds };

  // Voce 908f2eb9bbfb: sections are independent of each other (quotes
  // reuses the opportunity read above), so they run together. Each section
  // keeps its own failure: an unreadable section answers available: false,
  // never a partial profile.
  const sections = {};
  await Promise.all(SECTIONS.map(async (section) => {
    sections[section.key] = await readOneSection(section, {
      modules, references, subject, opportunityRead, opportunityNames,
    });
  }));

  const issues = newestFirst(issueRowsNested.flat())
    .map((row) => Object.freeze({ kind: row.kind, evidence: row.evidence, detectedAt: row.detectedAt, subject: subjectOf(row) }));

  // A candidate names two records: the answers were asked for per member on
  // both sides above, and are unioned by id rather than double-counted.
  const candidateRows = new Map();
  for (const rows of candidateRowsNested) {
    for (const row of rows) candidateRows.set(row.id, row);
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
    // The one status verdict, computed here by the owning package's rule so
    // the card and the list share it through the capability, never by each
    // importing the rule. Reads the same three evidence shapes the card and
    // the list both need.
    status: deriveCustomerStatus({
      orders: sections.orders, contracts: sections.contracts, subscriptions: sections.subscriptions,
    }),
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

/**
 * One profile section for one composed package: the exact read the profile
 * loop always did, so a section keeps its own failure (available: false
 * with a reason) instead of failing the profile.
 *
 * @param {{key: string, module: string, owner: string, label: string}} section
 * @param {{modules: any, references: any, subject: any, opportunityRead: any, opportunityNames: Map<string, string|null>}} input
 */
async function readOneSection(section, { modules, references, subject, opportunityRead, opportunityNames }) {
  const service = optional(modules, section.module);
  if (!service || typeof service.list !== 'function') {
    return NOT_AVAILABLE(section.label, section.owner);
  }
  let read;
  try {
    read = section.key === 'opportunities' && opportunityRead
      ? opportunityRead
      : await readSectionRows(service, references);
  } catch {
    return Object.freeze({
      available: false, reason: `${section.label} could not be read from this application`, items: null, count: null,
    });
  }
  if (!read.readable) {
    // The package IS composed — but it declares no reference this projection
    // knows how to follow, so the honest answer is that it cannot be read
    // from here. Reporting `0` would say the customer has none, which is a
    // different and probably untrue statement.
    return Object.freeze({
      available: false,
      reason: `the ${section.owner} package is composed, but its ${section.label} record declares no company, contact or `
        + 'opportunity reference this profile can follow, so they cannot be read from here — this is not a claim that there are none',
      items: null,
      count: null,
    });
  }
  const rows = read.rows;
  return Object.freeze({
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
      // Voce cc525cd6a3c5: stage-only records (opportunities expose stage,
      // never status) still carry a renderable state for the scheda offer
      // line — the card labels it in Italian, never raw English.
      id: row.id, status: row.status ?? row.stage ?? null, name: row.name ?? row.title ?? row.customerName ?? null,
      // Quotes only: the explicit hop this profile followed, kept on the
      // item so the scheda can name the quote after its opportunity and a
      // reader can see which opportunity each quote belongs to. Other
      // sections keep exactly the shape they always had.
      ...(section.key === 'quotes' ? {
        opportunityId: row.opportunityId ?? null,
        opportunityName: row.opportunityId != null
          ? (opportunityNames.get(row.opportunityId) ?? null)
          : null,
      } : {}),
    }))),
    truncated: rows.length > 50,
  });
}

/** Read the host identity records this subject and its cluster name. */
async function readIdentity({ modules, subject, cluster }) {
  const companies = optional(modules, 'company');
  const contacts = optional(modules, 'contact');
  const read = async (service, id) => {
    if (!service || typeof service.get !== 'function') return null;
    try { return await service.get(id); } catch { return null; }
  };
  const canonical = cluster.canonical ?? subject;
  let company = null;
  let contact = null;
  if (canonical.resource === 'company') company = await read(companies, canonical.id);
  if (canonical.resource === 'contact') {
    contact = await read(contacts, canonical.id);
    if (contact?.companyId) company = await read(companies, contact.companyId);
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
 * @param {{resource: string, id: string} | null} [subject] the card being shaped (narrows contact-scoped rows on contact cards)
 */
async function readSectionRows(service, references, subject = null) {
  const shapes = [
    { companyId: [...references.companyIds] },
    { contactId: [...references.contactIds] },
    { opportunityId: [...references.opportunityIds] },
    { subjectResource: 'company', subjectId: [...references.companyIds] },
    { subjectResource: 'contact', subjectId: [...references.contactIds] },
  ];
  if (typeof service.listWhere === 'function') {
    // Voce 908f2eb9bbfb: the shapes are independent queries, so they run
    // together. A shape that rejects is a shape the module does not declare
    // — skipped exactly as the sequential loop skipped it.
    const active = shapes.filter((filters) =>
      Object.values(filters).some((value) => Array.isArray(value) && value.length > 0));
    const settled = await Promise.all(active.map((filters) => Promise.resolve()
      .then(() => service.listWhere(filters))
      .then(
        (rows) => ({ ok: true, rows }),
        () => ({ ok: false, rows: [] }),
      )));
    const byId = new Map();
    let queryable = false;
    for (const result of settled) {
      if (!result.ok) continue;
      queryable = true;
      for (const row of result.rows) byId.set(row.id, row);
    }
    return queryable
      ? { readable: true, rows: newestFirst([...byId.values()]), complete: true }
      : { readable: false };
  }
  return {
    readable: true,
    rows: (await service.list({ limit: 500 })).filter((row) => belongsToCustomer(row, references, subject)),
    complete: false,
  };
}

/**
 * Does this row belong to the customer? Only by explicit reference — this
 * never guesses from a name or an email string, because a projection that
 * guesses is a projection that quietly attributes somebody else's contract.
 * Shared with the customer list (BO-F1-05), which attributes the same batched
 * rows to the same customers by the same rule.
 *
 * A row scoped to one contact (its `contactId` set) belongs to that contact's
 * card only: on a contact card a company match must not leak somebody else's
 * contact-scoped record, or every card in the company shows the same offer.
 * The explicit contact link wins over the company one (the opportunity record
 * itself enforces that its contact belongs to its company at creation, so a
 * matching contact implies a consistent company). Company cards keep the
 * wider rule: a company sees everything under it, contact-scoped included.
 *
 * @param {{resource: string, id: string} | null} [subject]
 *   The card being shaped. Omit it (or pass a company subject) for the wide
 *   rule; pass the contact subject to narrow contact-scoped rows to it.
 */
export function belongsToCustomer(row, { companyIds, contactIds, opportunityIds }, subject = null) {
  if (subject?.resource === 'contact' && row.contactId != null && row.contactId !== '') {
    return contactIds.has(row.contactId);
  }
  if (row.companyId && companyIds.has(row.companyId)) return true;
  if (row.contactId && contactIds.has(row.contactId)) return true;
  if (row.opportunityId && opportunityIds.has(row.opportunityId)) return true;
  if (row.subjectResource === 'company' && companyIds.has(row.subjectId)) return true;
  if (row.subjectResource === 'contact' && contactIds.has(row.subjectId)) return true;
  return false;
}
