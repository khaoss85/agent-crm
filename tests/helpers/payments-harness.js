// @ts-check

/**
 * Test-only harness for the payments package (backlog:1972e16d33f2).
 *
 * Real sqlite (`:memory:`), real module services built from the shipped
 * manifests — the only doubles are the payment adapter itself and the
 * secret resolver, which is exactly what the fixture is for. Deep
 * `packages/core/src` imports are the same ones the repository's own
 * contract tests use; shipped package code never touches them.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AuditLog } from '../../packages/core/src/audit.js';
import { createDatabase } from '../../packages/core/src/database.js';
import { EventBus } from '../../packages/core/src/event-bus.js';
import {
  createRecordModuleFromManifest,
  recordModuleMigrations,
} from '../../packages/core/src/record-module-runtime.js';
import { PaymentRegistries } from '../../packages/payments/src/adapter.js';
import { buildPaymentConnectionActions } from '../../packages/payments/src/index.js';
import { createPaymentOperations } from '../../packages/payments/src/operations.js';
import { fixturePaymentWebhookHeaders } from '../../packages/payments/src/stripe.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', '..', 'packages', 'payments');

function loadManifest(name) {
  return JSON.parse(readFileSync(join(pkgRoot, 'modules', `${name}.module.json`), 'utf8'));
}

export const PAYMENT_MANIFEST_NAMES = Object.freeze([
  'payment-connection', 'payment-request', 'payment-event',
]);

/**
 * @param {{
 *   adapterDefinition: any, fixtureApi: any,
 *   secretRef?: string, secretValue?: string,
 *   config?: Record<string, any>,
 * }} options
 */
export function createPaymentsHarness(options) {
  const secretRef = options.secretRef ?? 'vault://kit/stripe-a';
  const secretValue = options.secretValue ?? 'kit-stripe-secret-1';
  const userActor = { type: 'user', id: 'payment-kit' };

  const database = createDatabase({ path: ':memory:' });
  for (const { sql } of recordModuleMigrations(PAYMENT_MANIFEST_NAMES.map((name) => ({ name, manifest: loadManifest(name) })))) {
    database.raw.exec(sql);
  }
  const audit = new AuditLog(database);
  const events = new EventBus();
  const modules = new Map();
  for (const name of PAYMENT_MANIFEST_NAMES) {
    const built = createRecordModuleFromManifest(loadManifest(name), { database, audit, events, references: {} });
    modules.set(name, { service: built.service });
  }

  const registries = new PaymentRegistries({ paymentAdapters: [options.adapterDefinition] });
  const resolveSecret = async (ref) => {
    if (ref !== secretRef) {
      const error = new Error('unknown secret reference');
      error.code = 'SECRET_NOT_FOUND';
      throw error;
    }
    return secretValue;
  };
  const ops = createPaymentOperations({
    database, modules, registries, resolveSecret, config: options.config,
  });

  const actions = Object.fromEntries(
    buildPaymentConnectionActions().map((action) => [action.name, action]),
  );
  const connectionService = () => modules.get('payment-connection').service;

  async function activate(spaceId, connectionKey) {
    const record = ops.getConnection(spaceId, connectionKey);
    if (!record) throw new Error('connection missing for activation');
    return actions['activate-connection'].execute({
      record,
      input: { reason: 'kit activation' },
      actor: userActor,
      modules,
      managed: (id, patch) => connectionService().applyManaged(id, patch, { actor: userActor }),
      now: () => new Date().toISOString(),
    });
  }

  return {
    database,
    internals: { database, modules, registries },
    ops,
    userActor,
    secretRef,
    secretValue,
    faults: {
      sign: (rawBody) => fixturePaymentWebhookHeaders(rawBody, secretValue, Math.floor(Date.now() / 1000)),
    },
    register: (spaceId, input) => ops.registerPaymentConnection({ spaceId, ...input, actor: input.actor ?? userActor }),
    activate,
    request: (spaceId, input) => ops.requestPayment({ spaceId, ...input, actor: input.actor ?? userActor }),
    ingest: (spaceId, { connectionKey, rawBody, headers }) => ops.ingestPaymentEvent({ spaceId, connectionKey, rawBody, headers }),
    status: (spaceId, requestId) => ops.getPaymentStatus(spaceId, requestId),
    list: (spaceId, filter) => ops.listPayments(spaceId, filter),
    connections: (spaceId) => (modules.get('payment-connection').service.listWhere({ spaceId })),
    auditRows: () => audit.list({ limit: 500 }),
    dumpStorage() {
      // Rows plus audit: a secret smuggled anywhere must fail the
      // no-secrets scan like any other stored value.
      return JSON.stringify({
        connections: [...modules.get('payment-connection').service.listWhere({})],
        requests: [...modules.get('payment-request').service.listWhere({})],
        events: [...modules.get('payment-event').service.listWhere({})],
        audit: audit.list({ limit: 500 }).map((row) => row.data),
      });
    },
    close() {
      database.close();
    },
  };
}
