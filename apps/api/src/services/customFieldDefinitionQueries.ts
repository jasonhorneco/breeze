/** Shared custom-field reads, independent of the executable AI tool registry. */
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { customFieldDefinitions } from '../db/schema/customFields';
import type { AuthContext } from '../middleware/auth';

/**
 * Custom-field definitions are a DUAL-AXIS (org XOR partner) config table: a
 * partner-wide definition has `org_id IS NULL`, and an org-owned one has
 * `partner_id IS NULL`. An `eq(orgId, auth.orgId)` filter silently drops every
 * partner-wide field — which for an MSP is most of them. Exported so
 * `export_dataset`'s `custom_fields` adapter runs this exact predicate list
 * instead of a second, narrower one.
 */
export function customFieldDefinitionConditions(auth: AuthContext): SQL[] {
  const conditions: SQL[] = [];
  if (auth.orgId) {
    conditions.push(
      sql`(${customFieldDefinitions.orgId} = ${auth.orgId} OR ${customFieldDefinitions.orgId} IS NULL)`
    );
    if (auth.partnerId) {
      conditions.push(
        sql`(${customFieldDefinitions.partnerId} = ${auth.partnerId} OR ${customFieldDefinitions.partnerId} IS NULL)`
      );
    }
    return conditions;
  }
  if (auth.partnerId) {
    // Partner-scope caller with no direct org: mirror
    // routes/customFields.ts:238-249 (`partnerId = P OR orgId IN
    // accessibleOrgIds`). `partnerId = P OR partnerId IS NULL` matches every
    // org-owned definition system-wide, leaving RLS as the only gate.
    const accessibleOrgIds = (auth.accessibleOrgIds ?? []).filter((id): id is string => Boolean(id));
    conditions.push(
      accessibleOrgIds.length > 0
        ? sql`(${customFieldDefinitions.partnerId} = ${auth.partnerId} OR ${customFieldDefinitions.orgId} IN ${accessibleOrgIds})`
        : eq(customFieldDefinitions.partnerId, auth.partnerId)
    );
  }
  return conditions;
}

export async function readCustomFieldDefinitions(auth: AuthContext) {
  const conditions = customFieldDefinitionConditions(auth);
  return db
    .select({
      id: customFieldDefinitions.id,
      name: customFieldDefinitions.name,
      fieldKey: customFieldDefinitions.fieldKey,
      type: customFieldDefinitions.type,
      required: customFieldDefinitions.required,
      options: customFieldDefinitions.options,
      deviceTypes: customFieldDefinitions.deviceTypes,
      defaultValue: customFieldDefinitions.defaultValue,
    })
    .from(customFieldDefinitions)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(customFieldDefinitions.name);
}
