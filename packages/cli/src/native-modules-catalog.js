// @ts-check

/**
 * Native-modules catalog (backlog:329bbbb7) — the machine-readable answer to
 * "what does this framework already do, so I do not rewrite it?".
 *
 * A native module is a capability the framework ships with its backoffice
 * screen already dressed like the prototype: an agent activates it (one
 * composition line), configures it (package options) and personalizes it
 * (backoffice screens) — it never rewrites it. Custom work lives beside the
 * kernel instead: a separate bundle (`accordo bundle:create`, never under
 * `packages/`) or the Module Factory, listed by this same report under
 * `customModules` so the two are never confused.
 *
 * The table is data, not code: screens match the backoffice shell
 * (`apps/admin/public/admin-shell.js` `SHELL_ITEMS` / `SETTINGS_AREAS`, guarded
 * by `tests/native-modules-catalog.test.js`), activation names the real
 * composition files the application boots from, and customization names only
 * options the package factories actually read. Nothing here is imported from
 * the project: `active` is a source-only read of the project's checked-in
 * composition (the factory identifier is present or it is not), so this
 * command never opens the database, never runs package code and never
 * contacts a provider — the same boundary `app inspect` documents.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { listBundles } from './bundle-manager.js';

/** Contract version of this catalog document. */
export const NATIVE_MODULES_CATALOG_CONTRACT = 1;

/**
 * The eight native modules, in backoffice order. `screen.route` is the
 * backoffice hash route (a `<nome>` placeholder marks a route that needs the
 * composed name, e.g. the pipeline). `activation.kind` is `domain` for a line
 * in `packages/domains/generated/index.js` or `pipeline` for a line in
 * `packages/pipelines/generated/index.js`.
 */
export const NATIVE_MODULES = Object.freeze([
  {
    id: 'clienti',
    name: 'Clienti',
    purpose: 'Scheda cliente unica con messaggi, appuntamenti e punti di contatto.',
    screen: { route: '#/customer-data', label: 'Clienti' },
    activation: {
      kind: 'domain',
      package: 'customer-data',
      factory: 'createCustomerDataPackage',
      import: '../../customer-data/src/index.js',
      file: 'packages/domains/generated/index.js',
    },
    customize: [
      'politica anti-doppioni (matchPolicy)',
      'nomi dei record (config)',
      'arricchimento Google Contacts (opt-in esplicito)',
    ],
  },
  {
    id: 'pipeline',
    name: 'Pipeline',
    purpose: 'Fasi di vendita delle opportunità, con la prima pipeline che apre la voce.',
    screen: { route: '#/pipelines/<nome>', label: 'Pipeline' },
    activation: {
      kind: 'pipeline',
      package: 'pipelines',
      factory: 'accordoSalesPipeline',
      import: '../accordo-sales.js',
      file: 'packages/pipelines/generated/index.js',
    },
    customize: [
      'pipeline accordo-sales opt-in per spazio o progetto',
      'fasi e stati della pipeline (definizione code-first)',
    ],
  },
  {
    id: 'calendario',
    name: 'Calendario',
    purpose: 'Prenotazioni in Accordo, sincronizzate nei due sensi con Google Calendar.',
    screen: { route: '#/calendario', label: 'Calendario' },
    activation: {
      kind: 'domain',
      package: 'appointments',
      factory: 'createAppointmentsPackage',
      import: '../../appointments/src/index.js',
      file: 'packages/domains/generated/index.js',
    },
    customize: [
      'durate e regole di prenotazione (config)',
      'sincronizzazione a due vie (calendar-sync: provider, mapping)',
    ],
  },
  {
    id: 'sequenze',
    name: 'Sequenze',
    purpose: 'Messaggi automatici a passi, con finestre di risposta e personalizzazione.',
    screen: { route: '#/sequenze', label: 'Sequenze' },
    activation: {
      kind: 'domain',
      package: 'sequences',
      factory: 'createSequencesPackage',
      import: '../../sequences/src/index.js',
      file: 'packages/domains/generated/index.js',
    },
    customize: [
      'modello di coda (queueTemplate)',
      'finestre di risposta (replyWindows)',
      'personalizzazione dei messaggi (personalize)',
    ],
  },
  {
    id: 'catalogo',
    name: 'Catalogo',
    purpose: 'Prodotti, listini, offerte e preventivi con politiche di sconto.',
    screen: { route: '#/catalogo', label: 'Catalogo prodotti' },
    activation: {
      kind: 'domain',
      package: 'commercial',
      factory: 'createCommercialDomain',
      import: '../../commercial/src/index.js',
      file: 'packages/domains/generated/index.js',
    },
    customize: [
      'fornitori di catalogo (catalogProviders)',
      'politiche di sconto (discountPolicies)',
      'listini e preventivi (price-book, quote)',
    ],
  },
  {
    id: 'canali',
    name: 'Canali',
    purpose: 'Messaggi dei clienti da WhatsApp, Instagram e gli altri canali, dentro le schede.',
    screen: { route: '#/connettori', label: 'Connettori' },
    activation: {
      kind: 'domain',
      package: 'channels',
      factory: 'createChannelsPackage',
      import: '../../channels/src/index.js',
      file: 'packages/domains/generated/index.js',
    },
    customize: [
      'adattatori canale (channelAdapters)',
      'segreti per riferimento (resolveSecret)',
      'spazio e inquilino (tenantId)',
    ],
  },
  {
    id: 'stato-sync',
    name: 'Stato sync',
    purpose: 'Cosa non si è sincronizzato, con la lista delle correzioni e la tabella dei canali.',
    screen: { route: '#/stato-sync', label: 'Stato sync' },
    activation: {
      kind: 'domain',
      package: 'customer-data',
      factory: 'createCustomerDataPackage',
      import: '../../customer-data/src/index.js',
      file: 'packages/domains/generated/index.js',
    },
    customize: [
      'canali sotto osservazione (si collegano dai Connettori)',
      'code di correzione (data-quality, candidati doppioni)',
    ],
  },
  {
    id: 'spazi-accessi',
    name: 'Spazi e accessi',
    purpose: 'Spazi del team, permessi e interruttori AI con approvazione umana.',
    screen: { route: '#/spazi-accessi', label: 'Spazi e accessi' },
    activation: {
      kind: 'domain',
      package: 'space-permissions',
      factory: 'createSpacePermissionsDomain',
      import: '../../space-permissions/src/index.js',
      file: 'packages/domains/generated/index.js',
    },
    customize: [
      'interruttori AI per spazio (config)',
      'eccezioni per spazio (override)',
      'attivazione pacchetti per spazio (space-package)',
    ],
  },
]);

