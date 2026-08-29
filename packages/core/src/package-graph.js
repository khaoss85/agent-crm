// @ts-check

import { AppError, ValidationError } from './errors.js';
import { settleContractValue } from './async-values.js';
import { definePackage } from './package-registry.js';
import { SUPPORTED_PACKAGE_CONTRACTS } from './package-contract-versions.js';

/**
 * Dual bundled package graphs (Spine v2 M3P).
 *
 * Bundled domains keep two explicit graphs generated from one declaration:
 * contract 1 is the current synchronous object (identity-preserving), and
 * contract 2 is a cloned declaration whose package/action/operation/capability
 * contracts are stamped together and whose execute/create seams settle with
 * `settleContractValue`. Promise-returning wrappers never enter the v1 object.
 */

const ACTION_SEAMS = Object.freeze([
  'execute', 'prepare', 'intent', 'external', 'finalize', 'compensate',
]);

function asyncContractError(message, details) {
  return new AppError(message, {
    code: 'PACKAGE_ASYNC_CONTRACT_REQUIRED',
    status: 400,
    details,
  });
}

/**
 * @param {unknown} value
 * @returns {1 | 2}
 */
export function selectedPackageContract(value) {
  if (value === undefined || value === 1) return 1;
  if (value === 2) return 2;
  throw new ValidationError(
    `packageContract must be one of ${SUPPORTED_PACKAGE_CONTRACTS.join(', ')} (received ${String(value)})`,
  );
}

function uniqueContract(values, fallback) {
  const unique = [...new Set(values)];
  if (unique.length === 0) return fallback;
  return unique.length === 1 ? unique[0] : null;
}

/**
 * Function-free contract summary for inspection. Mixed members report `null`
 * rather than guessing which graph is selected.
 *
 * @param {any} definition
 */
export function describePackageGraphContracts(definition) {
  const packageContract = definition?.packageContract ?? null;
  return Object.freeze({
    name: typeof definition?.name === 'string' ? definition.name : null,
    packageContract,
    actionContract: uniqueContract(
      (definition?.actions ?? []).map((entry) => entry?.actionContract),
      packageContract,
    ),
    operationContract: uniqueContract(
      (definition?.operations ?? []).map((entry) => entry?.operationContract),
      packageContract,
    ),
    capabilityContract: uniqueContract(
      (definition?.capabilities ?? []).map((entry) => (
        entry?.capabilityContract === undefined ? 1 : entry.capabilityContract
      )),
      packageContract,
    ),
  });
}

/**
 * @param {Function} fn
 * @param {1 | 2} contract
 * @param {string} label
 */
function wrapSeam(fn, contract, label) {
  return async function wrapped(...args) {
    return settleContractValue(fn.apply(this, args), contract, label);
  };
}

/**
 * @param {any} action
 * @param {1 | 2} contract
 */
function stampAction(action, contract) {
  const next = { ...action, actionContract: contract };
  if (contract !== 2) return next;
  const identity = `${action?.module ?? 'action'}.${action?.name ?? 'unnamed'}`;
  for (const seam of ACTION_SEAMS) {
    if (typeof action?.[seam] === 'function') {
      next[seam] = wrapSeam(action[seam], contract, `action ${identity} ${seam}`);
    }
  }
  return next;
}

/**
 * Operation `create` stays a composition-time factory. The returned function
 * is the execution seam that contract 2 settles.
 *
 * @param {any} operation
 * @param {1 | 2} contract
 */
function stampOperation(operation, contract) {
  const next = { ...operation, operationContract: contract };
  if (contract !== 2 || typeof operation?.create !== 'function') return next;
  const originalCreate = operation.create;
  const name = typeof operation.name === 'string' ? operation.name : 'unnamed';
  next.create = function create(runtime) {
    const fn = originalCreate.call(this, runtime);
    if (typeof fn !== 'function') return fn;
    return wrapSeam(fn, contract, `operation ${name}`);
  };
  return next;
}

/**
 * @param {any} capability
 * @param {1 | 2} contract
 */
