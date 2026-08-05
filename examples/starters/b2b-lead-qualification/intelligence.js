// @ts-check

/**
 * Lead Intelligence fixtures for the B2B starter (ADR-015): a deterministic
 * enrichment provider, versioned explainable scoring models, versioned
 * routing policies and routing targets.
 *
 * The provider behaves like an external service without needing one: results
 * derive deterministically from the lead's email domain, and magic domains
 * exercise the failure paths (outage, timeout, invalid data, partial data,
 * immediate expiry). No network, no credentials, no secrets.
 *
 * Versioning: v2 definitions register ALONGSIDE v1 — old runs keep the exact
 * version and fingerprint they executed under. "Rollback" is publishing a new
 * version derived from an earlier definition, never editing a registered one
 * (the persisted fingerprint check fails startup on in-place edits).
 */

/** Deterministic firmographics keyed by email domain. */
const FIRMOGRAPHICS = Object.freeze({
  'acme.example': { companyName: 'Acme', country: 'IT', language: 'it', employeeRange: '200-1000', industry: 'software', revenueRange: '10M-100M' },
  'ferrari.example': { companyName: 'Ferrari Sistemi', country: 'IT', language: 'it', employeeRange: '1000-5000', industry: 'automotive', revenueRange: '>100M' },
  'sevilla.example': { companyName: 'Sevilla Digital', country: 'ES', language: 'es', employeeRange: '50-200', industry: 'software', revenueRange: '1M-10M' },
  'reykjavik.example': { companyName: 'Reykjavik Hosting', country: 'IS', language: 'is', employeeRange: '10-50', industry: 'hosting', revenueRange: '<1M' },
});

export const fixtureFirmographicsProvider = {
  name: 'fixture-firmographics',
  version: 1,
  label: 'Fixture firmographics (deterministic)',
  capabilities: ['company'],
  /** @param {{lead: any}} input @param {{now: () => string}} context */
  async enrichCompany({ lead }, { now }) {
    const domain = typeof lead.email === 'string' && lead.email.includes('@') ? lead.email.split('@')[1].toLowerCase() : null;
    if (domain === 'fail.example') throw new Error('simulated provider outage');
    if (domain === 'slow.example') return new Promise(() => {}); // never resolves → timeout path
    if (domain === 'latefail.example') {
      // Rejects AFTER a short timeout window: proves late settlement is
      // observed (no unhandled rejection) and never persisted.
      return new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('late simulated outage')), 400);
      });
    }
    if (domain === 'invalid.example') return { fields: { country: 'Italia' } }; // not ISO-3166 shaped → PROVIDER_INVALID
    if (domain === 'ephemeral.example') {
      // Already-expired snapshot: every enrich creates a new snapshot version.
      return {
        fields: { companyDomain: domain, companyName: 'Ephemeral Labs', country: 'IT', language: 'it' },
        confidence: 60,
        sourceRef: `fixture:${domain}`,
        expiresAt: new Date(Date.parse(now()) - 1000).toISOString(),
      };
    }
    const known = domain ? FIRMOGRAPHICS[/** @type {keyof typeof FIRMOGRAPHICS} */ (domain)] : undefined;
    if (!known) {
      return { fields: { companyDomain: domain }, confidence: 40, sourceRef: `fixture:${domain ?? 'unknown'}`, partial: true };
    }
    return { fields: { ...known, companyDomain: domain }, confidence: 95, sourceRef: `fixture:${domain}` };
  },
};

/**
 * Semantic thresholds live in the model's DECLARED config, not in closures:
 * the config is part of the declared-definition fingerprint, so changing a
 * threshold without publishing a new version is detected at boot. Rules read
 * it via ctx.config (frozen).
 */
const SCORE_CONFIG = {
  supportedCountries: ['IT', 'ES', 'DE'],
  enterpriseRanges: ['1000-5000', '>5000'],
  engagedSignalCount: 3,
};