/**
 * Source-only read of one composition file: the text is there or it is not.
 * Missing or unreadable file means "no evidence", never an exception.
 * @param {string} rootDir
 * @param {string} file
 * @returns {string|null}
 */
function readCompositionSource(rootDir, file) {
  try {
    return readFileSync(resolve(rootDir, file), 'utf8');
  } catch {
    return null;
  }
}

/**
 * The catalog answered for one project: every native module with its
 * activation state, plus the project's custom bundles as a separate list.
 * Custom code is reported, never merged into the native list: a bundle named
 * like a native module still shows up under `customModules`.
 * @param {{rootDir?: string}} input
 */
export function readNativeModuleStatus(input = {}) {
  const rootDir = resolve(input.rootDir ?? process.cwd());
  const domainSource = readCompositionSource(rootDir, 'packages/domains/generated/index.js');
  const pipelineSource = readCompositionSource(rootDir, 'packages/pipelines/generated/index.js');
  const nativeModules = NATIVE_MODULES.map((entry) => {
    const source = entry.activation.kind === 'pipeline' ? pipelineSource : domainSource;
    const active = source !== null && source.includes(entry.activation.factory);
    return {
      ...entry,
      screen: { ...entry.screen },
      activation: { ...entry.activation },
      customize: [...entry.customize],
      active,
      activeEvidence:
        source === null
          ? `no source: ${entry.activation.file} not readable`
          : `${entry.activation.file} ${active ? 'names' : 'does not name'} ${entry.activation.factory}`,
    };
  });
  const { bundles } = listBundles({ rootDir });
  const customModules = bundles.map((bundle) => ({
    kind: 'bundle',
    name: bundle.name,
    version: bundle.version,
    modules: bundle.modules.map((module) => module.name),
    installed: bundle.installed,
  }));
  return {
    catalogContract: NATIVE_MODULES_CATALOG_CONTRACT,
    method: 'source-only: the checked-in composition files are read as text and never imported; no database is opened',
    nativeModules,
    customModules,
  };
}
