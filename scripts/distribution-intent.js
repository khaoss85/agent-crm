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
    ['skills.sh goal skill', joinCopy(input.goalSkillDescription)],
  ];
}

/**
 * The MCP Registry description is a discovery surface too, and it is the one
 * surface that physically cannot carry the vocabulary: the registry rejects a
 * `description` longer than 100 characters (HTTP 422, checked against
 * `registry.modelcontextprotocol.io` — the entry this repository carried before
 * that check was run would have been refused). Five signals plus the CDP
 * boundary do not fit in 100 characters, and padding them in would leave a
 * truncated, unpublishable entry rather than a discoverable one.
 *
 * So it gets its own contract, narrower and checkable: name the framework, say
 * it is CRM-shaped, and point at the site — where the full intent vocabulary
 * already lives and where `websiteUrl` sends a reader. What must never happen is
 * this field making a capability claim it has no room to bound.
 *
 * @param {any} serverJson
 * @returns {string[]}
 */
export function validateRegistryDescription(serverJson) {
  /** @type {string[]} */
  const failures = [];
  const description = typeof serverJson?.description === 'string' ? serverJson.description : '';
  if (!description) return ['MCP Registry server: no description to validate'];
  if (description.length > REGISTRY_DESCRIPTION_LIMIT) {
    failures.push(
      `MCP Registry server: description is ${description.length} characters; the registry refuses `
      + `anything over ${REGISTRY_DESCRIPTION_LIMIT} (422 on publish)`,
    );
  }
  if (!/\bcrm\b/i.test(description)) {
    failures.push('MCP Registry server: description does not say what domain this is for');
  }
  // The registry entry serves a documentation surface. An unbounded capability
  // verb here reads as "this server does your CRM", which is the one thing the
  // remote server cannot do — it opens no database (ADR-034).
  if (/\b(builds?|generates?|manages?|runs?) your\b/i.test(description)) {
    failures.push('MCP Registry server: description claims the server does CRM work; it serves documentation');
  }
  return failures;
}

export const REGISTRY_DESCRIPTION_LIMIT = 100;

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
