// RBAC enforcement — casbin policy synthesized per namespace.
//
// The policy text has three layers:
//   1. Built-in role permissions (p rows) — owner/developer/viewer action
//      sets scoped to the namespace.
//   2. Domain assignments (g rows) — memberships, user-group expansion, and
//      service accounts map principals to roles in this namespace.
//   3. Custom casbin_rules rows — arbitrary p/g lines written through the
//      admin API for policies the built-ins don't cover.
//
// Principals: `user:{userId}` for users, `svc:{serviceAccountId}` for
// service accounts, `group:{groupId}` for user groups. The domain is the
// namespace id — every rule is scoped, so one enforcer per namespace.

import { newEnforcer, newModelFromString, StringAdapter, type Enforcer } from "casbin";

import type { Db } from "@/worker/db/d1/client";
import { listMembershipsForNamespace } from "@/worker/db/d1/dal/namespaces";
import {
  listCasbinRules,
  listGroupsForUserInNamespace,
  listServiceAccounts,
  listUserGroupMembers,
  listUserGroups,
} from "@/worker/db/d1/dal/rbac";

const MODEL_TEXT = `
[request_definition]
r = sub, dom, obj, act
[policy_definition]
p = sub, dom, obj, act
[role_definition]
g = _, _, _
[policy_effect]
e = some(where (p.eft == allow))
[matchers]
m = g(r.sub, p.sub, r.dom) && r.dom == p.dom && keyMatch(r.obj, p.obj) && regexMatch(r.act, p.act)
`;

const model = newModelFromString(MODEL_TEXT);

/** Built-in roles → action regex (matched against r.act). */
export const ROLE_ACTIONS: Record<string, string> = {
  owner: ".*",
  developer: "read|write|push|execute",
  viewer: "read",
};

export const VALID_ROLES = Object.keys(ROLE_ACTIONS);

export function principalForUser(userId: string): string {
  return `user:${userId}`;
}

export function principalForServiceAccount(id: string): string {
  return `svc:${id}`;
}

/** Synthesize the namespace's casbin policy text. Exported for tests. */
export async function policyForNamespace(db: Db, namespaceId: string): Promise<string> {
  const lines: string[] = [];
  for (const [role, actions] of Object.entries(ROLE_ACTIONS)) {
    lines.push(`p, role:${role}, ${namespaceId}, *, ${actions}`);
  }
  const [memberships, groups, sas, custom] = await Promise.all([
    listMembershipsForNamespace(db, namespaceId),
    listUserGroups(db, namespaceId),
    listServiceAccounts(db, namespaceId),
    listCasbinRules(db),
  ]);
  for (const m of memberships) {
    lines.push(`g, ${principalForUser(m.userId)}, role:${m.role}, ${namespaceId}`);
  }
  for (const g of groups) {
    lines.push(`g, group:${g.id}, role:${g.role}, ${namespaceId}`);
    const members = await listUserGroupMembers(db, g.id);
    for (const m of members) {
      lines.push(`g, ${principalForUser(m.userId)}, group:${g.id}, ${namespaceId}`);
    }
  }
  for (const sa of sas) {
    if (sa.active === 1) {
      lines.push(`g, ${principalForServiceAccount(sa.id)}, role:${sa.role}, ${namespaceId}`);
    }
  }
  for (const rule of custom) {
    // Custom rows only apply when scoped to this namespace (v3 = domain for
    // 3-field g rows; v1 = domain for 4-field p rows).
    const dom = rule.ptype === "g" ? (rule.v3 ?? rule.v2) : rule.v1;
    if (dom !== namespaceId) continue;
    const fields = [rule.v0, rule.v1, rule.v2, rule.v3, rule.v4, rule.v5].filter(
      (v): v is string => v !== null
    );
    lines.push(`${rule.ptype}, ${fields.join(", ")}`);
  }
  return lines.join("\n");
}

/** Enforce a single (sub, dom, obj, act) tuple against the namespace policy. */
export async function enforceInNamespace(
  db: Db,
  namespaceId: string,
  sub: string,
  obj: string,
  act: string
): Promise<boolean> {
  const policy = await policyForNamespace(db, namespaceId);
  const enforcer: Enforcer = await newEnforcer(model, new StringAdapter(policy));
  return enforcer.enforce(sub, namespaceId, obj, act);
}

/** The strongest built-in role a user holds in this namespace — direct
 *  membership wins, then group-derived roles. Returns null when the user
 *  has no access at all (mirrors the old membership-existence gate). */
export async function effectiveRoleForUser(
  db: Db,
  namespaceId: string,
  userId: string
): Promise<string | null> {
  const members = await listMembershipsForNamespace(db, namespaceId);
  const direct = members.find((m) => m.userId === userId);
  if (direct) return direct.role;
  const groups = await listGroupsForUserInNamespace(db, namespaceId, userId);
  if (!groups.length) return null;
  const rank = (r: string) => (r === "owner" ? 3 : r === "developer" ? 2 : 1);
  return groups.map((g) => g.role).sort((a, b) => rank(b) - rank(a))[0];
}

/** Does `sub` hold at least `act` on `obj` in this namespace — the
 *  membership gate first (cheap), then casbin for custom-rule denies. */
export async function allowedInNamespace(
  db: Db,
  namespaceId: string,
  sub: string,
  obj: string,
  act: string
): Promise<boolean> {
  return enforceInNamespace(db, namespaceId, sub, obj, act);
}
