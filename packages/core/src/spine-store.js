// @ts-check

import { randomUUID } from 'node:crypto';
import { AppError, ConflictError, NotFoundError, ValidationError } from './errors.js';
import { ROLES, ROLE_BUNDLES, decideAuthorization } from './authorization.js';
import { identityString } from './identity.js';

/**
 * **Organizations and memberships (ADR-038).**
 *
 * ### An Organization is not a Company
 *
 * This is the distinction the whole milestone rests on, so it is stated in the
 * table names, here, in the schema block, in the Admin and in the docs:
 *
 * - a **CRM Company** is a customer, recorded *inside* one tenant's data;
 * - an **Accordo Organization** is the tenant — a customer *of the software*,
 *   whose people log in and whose data is isolated from every other tenant's.
 *
 * Blurring them would be catastrophic in a specific way: it would make it
 * natural to "grant someone access to a Company", and from there to leak one
 * tenant's customer list into another tenant's authorization model.
 *
 * ### No self-grant
 *
 * Membership administration is the one permission that can manufacture every
 * other permission, so it carries two extra rules that are not negotiable:
 *
 * 1. **Nobody can grant a permission they do not hold.** An administrator
 *    cannot mint an owner. Otherwise `admin.memberships.manage` is silently
 *    equivalent to every permission there is.
 * 2. **The last active administrator cannot demote or suspend themselves.** Not
 *    to protect them — to stop an organization becoming permanently
 *    unadministrable, which is a support incident nobody can fix from inside.
 */

export const MAX_ORG_NAME = 200;
export const MAX_REASON = 500;

/** Slugs are the operator-facing tenant handle: bounded, lowercase, no surprises. */
const SLUG_RE = /^[a-z][a-z0-9-]{0,62}$/;

/** The one organization a local-development project gets, when it gets one. */
export const LOCAL_ORGANIZATION_SLUG = 'local-development';

/**
 * @param {{database: any, audit?: any, now?: () => string}} deps
 */
