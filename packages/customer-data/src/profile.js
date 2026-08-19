// @ts-check

import { optional, subjectKey, subjectOf, trusted } from './store.js';

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
  const links = trusted(modules, names.link).list({ limit: 1000 }).filter((row) => row.status === 'active');
  const mine = links.find((row) => row.subjectResource === subject.resource && row.subjectId === subject.id);
  if (!mine) {
    return Object.freeze({
      clusterKey: null,
      canonical: Object.freeze({ ...subject, role: 'canonical' }),
      members: Object.freeze([Object.freeze({ ...subject, role: 'canonical' })]),
      linked: false,
      note: 'no canonical identity decision has been recorded for this record; it stands for itself',
    });
  }
  const members = links
    .filter((row) => row.clusterKey === mine.clusterKey)
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
  const memberKeys = new Set(cluster.members.map((member) => subjectKey(member)));

  // Identity: the host records themselves, read through their own services.
  const identity = readIdentity({ modules, subject, cluster });

  // External identities for every member of the cluster.
  const identities = trusted(modules, names.identity).list({ limit: 1000 })
    .filter((row) => row.status === 'active' && memberKeys.has(subjectKey({ resource: row.subjectResource, id: row.subjectId })))
    .map((row) => Object.freeze({
      system: row.system, externalId: row.externalId, subject: subjectOf(row),
      firstObservedAt: row.firstObservedAt, lastObservedAt: row.lastObservedAt,
    }));

  const companyIds = new Set(cluster.members.filter((m) => m.resource === 'company').map((m) => m.id));
  const contactIds = new Set(cluster.members.filter((m) => m.resource === 'contact').map((m) => m.id));
  if (identity.company?.id) companyIds.add(identity.company.id);
  if (identity.contact?.id) contactIds.add(identity.contact.id);

  const sections = {};
  for (const section of SECTIONS) {
    const service = optional(modules, section.module);
    if (!service || typeof service.list !== 'function') {
      sections[section.key] = NOT_AVAILABLE(section.label, section.owner);
      continue;
    }
    let rows = [];
    try {
      rows = service.list({ limit: 500 }).filter((row) => belongsToCustomer(row, companyIds, contactIds));
    } catch {
      sections[section.key] = Object.freeze({
        available: false, reason: `${section.label} could not be read from this application`, items: null, count: null,
      });
      continue;
    }
    sections[section.key] = Object.freeze({
      available: true,
      count: rows.length,
      items: Object.freeze(rows.slice(0, 50).map((row) => Object.freeze({
        id: row.id, status: row.status ?? null, name: row.name ?? row.title ?? row.customerName ?? null,
      }))),
      truncated: rows.length > 50,
    });
  }

  const issues = trusted(modules, names.issue).list({ limit: 1000 })
    .filter((row) => row.status === 'open' && memberKeys.has(subjectKey({ resource: row.subjectResource, id: row.subjectId })))
    .map((row) => Object.freeze({ kind: row.kind, evidence: row.evidence, detectedAt: row.detectedAt, subject: subjectOf(row) }));

  const candidates = trusted(modules, names.candidate).list({ limit: 1000 })
    .filter((row) => row.status === 'unresolved'
      && (memberKeys.has(subjectKey({ resource: row.leftResource, id: row.leftId }))
        || memberKeys.has(subjectKey({ resource: row.rightResource, id: row.rightId }))))
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
 * Does this row belong to the customer? Only by explicit reference — this
 * never guesses from a name or an email string, because a projection that
 * guesses is a projection that quietly attributes somebody else's contract.
 */
function belongsToCustomer(row, companyIds, contactIds) {
  if (row.companyId && companyIds.has(row.companyId)) return true;
  if (row.contactId && contactIds.has(row.contactId)) return true;
  if (row.subjectResource === 'company' && companyIds.has(row.subjectId)) return true;
  if (row.subjectResource === 'contact' && contactIds.has(row.subjectId)) return true;
  return false;
}