/** Shared rule set for the b2b-saas-score model (v1 baseline). */
const V1_RULES = [
  {
    key: 'enterprise-company',
    label: 'Enterprise company size',
    weight: 30,
    /** @param {any} ctx */
    evaluate({ snapshot, config }) {
      const matched = snapshot != null && config.enterpriseRanges.includes(snapshot.employeeRange);
      return { matched, reason: matched ? `employee range ${snapshot.employeeRange}` : 'no enterprise employee range' };
    },
  },
  {
    key: 'supported-country',
    label: 'Company in a supported country',
    weight: 10,
    /** @param {any} ctx */
    evaluate({ snapshot, config }) {
      const matched = snapshot != null && config.supportedCountries.includes(snapshot.country);
      return { matched, reason: matched ? `country ${snapshot.country}` : 'no supported country evidence' };
    },
  },
  {
    key: 'demo-requested',
    label: 'Requested a demo',
    weight: 25,
    /** @param {any} ctx */
    evaluate({ signals }) {
      return signals.some((signal) => signal.signalType === 'demo-requested');
    },
  },
  {
    key: 'pricing-page-visited',
    label: 'Visited the pricing page',
    weight: 10,
    /** @param {any} ctx */
    evaluate({ signals }) {
      return signals.some((signal) => signal.signalType === 'pricing-page-visited');
    },
  },
  {
    key: 'highly-engaged',
    label: 'Highly engaged (declared signal-count threshold)',
    weight: 40,
    /** @param {any} ctx */
    evaluate({ signals, config }) {
      return signals.length >= config.engagedSignalCount;
    },
  },
  {
    key: 'missing-company-name',
    label: 'No company name on the lead',
    weight: -15,
    /** @param {any} ctx */
    evaluate({ lead }) {
      return !lead.companyName;
    },
  },
];

export const b2bSaasScoreV1 = {
  name: 'b2b-saas-score',
  version: 1,
  label: 'B2B SaaS fit + engagement score',
  minScore: -100,
  maxScore: 100,
  config: SCORE_CONFIG,
  rules: V1_RULES,
};

export const b2bSaasScoreV2 = {
  name: 'b2b-saas-score',
  version: 2,
  label: 'B2B SaaS fit + engagement score (adds product activation)',
  minScore: -100,
  maxScore: 100,
  config: SCORE_CONFIG,
  rules: [
    ...V1_RULES,
    {
      key: 'product-activated',
      label: 'Activated the product',
      weight: 20,
      /** @param {any} ctx */
      evaluate({ signals }) {
        return signals.some((signal) => signal.signalType === 'product-activated');
      },
    },
  ],
};

export const b2bRoutingV1 = {
  name: 'b2b-sales-routing',
  version: 1,
  label: 'Route by country/language, deterministic rank',
  /** @param {any} ctx */
  route({ snapshot, targets, rank }) {
    const country = snapshot?.country ?? null;
    const language = snapshot?.language ?? null;
    const matches = targets.filter(
      (target) =>
        (target.countries.length === 0 || (country !== null && target.countries.includes(country))) &&
        (target.languages.length === 0 || (language !== null && target.languages.includes(language))),
    );
    if (matches.length === 0) return null; // → declared fallback queue
    const best = rank(matches)[0];
    return { target: best.key, rule: `country/language match (${country ?? '??'}/${language ?? '??'}) → ${best.key}` };
  },
};

export const b2bRoutingV2 = {
  name: 'b2b-sales-routing',
  version: 2,
  label: 'Route by country/language, preferring enterprise skill on high scores',
  // The threshold is DECLARED config (fingerprinted), not a closure value.
  config: { enterpriseScoreThreshold: 60 },
  /** @param {any} ctx */
  route(context) {
    const { score, snapshot, targets, rank, config } = context;
    const base = b2bRoutingV1.route(context);
    if (base === null || score < config.enterpriseScoreThreshold) return base;
    const country = snapshot?.country ?? null;
    const preferred = targets.filter(
      (target) =>
        target.skills.includes('enterprise') &&
        (target.countries.length === 0 || (country !== null && target.countries.includes(country))),
    );
    if (preferred.length === 0) return base;
    const best = rank(preferred)[0];
    return { target: best.key, rule: `high score ${score} prefers enterprise skill → ${best.key}` };
  },
};

export const routingTargets = [
  {
    key: 'enterprise-italy',
    label: 'Enterprise Italy',
    kind: 'team',
    active: true,
    countries: ['IT'],
    languages: ['it'],
    skills: ['enterprise'],
    scoreMin: 50,
    capacity: 5,
    priority: 10,
  },
  {
    key: 'spain-sales',
    label: 'Spain Sales',
    kind: 'team',
    active: true,
    countries: ['ES'],
    languages: ['es'],
    skills: ['midmarket'],
    capacity: 5,
    priority: 5,
  },
  {
    key: 'growth-queue',
    label: 'Growth queue',
    kind: 'queue',
    active: true,
    countries: ['IT', 'ES', 'DE'],
    languages: [],
    skills: [],
    capacity: 3,
    priority: 1,
  },
  {
    key: 'unrouted-queue',
    label: 'Unrouted (needs human triage)',
    kind: 'fallback',
    active: true,
    countries: [],
    languages: [],
    skills: [],
    capacity: null,
    priority: 0,
  },
];
