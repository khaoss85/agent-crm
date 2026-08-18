import { execFileSync } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBaseline, COMMERCIAL_LIMITATIONS, observation } from './characterization-contract.mjs';
import { ATTACHMENT, BEHAVIOUR_BEARING_SOURCE, COMMERCIAL_SOURCE, loadPricing, loadRegistry } from './commercial-harness.mjs';
import { runCommercialCases, runRestartCases, runScaleCases } from './commercial-cases.mjs';

/**
 * Run every Commercial case and assemble a baseline document. The **same**
 * function produces the checked-in baseline and the fresh run the test
 * compares against it.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export const SOURCE_FILES = BEHAVIOUR_BEARING_SOURCE;

/** @param {string} [rootDir] */
export function sourceFingerprints(rootDir = repoRoot) {
  const out = {};
  for (const relative of SOURCE_FILES) {
    try {
      out[relative] = createHash('sha256').update(readFileSync(join(rootDir, relative))).digest('hex');
    } catch {
      out[relative] = 'absent';
    }
  }
  return out;
}

/**
 * The pricing arithmetic and money bounds, pinned by behaviour rather than by
 * location. The extraction splits `commercial-money.js` into a neutral kernel
 * money module and package-owned pricing; these observations are what make
 * "the split changes nothing" checkable — a single moved cent, changed error
 * string or altered tier boundary goes red.
 *
 * Loaded through the harness, which owns every path that knows where the code
 * lives today.
 *
 * @param {(entry: any) => void} record
 */
