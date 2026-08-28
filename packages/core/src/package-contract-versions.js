// @ts-check

/**
 * Contract versions the synchronous v1 scaffolding emits. These remain scalar
 * values because generators interpolate them directly into declarations.
 */
export const SUPPORTED_PACKAGE_CONTRACT = 1;
export const SUPPORTED_OPERATION_CONTRACT = 1;

/** Contract versions the M2E composition boundary understands. */
export const SUPPORTED_PACKAGE_CONTRACTS = Object.freeze([1, 2]);
export const SUPPORTED_OPERATION_CONTRACTS = Object.freeze([1, 2]);
export const SUPPORTED_CAPABILITY_CONTRACTS = Object.freeze([1, 2]);

/** An omitted capability contract has always meant the synchronous v1 shape. */
export const DEFAULT_CAPABILITY_CONTRACT = 1;