function stampCapability(capability, contract) {
  const next = { ...capability, capabilityContract: contract };
  if (contract !== 2 || typeof capability?.create !== 'function') return next;
  const originalCreate = capability.create;
  const name = typeof capability.name === 'string' ? capability.name : 'unnamed';
  next.create = async function create(...args) {
    const iface = await settleContractValue(
      originalCreate.apply(this, args),
      contract,
      `capability ${name} create`,
    );
    if (
      iface
      && typeof iface === 'object'
      && !Array.isArray(iface)
      && Object.hasOwn(iface, 'capabilityContract')
      && iface.capabilityContract !== contract
    ) {
      return Object.freeze({ ...iface, capabilityContract: contract });
    }
    return iface;
  };
  return next;
}

/**
 * Clone a v1 declaration into a uniformly stamped contract-2 graph. Extra
 * package fields (`persistFingerprints`, `registries`, `start`) are copied
 * by the object spread and stay shared closures over the same pure work.
 *
 * @param {any} definition
 * @param {1 | 2} contract
 */
function cloneGraph(definition, contract) {
  const graph = { ...definition, packageContract: contract };
  if (Array.isArray(definition.actions)) {
    graph.actions = definition.actions.map((action) => stampAction(action, contract));
  }
  if (Array.isArray(definition.operations)) {
    graph.operations = definition.operations.map((operation) => stampOperation(operation, contract));
  }
  if (Array.isArray(definition.capabilities)) {
    graph.capabilities = definition.capabilities.map((capability) => stampCapability(capability, contract));
  }
  return graph;
}

/**
 * Select the v1 or v2 graph for one package definition.
 *
 * Contract 1 returns the exact object it was given when that object is already
 * a v1 graph, so existing execute/create identities stay intact. Contract 2
 * always returns a distinct cloned object.
 *
 * @param {any} definition
 * @param {unknown} contract
 */
export function selectPackageGraph(definition, contract) {
  const selected = selectedPackageContract(contract);
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new ValidationError('Domain package definition must be an object');
  }
  if (selected === 1 && definition.packageContract === 1) return definition;
  if (selected === 2 && definition.packageContract === 2) return definition;
  if (selected === 1 && definition.packageContract === 2) {
    const name = typeof definition.name === 'string' && definition.name !== ''
      ? definition.name
      : '(unnamed)';
    throw asyncContractError(
      `Cannot down-convert package "${name}" from packageContract 2 to 1; v2 execute seams are not the synchronous v1 functions`,
      { package: name, packageContract: 2, selectedContract: 1 },
    );
  }
  return definePackage(cloneGraph(definition, selected));
}

/**
 * Both graphs from one v1 declaration, without copying domain logic.
 *
 * @param {any} definition
 */
export function describeBundledPackageGraphs(definition) {
  const v1 = selectPackageGraph(definition, 1);
  const v2 = selectPackageGraph(definition, 2);
  return Object.freeze({
    1: v1,
    2: v2,
    contracts: Object.freeze([
      describePackageGraphContracts(v1),
      describePackageGraphContracts(v2),
    ]),
  });
}

/**
 * The synchronous factory selects contract 1 only. A contract-2 package in
 * that composition is refused before useful work.
 *
 * @param {any[]} [packages]
 */
export function refuseAsyncPackagesOnSynchronousFactory(packages = []) {
  for (const pkg of packages ?? []) {
    let packageContract;
    try {
      packageContract = pkg?.packageContract;
    } catch {
      continue;
    }
    if (packageContract !== 2) continue;
    let name = '(unnamed)';
    try {
      if (typeof pkg?.name === 'string' && pkg.name !== '') name = pkg.name;
    } catch {
      name = '(unnamed)';
    }
    throw asyncContractError(
      `createAccordoApp() selects the synchronous v1 package graph; package "${name}" declares packageContract 2; `
        + 'sync-v1 and async-v2 contracts cannot share one application graph',
      { package: name, packageContract: 2 },
    );
  }
}