export function createSpineStore({ database, audit, now = () => new Date().toISOString() }) {
  const raw = database.raw ?? database;

  const rowToOrganization = (row) => row && Object.freeze({
    id: row.id,
    slug: row.slug,
    name: row.name,
    provenance: row.provenance,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  const rowToMembership = (row) => row && Object.freeze({
    id: row.id,
    organizationId: row.organization_id,
    subject: row.subject,
    issuer: row.issuer,
    role: row.role,
    status: row.status,
    grantedBySubject: row.granted_by_subject,
    grantedReason: row.granted_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    /** The permissions this membership actually carries, resolved from the bundle. */
    permissions: Object.freeze([...(ROLE_BUNDLES[/** @type {keyof typeof ROLE_BUNDLES} */ (row.role)] ?? [])]),
  });

  const organizations = {
    /** @param {{slug: string, name: string, provenance?: string}} input */
    create({ slug, name, provenance = 'operator-configured' }) {
      const cleanSlug = identityString(slug, 'organization.slug', { required: true, max: 63 });
      if (!SLUG_RE.test(/** @type {string} */ (cleanSlug))) {
        throw new ValidationError(
          'organization.slug must be lowercase letters, digits and hyphens, starting with a letter',
          { field: 'organization.slug' },
        );
      }
      const cleanName = identityString(name, 'organization.name', { required: true, max: MAX_ORG_NAME });
      if (!['operator-configured', 'local-development-migration'].includes(provenance)) {
        throw new ValidationError('organization.provenance is not one this framework records', {
          field: 'organization.provenance',
        });
      }
      if (organizations.bySlug(cleanSlug)) {
        throw new ConflictError(`an organization with slug "${cleanSlug}" already exists`, {
          field: 'organization.slug',
        });
      }
      const stamp = now();
      const id = `org_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
      raw.prepare(
        `INSERT INTO spine_organizations(id, slug, name, provenance, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, cleanSlug, cleanName, provenance, stamp, stamp);
      audit?.record?.({
        entityType: 'spine_organization', entityId: id, action: 'created',
        actor: { type: 'system', id: 'spine' }, data: { slug: cleanSlug, provenance },
      });
      return organizations.get(id);
    },

    /** @param {string} id */
    get(id) {
      if (typeof id !== 'string' || id === '') return null;
      return rowToOrganization(raw.prepare('SELECT * FROM spine_organizations WHERE id = ?').get(id)) ?? null;
    },

    /** @param {string} slug */
    bySlug(slug) {
      if (typeof slug !== 'string' || slug === '') return null;
      return rowToOrganization(raw.prepare('SELECT * FROM spine_organizations WHERE slug = ?').get(slug)) ?? null;
    },

    list({ limit = 100 } = {}) {
      return raw.prepare('SELECT * FROM spine_organizations ORDER BY created_at, id LIMIT ?')
        .all(Math.min(Number(limit) || 100, 500)).map(rowToOrganization);
    },
  };

  const memberships = {
    /**
     * The membership the authorizer asks about. Exact, indexed, tenant-scoped —
     * never a scan, and never "the first membership this subject has".
     *
     * @param {{organizationId: string, subject: string}} query
     */
    find({ organizationId, subject }) {
      if (typeof organizationId !== 'string' || typeof subject !== 'string') return null;
      if (organizationId === '' || subject === '') return null;
      const row = raw.prepare(
        'SELECT * FROM spine_memberships WHERE organization_id = ? AND subject = ?',
      ).get(organizationId, subject);
      return rowToMembership(row) ?? null;
    },

    /** @param {{organizationId: string, limit?: number}} query */
    listFor({ organizationId, limit = 200 }) {
      if (typeof organizationId !== 'string' || organizationId === '') return [];
      return raw.prepare(
        'SELECT * FROM spine_memberships WHERE organization_id = ? ORDER BY created_at, id LIMIT ?',
      ).all(organizationId, Math.min(Number(limit) || 200, 500)).map(rowToMembership);
    },

    /** Every organization one subject may act in — the Admin's tenant switcher. */
    listForSubject({ subject, limit = 100 }) {
      if (typeof subject !== 'string' || subject === '') return [];
      return raw.prepare(
        `SELECT * FROM spine_memberships WHERE subject = ? AND status = 'active' ORDER BY created_at, id LIMIT ?`,
      ).all(subject, Math.min(Number(limit) || 100, 500)).map(rowToMembership);
    },

    /**
     * Grant or change a membership. Human-only, authorized, and never a
     * self-grant.
     *
     * @param {{
     *   organizationId: string, subject: string, role: string, issuer?: string|null,
     *   reason: string, identity: any, mode: any,
     * }} input
     */
    grant({ organizationId, subject, role, issuer = null, reason, identity, mode }) {
      const organization = organizations.get(organizationId);
      if (!organization) throw new NotFoundError('Organization', String(organizationId));

      const cleanSubject = identityString(subject, 'membership.subject', { required: true });
      const cleanReason = identityString(reason, 'membership.reason', { required: true, max: MAX_REASON });
      const cleanIssuer = identityString(issuer, 'membership.issuer');
      if (typeof role !== 'string' || !ROLES.includes(role)) {
        throw new ValidationError(`membership.role must be one of ${ROLES.join(', ')}`, {
          field: 'membership.role',
        });
      }

      // The caller must themselves be permitted to administer memberships here.
      const actorMembership = identity?.subject
        ? memberships.find({ organizationId, subject: identity.subject })
        : null;
      const decision = decideAuthorization({
        identity, organizationId, permission: 'admin.memberships.manage',
        membership: actorMembership, mode,
      });
      if (!decision.allowed) {
        throw new AppError(decision.reason, {
          code: 'FORBIDDEN', status: 403,
          details: Object.freeze({ permission: 'admin.memberships.manage', reason: decision.code }),
        });
      }

      // Rule 1: nobody grants what they do not hold. Without this,
      // admin.memberships.manage is quietly equivalent to every permission.
      const granterPermissions = actorMembership?.permissions ?? [];
      const wanted = ROLE_BUNDLES[/** @type {keyof typeof ROLE_BUNDLES} */ (role)] ?? [];
      const escalation = wanted.filter((permission) => !granterPermissions.includes(permission));
      if (escalation.length > 0) {
        throw new AppError(
          `this membership would carry ${escalation.join(', ')}, which the granter does not hold`,
          {
            code: 'ROLE_ESCALATION_REFUSED', status: 403,
            details: Object.freeze({ role, escalation: Object.freeze([...escalation]) }),
          },
        );
      }

      const existing = memberships.find({ organizationId, subject: cleanSubject });

      // Rule 2: an organization must keep at least one active administrator.
      if (existing && identity.subject === cleanSubject) {
        const losing = (existing.permissions ?? []).includes('admin.memberships.manage')
          && !wanted.includes('admin.memberships.manage');
        if (losing && memberships.countAdministrators(organizationId) <= 1) {
          throw new ConflictError(
            'this is the last active administrator of the organization; demoting yourself would '
            + 'leave nobody able to administer it',
            { field: 'membership.role' },
          );
        }
      }

      const stamp = now();
      if (existing) {
        raw.prepare(
          `UPDATE spine_memberships
             SET role = ?, issuer = COALESCE(?, issuer), granted_by_subject = ?, granted_reason = ?, updated_at = ?
           WHERE id = ?`,
        ).run(role, cleanIssuer, identity.subject ?? null, cleanReason, stamp, existing.id);
        audit?.record?.({
          entityType: 'spine_membership', entityId: existing.id, action: 'role_changed',
          actor: { type: 'user', id: identity.subject ?? 'unknown' },
          data: { organizationId, subject: cleanSubject, from: existing.role, to: role, reason: cleanReason },
        });
        return memberships.find({ organizationId, subject: cleanSubject });
      }

      const id = `mem_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
      raw.prepare(
        `INSERT INTO spine_memberships(
           id, organization_id, subject, issuer, role, status,
           granted_by_subject, granted_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      ).run(id, organizationId, cleanSubject, cleanIssuer, role, identity.subject ?? null, cleanReason, stamp, stamp);
      audit?.record?.({
        entityType: 'spine_membership', entityId: id, action: 'granted',
        actor: { type: 'user', id: identity.subject ?? 'unknown' },
        data: { organizationId, subject: cleanSubject, role, reason: cleanReason },
      });
      return memberships.find({ organizationId, subject: cleanSubject });
    },

    /**
     * Suspend a membership. Same authorization, same last-administrator rule.
     *
     * @param {{organizationId: string, subject: string, reason: string, identity: any, mode: any}} input
     */
    suspend({ organizationId, subject, reason, identity, mode }) {
      const cleanSubject = identityString(subject, 'membership.subject', { required: true });
      const cleanReason = identityString(reason, 'membership.reason', { required: true, max: MAX_REASON });

      const actorMembership = identity?.subject
        ? memberships.find({ organizationId, subject: identity.subject })
        : null;
      const decision = decideAuthorization({
        identity, organizationId, permission: 'admin.memberships.manage',
        membership: actorMembership, mode,
      });
      if (!decision.allowed) {
        throw new AppError(decision.reason, {
          code: 'FORBIDDEN', status: 403,
          details: Object.freeze({ permission: 'admin.memberships.manage', reason: decision.code }),
        });
      }

      const existing = memberships.find({ organizationId, subject: cleanSubject });
      if (!existing) throw new NotFoundError('Membership', `${organizationId}/${cleanSubject}`);

      if (existing.permissions.includes('admin.memberships.manage')
        && memberships.countAdministrators(organizationId) <= 1) {
        throw new ConflictError(
          'this is the last active administrator of the organization; suspending it would leave '
          + 'nobody able to administer it',
          { field: 'membership.subject' },
        );
      }

      raw.prepare(`UPDATE spine_memberships SET status = 'suspended', granted_reason = ?, updated_at = ? WHERE id = ?`)
        .run(cleanReason, now(), existing.id);
      audit?.record?.({
        entityType: 'spine_membership', entityId: existing.id, action: 'suspended',
        actor: { type: 'user', id: identity.subject ?? 'unknown' },
        data: { organizationId, subject: cleanSubject, reason: cleanReason },
      });
      return memberships.find({ organizationId, subject: cleanSubject });
    },

    /** @param {string} organizationId */
    countAdministrators(organizationId) {
      const administering = ROLES.filter((role) =>
        (ROLE_BUNDLES[/** @type {keyof typeof ROLE_BUNDLES} */ (role)] ?? []).includes('admin.memberships.manage'));
      if (administering.length === 0) return 0;
      const placeholders = administering.map(() => '?').join(', ');
      const row = raw.prepare(
        `SELECT COUNT(*) AS n FROM spine_memberships
          WHERE organization_id = ? AND status = 'active' AND role IN (${placeholders})`,
      ).get(organizationId, ...administering);
      return Number(row?.n ?? 0);
    },

    /**
     * The very first administrator of a new organization.
     *
     * Bootstrapping is the one case rule 1 cannot cover — an empty organization
     * has nobody to do the granting — so it is a separate, named method rather
     * than a special case hidden inside `grant()`, and it refuses to run on an
     * organization that already has members.
     *
     * @param {{organizationId: string, subject: string, issuer?: string|null, role?: string}} input
     */
    bootstrapOwner({ organizationId, subject, issuer = null, role = 'owner' }) {
      const organization = organizations.get(organizationId);
      if (!organization) throw new NotFoundError('Organization', String(organizationId));
      if (memberships.listFor({ organizationId, limit: 1 }).length > 0) {
        throw new ConflictError(
          'this organization already has members, so it cannot be bootstrapped again',
          { field: 'organizationId' },
        );
      }
      const cleanSubject = identityString(subject, 'membership.subject', { required: true });
      if (!ROLES.includes(role)) {
        throw new ValidationError(`membership.role must be one of ${ROLES.join(', ')}`, { field: 'membership.role' });
      }
      const stamp = now();
      const id = `mem_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
      raw.prepare(
        `INSERT INTO spine_memberships(
           id, organization_id, subject, issuer, role, status,
           granted_by_subject, granted_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?)`,
      ).run(id, organizationId, cleanSubject, identityString(issuer, 'membership.issuer'), role,
        'bootstrapped as the first member of a new organization', stamp, stamp);
      audit?.record?.({
        entityType: 'spine_membership', entityId: id, action: 'bootstrapped',
        actor: { type: 'system', id: 'spine' },
        data: { organizationId, subject: cleanSubject, role },
      });
      return memberships.find({ organizationId, subject: cleanSubject });
    },
  };

  return Object.freeze({ organizations, memberships });
}
