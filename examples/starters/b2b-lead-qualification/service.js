// @ts-check

/**
 * The starter's Service Activation Policy — one worked example of the contract,
 * not a recommendation about how anybody should sell support.
 *
 * It reads a service obligation and decides what it entitles the customer to.
 * Every decision comes from the obligation and the declared `config`; nothing
 * is read from a clock, a database or the network, and the same obligation
 * always produces the same entitlement.
 *
 * The interesting case is the third one: an obligation whose component key the
 * policy does not recognize is **ambiguous**, not silently defaulted. A human
 * then supplies an override with a stated reason, or the activation refuses.
 * Guessing a support tier is how a customer ends up with a promise nobody made.
 */

export const b2bServiceActivationV1 = {
  name: 'b2b-service-activation',
  version: 1,
  label: 'B2B support activation',
  config: {
    // Keyed by the component name — the last segment of an obligation's
    // `componentKey` — because that is the part a catalog author controls and
    // the part that survives an offer being re-versioned.
    tiers: {
      'support-fee': {
        supportTier: 'standard',
        categories: ['bug', 'how-to', 'incident'],
        priorities: ['low', 'normal', 'high'],
        firstResponseTargetMinutes: 240,
        resolutionTargetMinutes: 2880,
        maxOpenCases: 10,
      },
      'premium-support-fee': {
        supportTier: 'premium',
        categories: ['bug', 'how-to', 'incident', 'onboarding'],
        priorities: ['low', 'normal', 'high', 'urgent'],
        firstResponseTargetMinutes: 60,
        resolutionTargetMinutes: 480,
        maxOpenCases: 50,
      },
    },
  },
  decide({ config, obligation }) {
    const rule = config.tiers[componentName(obligation.componentKey)];
    if (!rule) {
      return {
        outcome: 'ambiguous',
        reason: `this policy has no support rule for component "${componentName(obligation.componentKey)}"`,
      };
    }
    // A one-time obligation is not a support relationship: recurrence is what
    // makes ongoing coverage meaningful, and inferring support rights from a
    // one-off charge is the mistake this branch exists to refuse.
    if (obligation.chargeType !== 'recurring') {
      return {
        outcome: 'ambiguous',
        reason: 'a one-time obligation does not by itself establish ongoing support coverage',
      };
    }
    return {
      supportTier: rule.supportTier,
      categories: [...rule.categories],
      priorities: [...rule.priorities],
      firstResponseTargetMinutes: rule.firstResponseTargetMinutes,
      resolutionTargetMinutes: rule.resolutionTargetMinutes,
      maxOpenCases: rule.maxOpenCases,
      reason: `component "${componentName(obligation.componentKey)}" maps to the ${rule.supportTier} support tier`,
    };
  },
};

/**
 * A second, stricter policy: it recognizes premium support and nothing else.
 *
 * It exists because "the policy could not decide" has to be a path somebody can
 * walk, not a branch nobody exercises. Run an ordinary annual-support
 * obligation through this and it comes back **ambiguous**, which is how a human
 * override with a stated reason gets proved end to end.
 */
export const b2bServiceActivationPremiumOnlyV1 = {
  name: 'b2b-service-activation-premium-only',
  version: 1,
  label: 'B2B premium-only support activation',
  config: {
    tiers: {
      'premium-support-fee': {
        supportTier: 'premium',
        categories: ['bug', 'how-to', 'incident', 'onboarding'],
        priorities: ['low', 'normal', 'high', 'urgent'],
        firstResponseTargetMinutes: 60,
        resolutionTargetMinutes: 480,
        maxOpenCases: 50,
      },
    },
  },
  decide({ config, obligation }) {
    const rule = config.tiers[componentName(obligation.componentKey)];
    if (!rule) {
      return {
        outcome: 'ambiguous',
        reason: 'this policy covers premium support only, and cannot decide what this obligation entitles the customer to',
      };
    }
    return {
      supportTier: rule.supportTier,
      categories: [...rule.categories],
      priorities: [...rule.priorities],
      firstResponseTargetMinutes: rule.firstResponseTargetMinutes,
      resolutionTargetMinutes: rule.resolutionTargetMinutes,
      maxOpenCases: rule.maxOpenCases,
      reason: 'premium support',
    };
  },
};

/** The last segment of a component key, which is the component's own name. */
function componentName(componentKey) {
  const parts = String(componentKey ?? '').split(':');
  return parts[parts.length - 1];
}
