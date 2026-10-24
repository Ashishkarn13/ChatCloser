// test/auth.test.js
// Staff accounts, roles and permissions.

import test from "node:test";
import assert from "node:assert/strict";
import { makeBusiness } from "./helpers.js";

import {
  createUser,
  getUser,
  listUsers,
  updateUser,
  setUserPassword,
  deleteUser,
  countOwners,
  authenticate,
  isLockedOut,
  recordLoginAttempt,
} from "../src/services/auth.js";
import { can, canAny, resolvePermissions, ROLE_PERMISSIONS, PERMISSIONS } from "../src/core/rbac.js";
import { verifyPassword, hashPassword } from "../crypto-utils.js";

test("passwords are hashed and never stored in plain text", () => {
  const hash = hashPassword("correct horse battery staple");
  assert.ok(!hash.includes("correct horse"));
  assert.equal(verifyPassword("correct horse battery staple", hash), true);
  assert.equal(verifyPassword("wrong password", hash), false);
});

test("a user is created with the right role and business", async () => {
  const businessId = await makeBusiness("Auth Business");
  const user = createUser(businessId, { username: "ram", password: "password123", role: "staff" });

  assert.equal(user.role, "staff");
  assert.equal(user.business_id, businessId);
  assert.equal(verifyPassword("password123", user.password_hash), true);
});

test("the same username may exist in two businesses", async () => {
  const a = await makeBusiness("Business A");
  const b = await makeBusiness("Business B");

  const userA = createUser(a, { username: "same", password: "password123", role: "staff" });
  const userB = createUser(b, { username: "same", password: "password123", role: "staff" });

  assert.notEqual(userA.id, userB.id);
  assert.equal(getUser(a, "same").id, userA.id);
  assert.equal(getUser(b, "same").id, userB.id);
});

test("a duplicate username in the same business is refused", async () => {
  const businessId = await makeBusiness("Auth Business");
  createUser(businessId, { username: "twice", password: "password123" });
  assert.throws(
    () => createUser(businessId, { username: "twice", password: "password123" }),
    /already taken/i
  );
});

test("a short password is refused", async () => {
  const businessId = await makeBusiness("Auth Business");
  assert.throws(
    () => createUser(businessId, { username: "short", password: "123" }),
    /at least 8 characters/i
  );
});

test("the last owner cannot be removed", async () => {
  const businessId = await makeBusiness("Auth Business");
  const owner = createUser(businessId, { username: "theowner", password: "password123", role: "owner" });
  const staff = createUser(businessId, { username: "astaff", password: "password123", role: "staff" });

  assert.equal(countOwners(businessId), 1);
  assert.throws(() => deleteUser(businessId, "theowner", "test"), /last owner/i);

  deleteUser(businessId, "astaff", "test");
  assert.equal(listUsers(businessId).length, 1);
  assert.ok(owner);
});

test("a password can be changed and the old one stops working", async () => {
  const businessId = await makeBusiness("Auth Business");
  createUser(businessId, { username: "changer", password: "old-password", role: "staff" });

  setUserPassword(businessId, "changer", "new-password", "test");

  const user = getUser(businessId, "changer");
  assert.equal(verifyPassword("new-password", user.password_hash), true);
  assert.equal(verifyPassword("old-password", user.password_hash), false);
});

test("an account is locked out after too many failed attempts", async () => {
  const businessId = await makeBusiness("Auth Business");
  createUser(businessId, { username: "target", password: "right-password", role: "staff" });

  for (let i = 0; i < 8; i += 1) {
    recordLoginAttempt("target", "10.0.0.1", false);
  }

  assert.equal(isLockedOut("target", "10.0.0.1"), true);
  const result = authenticate(businessId, "target", "right-password", "10.0.0.1");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "locked");
});

test("the right password signs in and a wrong one does not", async () => {
  const businessId = await makeBusiness("Auth Business");
  createUser(businessId, { username: "real", password: "right-password", role: "staff" });

  const bad = authenticate(businessId, "real", "wrong", "10.0.0.2");
  assert.equal(bad.ok, false);

  const good = authenticate(businessId, "real", "right-password", "10.0.0.2");
  assert.equal(good.ok, true);
  assert.equal(good.user.username, "real");
});

test("an owner has every permission", () => {
  const owner = { role: "owner" };
  for (const permission of Object.values(PERMISSIONS)) {
    assert.equal(can(owner, permission), true, `owner should have ${permission}`);
  }
});

test("a staff account does not have money or settings permissions", () => {
  const staff = { role: "staff" };
  assert.equal(can(staff, PERMISSIONS.LEADS_VIEW), true);
  assert.equal(can(staff, PERMISSIONS.CONVERSATIONS_REPLY), true);
  assert.equal(can(staff, PERMISSIONS.PAYMENTS_MANAGE), false);
  assert.equal(can(staff, PERMISSIONS.SETTINGS_EDIT), false);
  assert.equal(can(staff, PERMISSIONS.AUDIT_VIEW), false);
});

test("an accountant can manage payments but not the AI configuration", () => {
  const accountant = { role: "accountant" };
  assert.equal(can(accountant, PERMISSIONS.PAYMENTS_MANAGE), true);
  assert.equal(can(accountant, PERMISSIONS.PAYMENTS_REFUND), true);
  assert.equal(can(accountant, PERMISSIONS.AI_EDIT), false);
});

test("a per-user permission override can add or remove a permission", () => {
  const staff = { role: "staff", permissions: { [PERMISSIONS.SETTINGS_EDIT]: true } };
  assert.equal(can(staff, PERMISSIONS.SETTINGS_EDIT), true);
  assert.equal(can(staff, PERMISSIONS.AUDIT_VIEW), false);

  // An override can also take a permission away from a role bundle.
  const staffWithoutLeads = { role: "staff", permissions: { [PERMISSIONS.LEADS_VIEW]: false } };
  assert.equal(can(staffWithoutLeads, PERMISSIONS.LEADS_VIEW), false);
  assert.equal(can(staffWithoutLeads, PERMISSIONS.LEADS_EDIT), true);

  // An owner always keeps every permission — an owner can never be locked
  // out of the workspace they own.
  const ownerWithRevocation = { role: "owner", permissions: { [PERMISSIONS.AUDIT_VIEW]: false } };
  assert.equal(can(ownerWithRevocation, PERMISSIONS.AUDIT_VIEW), true);
});

test("canAny matches when at least one permission is held", () => {
  const staff = { role: "staff" };
  assert.equal(canAny(staff, [PERMISSIONS.AUDIT_VIEW, PERMISSIONS.LEADS_VIEW]), true);
  assert.equal(canAny(staff, [PERMISSIONS.AUDIT_VIEW, PERMISSIONS.PAYMENTS_MANAGE]), false);
});

test("every built-in role bundle only lists known permissions", () => {
  const known = new Set(Object.values(PERMISSIONS));
  for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
    for (const permission of permissions) {
      assert.ok(known.has(permission), `${role} lists an unknown permission: ${permission}`);
    }
  }
});

test("a role can be changed", async () => {
  const businessId = await makeBusiness("Auth Business");
  createUser(businessId, { username: "promoted", password: "password123", role: "staff" });

  const updated = updateUser(businessId, "promoted", { role: "manager" }, "test");
  assert.equal(updated.role, "manager");
});
