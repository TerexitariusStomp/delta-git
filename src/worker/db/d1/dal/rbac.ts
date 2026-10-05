// RBAC DAL — casbin rule rows plus the domain tables (user groups,
// service accounts, resource groups) the policy plane describes.

import { and, eq, isNull } from "drizzle-orm";

import type { Db } from "../client";
import {
  casbinRules,
  resourceGroupItems,
  resourceGroups,
  serviceAccounts,
  userGroupMembers,
  userGroups,
  type CasbinRuleRow,
  type ResourceGroupItemRow,
  type ResourceGroupRow,
  type ServiceAccountRow,
  type UserGroupMemberRow,
  type UserGroupRow,
} from "../schema";

// --- casbin rules ------------------------------------------------------------

export async function listCasbinRules(db: Db): Promise<CasbinRuleRow[]> {
  return db.select().from(casbinRules).all();
}

export async function insertCasbinRule(db: Db, row: Omit<CasbinRuleRow, "id">): Promise<void> {
  await db.insert(casbinRules).values(row).run();
}

export async function deleteCasbinRule(db: Db, row: Omit<CasbinRuleRow, "id">): Promise<void> {
  const clauses = [eq(casbinRules.ptype, row.ptype)];
  for (const [col, val] of [
    [casbinRules.v0, row.v0],
    [casbinRules.v1, row.v1],
    [casbinRules.v2, row.v2],
    [casbinRules.v3, row.v3],
    [casbinRules.v4, row.v4],
    [casbinRules.v5, row.v5],
  ] as const) {
    if (val === null || val === undefined) clauses.push(isNull(col));
    else clauses.push(eq(col, val));
  }
  await db
    .delete(casbinRules)
    .where(and(...clauses))
    .run();
}

// --- user groups -------------------------------------------------------------

export async function listUserGroups(db: Db, namespaceId: string): Promise<UserGroupRow[]> {
  return db.select().from(userGroups).where(eq(userGroups.namespaceId, namespaceId)).all();
}

export async function findUserGroup(
  db: Db,
  namespaceId: string,
  identifier: string
): Promise<UserGroupRow | undefined> {
  return db
    .select()
    .from(userGroups)
    .where(and(eq(userGroups.namespaceId, namespaceId), eq(userGroups.identifier, identifier)))
    .get();
}

export async function insertUserGroup(
  db: Db,
  row: Omit<UserGroupRow, "createdAt">
): Promise<UserGroupRow> {
  const value = { ...row, createdAt: Date.now() };
  await db.insert(userGroups).values(value).run();
  return value;
}

export async function deleteUserGroup(db: Db, id: string): Promise<boolean> {
  const res = await db.delete(userGroups).where(eq(userGroups.id, id)).run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function listUserGroupMembers(db: Db, groupId: string): Promise<UserGroupMemberRow[]> {
  return db.select().from(userGroupMembers).where(eq(userGroupMembers.groupId, groupId)).all();
}

/** Every group id the user belongs to in this namespace. */
export async function listGroupsForUserInNamespace(
  db: Db,
  namespaceId: string,
  userId: string
): Promise<UserGroupRow[]> {
  const groups = await listUserGroups(db, namespaceId);
  if (!groups.length) return [];
  const rows = await db
    .select()
    .from(userGroupMembers)
    .where(eq(userGroupMembers.userId, userId))
    .all();
  const ids = new Set(rows.map((r) => r.groupId));
  return groups.filter((g) => ids.has(g.id));
}

export async function insertUserGroupMember(
  db: Db,
  groupId: string,
  userId: string
): Promise<void> {
  await db
    .insert(userGroupMembers)
    .values({ groupId, userId, createdAt: Date.now() })
    .onConflictDoNothing()
    .run();
}

export async function deleteUserGroupMember(
  db: Db,
  groupId: string,
  userId: string
): Promise<boolean> {
  const res = await db
    .delete(userGroupMembers)
    .where(and(eq(userGroupMembers.groupId, groupId), eq(userGroupMembers.userId, userId)))
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

// --- service accounts --------------------------------------------------------

export async function listServiceAccounts(
  db: Db,
  namespaceId: string
): Promise<ServiceAccountRow[]> {
  return db
    .select()
    .from(serviceAccounts)
    .where(eq(serviceAccounts.namespaceId, namespaceId))
    .all();
}

export async function findServiceAccount(
  db: Db,
  namespaceId: string,
  identifier: string
): Promise<ServiceAccountRow | undefined> {
  return db
    .select()
    .from(serviceAccounts)
    .where(
      and(eq(serviceAccounts.namespaceId, namespaceId), eq(serviceAccounts.identifier, identifier))
    )
    .get();
}

export async function findServiceAccountById(
  db: Db,
  id: string
): Promise<ServiceAccountRow | undefined> {
  return db.select().from(serviceAccounts).where(eq(serviceAccounts.id, id)).get();
}

export async function insertServiceAccount(
  db: Db,
  row: Omit<ServiceAccountRow, "createdAt">
): Promise<ServiceAccountRow> {
  const value = { ...row, createdAt: Date.now() };
  await db.insert(serviceAccounts).values(value).run();
  return value;
}

export async function updateServiceAccount(
  db: Db,
  id: string,
  patch: Partial<Pick<ServiceAccountRow, "role" | "active" | "description">>
): Promise<boolean> {
  const res = await db.update(serviceAccounts).set(patch).where(eq(serviceAccounts.id, id)).run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function deleteServiceAccount(db: Db, id: string): Promise<boolean> {
  const res = await db.delete(serviceAccounts).where(eq(serviceAccounts.id, id)).run();
  return (res.meta?.changes ?? 0) > 0;
}

// --- resource groups ---------------------------------------------------------

export async function listResourceGroups(db: Db, namespaceId: string): Promise<ResourceGroupRow[]> {
  return db.select().from(resourceGroups).where(eq(resourceGroups.namespaceId, namespaceId)).all();
}

export async function findResourceGroup(
  db: Db,
  namespaceId: string,
  identifier: string
): Promise<ResourceGroupRow | undefined> {
  return db
    .select()
    .from(resourceGroups)
    .where(
      and(eq(resourceGroups.namespaceId, namespaceId), eq(resourceGroups.identifier, identifier))
    )
    .get();
}

export async function insertResourceGroup(
  db: Db,
  row: Omit<ResourceGroupRow, "createdAt">
): Promise<ResourceGroupRow> {
  const value = { ...row, createdAt: Date.now() };
  await db.insert(resourceGroups).values(value).run();
  return value;
}

export async function deleteResourceGroup(db: Db, id: string): Promise<boolean> {
  const res = await db.delete(resourceGroups).where(eq(resourceGroups.id, id)).run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function listResourceGroupItems(
  db: Db,
  groupId: string
): Promise<ResourceGroupItemRow[]> {
  return db.select().from(resourceGroupItems).where(eq(resourceGroupItems.groupId, groupId)).all();
}

export async function insertResourceGroupItem(db: Db, row: ResourceGroupItemRow): Promise<void> {
  await db.insert(resourceGroupItems).values(row).onConflictDoNothing().run();
}

export async function deleteResourceGroupItem(db: Db, row: ResourceGroupItemRow): Promise<boolean> {
  const res = await db
    .delete(resourceGroupItems)
    .where(
      and(
        eq(resourceGroupItems.groupId, row.groupId),
        eq(resourceGroupItems.resourceType, row.resourceType),
        eq(resourceGroupItems.resourceRef, row.resourceRef)
      )
    )
    .run();
  return (res.meta?.changes ?? 0) > 0;
}
