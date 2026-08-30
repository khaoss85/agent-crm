// @ts-check

import { bindAdminMutations } from './admin-submission.js';

/**
 * **The Production Spine section (ADR-038).**
 *
 * Bounded on purpose. It answers four questions and refuses the rest:
 *
 * - who am I, and was that *verified* or merely asserted?
 * - which Organization am I acting in?
 * - who else is a member, and what does their role actually permit?
 * - what is this build unable to promise?
 *
 * **What it deliberately does not contain:** no password field, no email
 * invitation flow, no token or secret display, no "copy your API key". Each of
 * those would require the framework to hold a credential, and the whole design
 * rests on it holding none.
 *
 * **An Organization is not a Company.** The section says so in its own text,
 * and `tests/admin-spine.test.js` asserts a CRM Company never renders here.
 */

/** Rendered in every state when the runtime is not verifying anybody. */
export const NO_SPINE_WARNING =
  'NO PRODUCTION SPINE — this application performs no identity verification, no tenant isolation and '
  + 'no authorization. Actor identity is whatever the caller claimed.';

/** The sentence that keeps the two concepts apart, wherever memberships appear. */
export const ORGANIZATION_IS_NOT_A_COMPANY =
  'An Organization is a tenant of this software — the account your colleagues sign in to. '
  + 'A Company is a customer recorded inside your data. They are never the same thing.';

/**
 * Shown whenever the runtime reports that the declared tenant strategy is not
 * enforced for the CRM data plane.
 *
 * The operator reading this screen is the person who would otherwise learn it
 * by attacking the product, so it renders as an error beside the declaration
 * rather than as a footnote below it.
 */
export const SINGLE_TENANT_POSTURE =
  'ONE TENANT PER INSTANCE — this application serves exactly one Organization, and its CRM data lives '
  + 'in a database bound to that Organization alone. There is no tenant switcher because there is no '
  + 'second tenant to switch to: another Organization means another deployed instance. A request '
  + 'verified for any other Organization is refused as not found.';

/**
 * Shown if a runtime ever reports that the bound data plane is not enforced.
 *
 * It should never render. It exists because the failure it describes — a spine
 * that came up without a real storage binding — is one an operator must see
 * rather than infer, and a screen that can only say "fine" cannot report it.
 */
export const TENANT_ISOLATION_WARNING =
  'TENANT ISOLATION NOT ENFORCED — this runtime reports that its CRM data plane is not bound to a '
  + 'single tenant. Do not put real customer data in it, and do not expose it.';

/**
 * @param {{doc: any, mount: any, client: any}} deps
 */
