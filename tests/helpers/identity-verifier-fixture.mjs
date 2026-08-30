// @ts-check

import { createHash } from 'node:crypto';

export const STARTUP_MIGRATE_PERMISSION = 'schema:migrate';

function fingerprint(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function resourceFor(plane) {
  return {
    resourceId: `${plane}-resource`,
    resourceFingerprint: fingerprint(`accordo.test.${plane}`),
  };
}

export function testResource(label, plane = 'data') {
  return {
    resourceId: `${plane}-${label}`,
    resourceFingerprint: fingerprint(`accordo.test.${plane}.${label}`),
  };
}

/**
 * Checked-in test provider. Never holds production credentials.
 *
 * @param {{
 *   tenantId?: string,
 *   permission?: string,
 *   expireMs?: number,
 *   replay?: boolean,
 *   swapRequest?: boolean,
 *   wrongOperation?: boolean,
 *   wrongTenant?: boolean,
 *   wrongResource?: boolean,
 *   wrongMigration?: boolean,
 *   dataResource?: { resourceId: string, resourceFingerprint: string },
 *   controlResource?: { resourceId: string, resourceFingerprint: string },
 * }} [options]
 */
export function createTestVerifier(options = {}) {
  const tenantId = options.tenantId ?? 'acme';
  const permission = options.permission ?? STARTUP_MIGRATE_PERMISSION;
  const expireMs = options.expireMs ?? 60_000;
  const seen = new Set();

  function discover(plane) {
    if (plane === 'data' && options.dataResource) return options.dataResource;
    if (plane === 'control' && options.controlResource) return options.controlResource;
    return resourceFor(plane);
  }

  function attest(challenge, expectedOperation) {
    if (options.swapRequest) {
      return {
        identityClass: 'request',
        identityFingerprint: fingerprint('request-identity'),
        evidenceFingerprint: fingerprint('request-evidence'),
        permission,
        expiresAt: new Date(Date.now() + expireMs).toISOString(),
        challengeNonce: challenge?.nonce,
        operation: expectedOperation,
        tenantId: challenge?.tenantId,
        resourceFingerprint: challenge?.resourceFingerprint,
        migrationSetFingerprint: challenge?.migrationSetFingerprint,
      };
    }
    if (options.wrongOperation) {
      return {
        identityClass: 'startup',
        identityFingerprint: fingerprint('id'),
        evidenceFingerprint: fingerprint('ev'),
        permission,
        expiresAt: new Date(Date.now() + expireMs).toISOString(),
        challengeNonce: challenge?.nonce,
        operation: expectedOperation === 'attestControlStartup' ? 'attestDataStartup' : 'attestControlStartup',
        tenantId: challenge?.tenantId,
        resourceFingerprint: challenge?.resourceFingerprint,
        migrationSetFingerprint: challenge?.migrationSetFingerprint,
      };
    }
    if (typeof challenge !== 'object' || challenge === null) {
      throw new Error('challenge missing');
    }
    if (options.wrongTenant && challenge.tenantId === tenantId) {
      throw Object.assign(new Error('wrong tenant'), { code: 'STARTUP_TENANT_MISMATCH' });
    }
    if (challenge.tenantId !== tenantId && !options.wrongTenant) {
      const error = new Error('startup tenant does not match');
      error.code = 'STARTUP_TENANT_MISMATCH';
      throw error;
    }
    if (options.wrongResource) {
      const error = new Error('startup resource does not match');
      error.code = 'STARTUP_RESOURCE_MISMATCH';
      throw error;
    }
    if (options.wrongMigration) {
      const error = new Error('startup migration set does not match');
      error.code = 'STARTUP_MIGRATION_SET_MISMATCH';
      throw error;
    }
    if (challenge.permission !== STARTUP_MIGRATE_PERMISSION && permission !== STARTUP_MIGRATE_PERMISSION) {
      // fall through to missing permission evidence
    }
    if (seen.has(challenge.nonce) && !options.replay) {
      const error = new Error('replayed challenge');
      error.code = 'STARTUP_CHALLENGE_REPLAYED';
      throw error;
    }
    if (!options.replay) seen.add(challenge.nonce);
    return {
      identityClass: 'startup',
      identityFingerprint: fingerprint(`identity:${tenantId}:${expectedOperation}`),
      evidenceFingerprint: fingerprint(`evidence:${challenge.nonce}`),
      permission,
      expiresAt: new Date(Date.now() + (options.expireMs === 0 ? -1 : expireMs)).toISOString(),
      challengeNonce: challenge.nonce,
      operation: expectedOperation,
      tenantId: challenge.tenantId,
      resourceFingerprint: challenge.resourceFingerprint,
      migrationSetFingerprint: challenge.migrationSetFingerprint,
    };
  }

  return Object.freeze({
    contract: 2,
    operations: Object.freeze({
      async verifyRequest() {
        throw new Error('request identity cannot satisfy startup attestation');
      },
      async discoverControlResource() { return discover('control'); },
      async attestControlStartup(challenge) { return attest(challenge, 'attestControlStartup'); },
      async discoverDataResource() { return discover('data'); },
      async attestDataStartup(challenge) { return attest(challenge, 'attestDataStartup'); },
    }),
  });
}

/**
 * ESM source for a repository-relative verifier file.
 *
 * @param {{ trust?: 'local-development'|'production', tenantId?: string }} [options]
 */
export function verifierModuleSource(options = {}) {
  const trust = options.trust ?? 'local-development';
  const tenantId = options.tenantId ?? 'acme';
  return `export const identityVerifierContract = 2;
export const identityVerifierTrust = ${JSON.stringify(trust)};
export function createIdentityVerifier() {
  const { createHash } = await import('node:crypto');
  throw new Error('not a top-level await module');
}
`;
}

export function verifierFactorySource(options = {}) {
  const trust = options.trust ?? 'production';
  const tenantId = options.tenantId ?? 'acme';
  return `import { createHash } from 'node:crypto';
export const identityVerifierContract = 2;
export const identityVerifierTrust = ${JSON.stringify(trust)};
const tenantId = ${JSON.stringify(tenantId)};
function fingerprint(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}
function resourceFor(plane) {
  return { resourceId: plane + '-resource', resourceFingerprint: fingerprint('accordo.test.' + plane) };
}
export function createIdentityVerifier() {
  const seen = new Set();
  return {
    verifyRequest() { throw new Error('request identity cannot satisfy startup attestation'); },
    discoverControlResource() { return resourceFor('control'); },
    discoverDataResource() { return resourceFor('data'); },
    attestControlStartup(challenge) { return attest(challenge, 'attestControlStartup'); },
    attestDataStartup(challenge) { return attest(challenge, 'attestDataStartup'); },
  };
  function attest(challenge, operation) {
    if (!challenge || challenge.operation !== operation) {
      const error = new Error('operation mismatch');
      error.code = 'STARTUP_OPERATION_MISMATCH';
      throw error;
    }
    if (challenge.tenantId !== tenantId) {
      const error = new Error('tenant mismatch');
      error.code = 'STARTUP_TENANT_MISMATCH';
      throw error;
    }
    if (seen.has(challenge.nonce)) {
      const error = new Error('replay');
      error.code = 'STARTUP_CHALLENGE_REPLAYED';
      throw error;
    }
    seen.add(challenge.nonce);
    return {
      identityFingerprint: fingerprint('identity:' + tenantId + ':' + operation),
      evidenceFingerprint: fingerprint('evidence:' + challenge.nonce),
      permission: 'schema:migrate',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      challengeNonce: challenge.nonce,
      operation,
    };
  }
}
`;
}