export async function runPricingTableCases(record) {
  const money = await loadPricing();
  const registry = await loadRegistry();

  const outcome = (fn) => {
    try {
      return { ok: true, value: fn() };
    } catch (error) {
      return { ok: false, message: String(error.message) };
    }
  };

  // The bounds a package will import from public core after the split: the
  // exact refusal strings are the contract a consumer sees.
  record(observation({
    id: 'helpers.money-bounds',
    category: 'helpers',
    classification: 'compatibility_required',
    surface: 'sdk',
    observed: {
      constants: {
        MAX_DISCOUNT_BPS: money.MAX_DISCOUNT_BPS,
        MAX_QUANTITY: money.MAX_QUANTITY,
        MAX_TIERS: money.MAX_TIERS,
        MAX_INTERVAL_COUNT: money.MAX_INTERVAL_COUNT,
        CHARGE_TYPES: [...money.CHARGE_TYPES],
        PRICING_MODELS: [...money.PRICING_MODELS],
        RECURRING_INTERVALS: [...money.RECURRING_INTERVALS],
      },
      refusals: {
        amountNegative: outcome(() => money.requireAmount(-1, 'x')),
        amountFloat: outcome(() => money.requireAmount(1.5, 'x')),
        amountUnsafe: outcome(() => money.requireAmount(Number.MAX_SAFE_INTEGER + 1, 'x')),
        bpsOver: outcome(() => money.requireBps(10_001, 'x')),
        bpsNegative: outcome(() => money.requireBps(-1, 'x')),
        quantityZero: outcome(() => money.requireQuantity(0, 'x')),
        quantityOver: outcome(() => money.requireQuantity(1_000_001, 'x')),
        currencyLowercase: outcome(() => money.requireCurrency('eur')),
        currencyShape: outcome(() => money.requireCurrency('EURO')),
        multiplyOverflow: outcome(() => money.checkedMultiply(Number.MAX_SAFE_INTEGER, 2, 'x')),
        addOverflow: outcome(() => money.checkedAdd(Number.MAX_SAFE_INTEGER, 1, 'x')),
      },
      accepted: {
        amountZero: money.requireAmount(0, 'x'),
        quantityMax: money.requireQuantity(1_000_000, 'x'),
        bpsMax: money.requireBps(10_000, 'x'),
        currency: money.requireCurrency('EUR'),
      },
    },
    note: 'Pinned so the planned split of commercial-money.js into a neutral kernel money module and package pricing can be proved to change nothing — values and refusal strings alike.',
  }));

  // Component pricing over synthetic schedules that exercise what the fixture
  // catalog does not: tier flat amounts, boundary quantities on both sides,
  // and open-ended tails.
  const VOLUME = money.validateTierSchedule([
    { upTo: 20, unitAmountCents: 5000, flatAmountCents: 1000 },
    { upTo: 100, unitAmountCents: 4000 },
    { upTo: null, unitAmountCents: 3000, flatAmountCents: 500 },
  ], 'volume probe');
  const GRADUATED = money.validateTierSchedule([
    { upTo: 100, unitAmountCents: 200, flatAmountCents: 700 },
    { upTo: 1000, unitAmountCents: 150 },
    { upTo: null, unitAmountCents: 100, flatAmountCents: 90 },
  ], 'graduated probe');
  const componentAmounts = {};
  for (const [label, component, quantity] of [
    ['flat-fee-q30', { pricingModel: 'flat_fee', flatAmountCents: 500_000, unitAmountCents: null, tiers: [] }, 30],
    ['per-unit-q400', { pricingModel: 'per_unit', unitAmountCents: 25, flatAmountCents: null, tiers: [] }, 400],
    ['volume-q1', { pricingModel: 'volume', unitAmountCents: null, flatAmountCents: null, tiers: VOLUME }, 1],
    ['volume-q20', { pricingModel: 'volume', unitAmountCents: null, flatAmountCents: null, tiers: VOLUME }, 20],
    ['volume-q21', { pricingModel: 'volume', unitAmountCents: null, flatAmountCents: null, tiers: VOLUME }, 21],
    ['volume-q100', { pricingModel: 'volume', unitAmountCents: null, flatAmountCents: null, tiers: VOLUME }, 100],
    ['volume-q101', { pricingModel: 'volume', unitAmountCents: null, flatAmountCents: null, tiers: VOLUME }, 101],
    ['volume-q1000000', { pricingModel: 'volume', unitAmountCents: null, flatAmountCents: null, tiers: VOLUME }, 1_000_000],
    ['graduated-q1', { pricingModel: 'graduated', unitAmountCents: null, flatAmountCents: null, tiers: GRADUATED }, 1],
    ['graduated-q100', { pricingModel: 'graduated', unitAmountCents: null, flatAmountCents: null, tiers: GRADUATED }, 100],
    ['graduated-q101', { pricingModel: 'graduated', unitAmountCents: null, flatAmountCents: null, tiers: GRADUATED }, 101],
    ['graduated-q250', { pricingModel: 'graduated', unitAmountCents: null, flatAmountCents: null, tiers: GRADUATED }, 250],
    ['graduated-q1000', { pricingModel: 'graduated', unitAmountCents: null, flatAmountCents: null, tiers: GRADUATED }, 1000],
    ['graduated-q1001', { pricingModel: 'graduated', unitAmountCents: null, flatAmountCents: null, tiers: GRADUATED }, 1001],
  ]) {
    componentAmounts[label] = money.computeComponentAmount(component, quantity);
  }
  record(observation({
    id: 'pricing.component-amount-table',
    category: 'pricing',
    classification: 'compatibility_required',
    surface: 'sdk',
    observed: componentAmounts,
    note: 'flat_fee charged once; per_unit multiplies; volume prices the whole quantity at the reached tier plus its flat amount once; graduated prices each receiving band plus that band\'s flat amount. Boundary quantities on both sides of every tier edge.',
  }));

  const discountTable = {};
  for (const [list, bps] of [[0, 0], [1, 9999], [999, 5000], [1000, 5000], [123_456, 725], [500_000, 1], [500_000, 10_000], [1, 1]]) {
    discountTable[`${list}@${bps}`] = money.applyDiscount(list, bps);
  }
  record(observation({
    id: 'pricing.discount-rounding-table',
    category: 'pricing',
    classification: 'compatibility_required',
    surface: 'sdk',
    observed: discountTable,
    note: 'discount = trunc(list x bps / 10000): never rounds up, never loses a cent of net. 999@5000 truncating to 499 is the canonical case.',
  }));

  record(observation({
    id: 'pricing.grouped-totals-never-sum-unlike-periods',
    category: 'pricing',
    classification: 'compatibility_required',
    surface: 'sdk',
    observed: money.groupComponentTotals([
      { chargeType: 'one_time', interval: null, intervalCount: null, listAmountCents: 1000, discountAmountCents: 100, netAmountCents: 900 },
      { chargeType: 'recurring', interval: 'month', intervalCount: 1, listAmountCents: 2000, discountAmountCents: 0, netAmountCents: 2000 },
      { chargeType: 'recurring', interval: 'month', intervalCount: 1, listAmountCents: 3000, discountAmountCents: 300, netAmountCents: 2700 },
      { chargeType: 'recurring', interval: 'month', intervalCount: 3, listAmountCents: 4000, discountAmountCents: 0, netAmountCents: 4000 },
      { chargeType: 'recurring', interval: 'year', intervalCount: 1, listAmountCents: 5000, discountAmountCents: 0, netAmountCents: 5000 },
    ], 'EUR'),
  }));
  record(observation({
    id: 'pricing.effective-discount-and-max-line',
    category: 'pricing',
    classification: 'compatibility_required',
    surface: 'sdk',
    observed: {
      effective: money.effectiveDiscountBps({
        oneTimeTotal: { listAmountCents: 10_000, discountAmountCents: 1000, netAmountCents: 9000 },
        recurringTotals: [{ listAmountCents: 30_000, discountAmountCents: 0, netAmountCents: 30_000 }],
      }),
      effectiveOnZeroList: money.effectiveDiscountBps({
        oneTimeTotal: { listAmountCents: 0, discountAmountCents: 0, netAmountCents: 0 },
        recurringTotals: [],
      }),
      maxLine: money.maxLineDiscountBps([{ discountBps: 300 }, { discountBps: 2000 }, {}]),
    },
  }));

  record(observation({
    id: 'pricing.schedule-and-component-refusals',
    category: 'pricing',
    classification: 'compatibility_required',
    surface: 'sdk',
    observed: {
      nonIncreasing: outcome(() => money.validateTierSchedule([{ upTo: 100, unitAmountCents: 1 }, { upTo: 20, unitAmountCents: 2 }, { upTo: null, unitAmountCents: 3 }], 'probe')),
      noOpenEnd: outcome(() => money.validateTierSchedule([{ upTo: 100, unitAmountCents: 1 }], 'probe')),
      openEndNotLast: outcome(() => money.validateTierSchedule([{ upTo: null, unitAmountCents: 1 }, { upTo: 100, unitAmountCents: 2 }], 'probe')),
      tooManyTiers: outcome(() => money.validateTierSchedule(
        [...Array.from({ length: 51 }, (_, index) => ({ upTo: index + 1, unitAmountCents: 1 })), { upTo: null, unitAmountCents: 1 }], 'probe',
      )),
      recurringWithoutInterval: outcome(() => money.validatePriceComponent({ chargeType: 'recurring', pricingModel: 'flat_fee', flatAmountCents: 1 }, 'probe')),
      oneTimeWithInterval: outcome(() => money.validatePriceComponent({ chargeType: 'one_time', pricingModel: 'flat_fee', flatAmountCents: 1, interval: 'month', intervalCount: 1 }, 'probe')),
      tieredWithUnitAmount: outcome(() => money.validatePriceComponent({ chargeType: 'recurring', pricingModel: 'volume', interval: 'month', intervalCount: 1, unitAmountCents: 5, tiers: [{ upTo: null, unitAmountCents: 1 }] }, 'probe')),
      perUnitWithFlat: outcome(() => money.validatePriceComponent({ chargeType: 'one_time', pricingModel: 'per_unit', unitAmountCents: 5, flatAmountCents: 5 }, 'probe')),
      flatWithUnit: outcome(() => money.validatePriceComponent({ chargeType: 'one_time', pricingModel: 'flat_fee', flatAmountCents: 5, unitAmountCents: 5 }, 'probe')),
      overflowingQuantity: outcome(() => money.computeComponentAmount({ pricingModel: 'per_unit', unitAmountCents: Number.MAX_SAFE_INTEGER, flatAmountCents: null, tiers: [] }, 1000)),
    },
  }));

  record(observation({
    id: 'pricing.policy-result-normalization',
    category: 'pricing',
    classification: 'compatibility_required',
    surface: 'sdk',
    observed: {
      decisions: [...registry.DISCOUNT_DECISIONS],
      promiseRefused: outcome(() => registry.normalizePolicyResult('probe', Promise.resolve({ decision: 'auto_approve' }))),
      unknownDecision: outcome(() => registry.normalizePolicyResult('probe', { decision: 'maybe' })),
      arrayRefused: outcome(() => registry.normalizePolicyResult('probe', [])),
      emptyReason: outcome(() => registry.normalizePolicyResult('probe', { decision: 'reject', reason: '' })),
      boundedReason: registry.normalizePolicyResult('probe', { decision: 'reject', reason: 'r'.repeat(600) }).reason.length,
      normalized: registry.normalizePolicyResult('probe', { decision: 'approval_required', requiredApprovalKey: 'sales-manager', matchedRule: 'band' }),
    },
  }));
}

