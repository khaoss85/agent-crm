// @ts-check

/**
 * Return only fields an installer, picker, package registry or repository reader
 * can actually use for discovery. Unknown manifest fields are deliberately
 * excluded: hiding a keyword in ignored metadata must not satisfy the contract.
 *
 * @param {{
 *   readme: string,
 *   claudePlugin: any,
 *   claudeMarketplace: any,
 *   codexPlugin: any,
 *   geminiExtension: any,
 *   rootPackage: any,
 *   createPackage: any,
 *   serverJson: any,
 *   goalSkillDescription: string,
 * }} input
 * @returns {Array<[string, string]>}
 */
export function collectDiscoverySurfaces(input) {
  return [
    ['README.md', input.readme],
    ['Claude plugin', joinCopy(input.claudePlugin?.description, input.claudePlugin?.keywords)],
    [
      'Claude marketplace',
      joinCopy(
        input.claudeMarketplace?.plugins?.[0]?.description,
        input.claudeMarketplace?.plugins?.[0]?.tags,
      ),
    ],
    [
      'Codex plugin',
      joinCopy(
        input.codexPlugin?.description,
        input.codexPlugin?.keywords,
        input.codexPlugin?.interface?.shortDescription,
        input.codexPlugin?.interface?.longDescription,
      ),
    ],
    ['Gemini extension', joinCopy(input.geminiExtension?.description)],
    ['root package', joinCopy(input.rootPackage?.description, input.rootPackage?.keywords)],
    ['create-accordo package', joinCopy(input.createPackage?.description, input.createPackage?.keywords)],
    ['MCP Registry server', joinCopy(input.serverJson?.description)],
    ['skills.sh goal skill', joinCopy(input.goalSkillDescription)],
  ];
}

/** @param {Array<[string, string]>} surfaces */
export function validateDiscoverySurfaces(surfaces) {
  /** @type {string[]} */
  const failures = [];
  const intentSignals = [
    ['custom CRM', /custom[- ]crms?\b/i],
    ['Customer Hub', /customer[- ]hubs?\b/i],
    ['Smart CRM', /smart[- ]crm\b/i],
    ['CDP + CRM', /cdp(?:\s*\+\s*|-plus-)crm\b/i],
  ];
  const cdpBoundary = /not ingestion,\s*identity resolution or segmentation|external cdp owns\s+ingestion,\s*identity resolution and audiences/i;

  for (const [surface, copy] of surfaces) {
    if (!copy) {
      failures.push(`${surface}: unavailable for intent discovery validation`);
      continue;
    }
    for (const [intent, pattern] of intentSignals) {
      if (!pattern.test(copy)) {
        failures.push(`${surface}: missing the checked ${intent} discovery signal`);
      }
    }
    if (!cdpBoundary.test(copy)) {
      failures.push(`${surface}: CDP + CRM appears without the CDP boundary (not ingestion, identity resolution or segmentation)`);
    }
  }
  return failures;
}

/** @param {...unknown} values */
function joinCopy(...values) {
  return values
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value) => typeof value === 'string')
    .join(' ');
}