export function createSpineView(deps) {
  const { doc, mount } = deps;
  const { client } = bindAdminMutations(deps.client, deps);
  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.setAttribute('class', className);
    if (text !== undefined && text !== null) node.textContent = String(text); // text, never HTML
    return node;
  };
  const fact = (label, value) => {
    const row = el('p', 'fact');
    row.appendChild(el('span', 'fact-label', `${label}: `));
    row.appendChild(el('span', 'fact-value', value === null || value === undefined || value === '' ? '—' : String(value)));
    return row;
  };

  let busy = [];
  const withBusy = async (work) => {
    for (const control of busy) control.disabled = true;
    try {
      await work();
      await render();
    } catch (error) {
      const line = mount.querySelector ? mount.querySelector('.spine-error') : null;
      if (line) line.textContent = error?.message ?? 'The request failed';
      else throw error;
    } finally {
      for (const control of busy) control.disabled = false;
    }
  };

  async function render() {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
    busy = [];

    let context;
    try {
      context = await client.request('/api/spine/context');
    } catch (error) {
      // A 404 means no spine is composed — which is a *finding*, not an empty
      // screen. Saying nothing here is how an operator concludes they are
      // protected when they are not.
      const panel = el('div', 'spine-section');
      panel.appendChild(el('h3', undefined, 'Identity, tenancy and authorization'));
      panel.appendChild(el('p', 'field-error spine-no-spine', NO_SPINE_WARNING));
      panel.appendChild(el('p', 'muted', ORGANIZATION_IS_NOT_A_COMPANY));
      mount.appendChild(panel);
      return;
    }

    const panel = el('div', 'spine-section');
    panel.setAttribute('data-spine-contract', String(context.spineContract ?? ''));
    panel.setAttribute('data-mode', String(context.mode ?? ''));
    panel.appendChild(el('h3', undefined, 'Identity, tenancy and authorization'));

    // The local-development warning, loud and in every state of this section.
    if (context.warning) {
      const warning = el('p', 'field-error spine-mode-warning', context.warning);
      warning.setAttribute('data-warning', 'local-development');
      panel.appendChild(warning);
    }

    const error = el('small', 'field-error spine-error', '');
    panel.appendChild(error);

    // ── who am I ────────────────────────────────────────────────────────
    const identityBox = el('div', 'spine-identity');
    identityBox.appendChild(el('h4', undefined, 'Signed in as'));
    const identity = context.identity ?? null;
    identityBox.appendChild(fact('Subject', identity?.subject));
    identityBox.appendChild(fact('Verified by', identity?.issuer));
    identityBox.appendChild(fact('Evidence', identity?.method));
    // The distinction that matters most on this screen.
    const kind = identity?.kind ?? 'anonymous';
    const kindRow = fact('Identity kind', kind);
    kindRow.setAttribute('data-identity-kind', kind);
    identityBox.appendChild(kindRow);
    if (kind !== 'verified-user') {
      identityBox.appendChild(el('p', 'muted spine-not-verified',
        kind === 'asserted-local'
          ? 'This identity was ASSERTED, not verified. It is accepted only because this runtime is in '
            + 'local-development mode, and it would be refused in production.'
          : 'Nothing about this identity was verified.'));
    }
    panel.appendChild(identityBox);

    // ── which tenant ────────────────────────────────────────────────────
    const orgBox = el('div', 'spine-organization');
    orgBox.appendChild(el('h4', undefined, 'Organization (tenant)'));
    orgBox.appendChild(el('p', 'muted spine-org-not-company', ORGANIZATION_IS_NOT_A_COMPANY));
    orgBox.appendChild(fact('Name', context.organization?.name));
    orgBox.appendChild(fact('Slug', context.organization?.slug));
    orgBox.appendChild(fact('Provenance', context.organization?.provenance));
    orgBox.appendChild(fact('Your role', context.membership?.role));
    const permissions = Array.isArray(context.permissions) ? context.permissions : [];
    const permissionList = el('p', 'spine-permissions', permissions.join(', ') || 'none');
    permissionList.setAttribute('data-permission-count', String(permissions.length));
    orgBox.appendChild(permissionList);
    orgBox.appendChild(fact('Tenant strategy', context.tenantStrategy));

    // The bound tenant, stated as bound. An operator reading this screen needs
    // to know not just which Organization they are in, but that this instance
    // cannot serve another one — otherwise the absence of a tenant switcher
    // looks like a missing feature rather than the security posture.
    const bound = context.boundTenant ?? null;
    const boundRow = fact('Bound tenant', bound?.slug);
    boundRow.setAttribute('data-bound-tenant', String(bound?.slug ?? ''));
    orgBox.appendChild(boundRow);

    const isolation = context.tenantIsolation ?? null;
    const posture = el('p', 'muted spine-single-tenant-posture', SINGLE_TENANT_POSTURE);
    posture.setAttribute('data-crm-data-plane-enforced', String(isolation?.crmDataPlaneEnforced === true));
    posture.setAttribute('data-shared-database-multi-tenancy', String(isolation?.sharedDatabaseMultiTenancy === true));
    orgBox.appendChild(posture);

    // Should never render. See the constant: a screen that can only say "fine"
    // cannot report the one failure an operator most needs to see.
    if (isolation && isolation.crmDataPlaneEnforced !== true) {
      const gap = el('p', 'error spine-tenant-isolation-gap', TENANT_ISOLATION_WARNING);
      gap.setAttribute('data-crm-data-plane-enforced', 'false');
      orgBox.appendChild(gap);
    }
    panel.appendChild(orgBox);

    // ── roles, so a person can see what a role means before granting it ──
    const rolesBox = el('div', 'spine-roles');
    rolesBox.appendChild(el('h4', undefined, 'Roles and what they permit'));
    for (const [role, keys] of Object.entries(context.roles ?? {})) {
      const row = el('p', 'spine-role');
      row.setAttribute('data-role', role);
      row.appendChild(el('strong', undefined, `${role}: `));
      row.appendChild(el('span', undefined, (Array.isArray(keys) ? keys : []).join(', ')));
      rolesBox.appendChild(row);
    }
    panel.appendChild(rolesBox);

    // ── memberships, only for somebody permitted to see them ────────────
    const canAdminister = permissions.includes('admin.memberships.manage');
    const memberBox = el('div', 'spine-memberships');
    memberBox.appendChild(el('h4', undefined, 'Members'));
    if (!canAdminister) {
      // A refusal rendered as a refusal, not as an empty list.
      const denied = el('p', 'muted spine-denied',
        'You do not hold admin.memberships.manage, so the member list is not shown. This is a refusal, '
        + 'not an empty organization.');
      denied.setAttribute('data-denied', 'admin.memberships.manage');
      memberBox.appendChild(denied);
    } else {
      let members = [];
      let unreadable = null;
      try {
        members = (await client.request('/api/spine/memberships')).items ?? [];
      } catch (readError) {
        unreadable = readError?.message ?? 'the request failed';
      }
      if (unreadable) {
        memberBox.appendChild(el('p', 'field-error spine-members-unreadable',
          `The member list could not be read, so it is not shown. That is not a claim that there are none. (${unreadable})`));
      } else {
        memberBox.appendChild(el('p', 'muted', `${members.length} member(s)`));
        for (const member of members.slice(0, 50)) {
          const row = el('p', 'spine-member');
          row.setAttribute('data-subject', String(member.subject));
          row.appendChild(el('span', 'spine-member-subject', member.subject));
          row.appendChild(el('span', 'spine-member-role', ` — ${member.role} (${member.status})`));
          memberBox.appendChild(row);
        }

        // Granting: a subject the operator already knows, and a reason. No
        // email is sent, because no email system exists — and pretending
        // otherwise would be the worst kind of half-feature.
        const subjectInput = el('input');
        subjectInput.setAttribute('name', 'subject');
        subjectInput.setAttribute('placeholder', 'subject id at your identity provider');
        const roleSelect = el('select');
        roleSelect.setAttribute('name', 'role');
        for (const role of Object.keys(context.roles ?? {})) {
          const option = el('option', undefined, role);
          option.setAttribute('value', role);
          roleSelect.appendChild(option);
        }
        roleSelect.value = Object.keys(context.roles ?? {})[0] ?? '';
        const reasonInput = el('input');
        reasonInput.setAttribute('name', 'reason');
        reasonInput.setAttribute('placeholder', 'Why (required, recorded with your identity)');

        for (const [label, control] of [['Subject', subjectInput], ['Role', roleSelect], ['Reason', reasonInput]]) {
          const row = el('p', 'spine-field');
          row.appendChild(el('strong', undefined, `${label}: `));
          row.appendChild(control);
          memberBox.appendChild(row);
        }

        const grantButton = el('button', undefined, 'Grant membership');
        grantButton.setAttribute('data-action', 'grant-membership');
        busy.push(grantButton);
        grantButton.addEventListener('click', () => withBusy(async () => {
          await client.request('/api/spine/memberships', {
            method: 'POST',
            body: JSON.stringify({
              subject: String(subjectInput.value ?? ''),
              role: String(roleSelect.value ?? ''),
              reason: String(reasonInput.value ?? ''),
            }),
          });
        }));
        memberBox.appendChild(grantButton);
        memberBox.appendChild(el('p', 'muted spine-no-invitations',
          'No invitation is sent and no email exists. Granting records a decision about a subject your '
          + 'identity provider already knows.'));
      }
    }
    panel.appendChild(memberBox);

    // ── what this build cannot promise ──────────────────────────────────
    const limits = el('div', 'spine-limits');
    limits.appendChild(el('h4', undefined, 'What this does not do'));
    for (const limitation of context.limitations ?? []) {
      limits.appendChild(el('p', 'muted spine-limit', limitation));
    }
    for (const absent of context.notModeled ?? []) {
      limits.appendChild(el('p', 'muted spine-not-modeled', `Not modeled: ${absent}`));
    }
    limits.appendChild(el('p', 'muted spine-no-readiness',
      'This is not a production-readiness statement. PostgreSQL and shared-database tenancy, durable jobs, '
      + 'secrets, backups and deployment are all absent.'));
    panel.appendChild(limits);

    mount.appendChild(panel);
  }

  return { render };
}