/**
 * Every consumer of the Commercial wiring, measured from source rather than
 * remembered. Evidence for the extraction's migration surface; nothing here
 * implements it, and none of it is asserted.
 *
 * @param {(entry: any) => void} record
 */
export async function runArchitectureEvidence(record, rootDir = repoRoot) {
  const { readsProperty, importsFrom } = await import('./source-scan.mjs');
  const sourceFiles = execFileSync('git', ['ls-files', '--', '*.js', '*.mjs'], { cwd: rootDir, encoding: 'utf8' })
    .split('\n').filter(Boolean)
    .filter((file) => !file.startsWith('tests/'));
  const read = (file) => readFileSync(join(rootDir, file), 'utf8');

  record(observation({
    id: 'architecture.app-commercial-consumers',
    category: 'architecture',
    classification: 'pre_extraction_evidence',
    surface: 'sdk',
    observed: sourceFiles.filter((file) => readsProperty(read(file), 'app', 'commercial')).sort(),
    note: 'Every file that really reads the ambient app.commercial field, in code rather than in prose.',
  }));
  record(observation({
    id: 'architecture.commercial-internal-importers',
    category: 'architecture',
    classification: 'pre_extraction_evidence',
    surface: 'sdk',
    observed: sourceFiles
      .filter((file) => !file.startsWith('packages/commercial/'))
      .filter((file) => importsFrom(read(file), /(commercial-(actions|registry|money)|catalog-sync|commercial\/src\/[a-z-]+)\.js$/).length > 0).sort(),
    note: 'Every file outside the package with a real import statement naming a Commercial source file. After the extraction the only sanctioned importer is the project composition file, which is generated per project and not checked in here.',
  }));
  record(observation({
    id: 'architecture.definition-registry-slot',
    category: 'architecture',
    classification: 'pre_extraction_evidence',
    surface: 'app-inspect',
    observed: sourceFiles.filter((file) => /commercial\/generated/.test(stripCode(read(file)))).sort(),
    note: 'Who depends on the fixed project-owned definition slot, in code.',
  }));
  record(observation({
    id: 'architecture.catalog-route-in-kernel-server',
    category: 'architecture',
    classification: 'pre_extraction_evidence',
    surface: 'http',
    observed: {
      routeDeclared: /\/api\/catalog\/sync/.test(read('apps/server/src/http-server.js')),
      appMethodWired: /syncCatalog/.test(read('packages/app/src/create-app.js')),
    },
    note: 'The B7 seam evidence: the route and the app method are kernel-owned because no package can contribute either today.',
  }));

  const solutionCheck = spawnSync(process.execPath, [
    '--no-warnings', join(rootDir, 'packages/cli/bin/accordo.js'),
    'solution', 'check', join(rootDir, 'examples/solution-plans/lead-to-won.plan.json'),
  ], { encoding: 'utf8', cwd: rootDir });
  record(observation({
    id: 'architecture.solution-plan-binding',
    category: 'architecture',
    classification: 'contractual',
    surface: 'solution-plan',
    observed: { exitCode: solutionCheck.status },
    note: 'AX2: the shipped lead-to-won plan must keep binding to this repository\'s composition. The extraction repins the inspection fingerprint; the exit code must not move.',
  }));
}

/** The slot is referenced as a path string, so only comments are stripped. */
function stripCode(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** Run everything and assemble the document. */
export async function generateBaseline(t) {
  /** @type {any[]} */
  const observations = [];
  const record = (entry) => observations.push(entry);

  await runCommercialCases(t, record);
  await runRestartCases(t, record);
  await runScaleCases(t, record);
  await runPricingTableCases(record);
  await runArchitectureEvidence(record);

  return buildBaseline({
    domain: 'commercial-operations',
    attachment: ATTACHMENT,
    source: sourceFingerprints(),
    observations,
    limitations: COMMERCIAL_LIMITATIONS,
  });
}
