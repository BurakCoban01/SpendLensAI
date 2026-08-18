export const roles = [
  "OWNER",
  "ADMIN",
  "FINANCE_MANAGER",
  "ACCOUNTANT",
  "EMPLOYEE",
  "REVIEWER",
  "ML_ENGINEER",
  "AUDITOR",
  "VIEWER"
] as const;

export type RoleCode = (typeof roles)[number];

export const permissions = [
  "tenant.manage",
  "users.manage",
  "workspace.manage",
  "documents.upload",
  "documents.read",
  "documents.delete",
  "ocr.run",
  "ocr.review",
  "annotations.manage",
  "expenses.create",
  "expenses.read",
  "expenses.update",
  "expenses.approve",
  "budgets.manage",
  "reports.export",
  "ai.use",
  "ai.manage",
  "models.train",
  "models.promote",
  "admin.health.read",
  "admin.events.read",
  "admin.events.publish",
  "admin.jobs.read",
  "admin.jobs.manage",
  "admin.cache.read",
  "admin.cache.manage",
  "admin.audit.read",
  "admin.audit.manage",
  "api_keys.manage",
  "webhooks.manage"
] as const;

export type PermissionCode = (typeof permissions)[number];

export const rolePermissions: Record<RoleCode, readonly PermissionCode[]> = {
  OWNER: permissions,
  ADMIN: permissions.filter((permission) => permission !== "tenant.manage"),
  FINANCE_MANAGER: [
    "documents.read",
    "ocr.review",
    "expenses.create",
    "expenses.read",
    "expenses.update",
    "expenses.approve",
    "budgets.manage",
    "reports.export",
    "ai.use"
  ],
  ACCOUNTANT: ["documents.read", "expenses.read", "reports.export", "admin.audit.read"],
  EMPLOYEE: ["documents.upload", "documents.read", "ocr.run", "expenses.create", "expenses.read"],
  REVIEWER: ["documents.read", "ocr.review", "annotations.manage", "expenses.read", "expenses.update", "ai.use"],
  ML_ENGINEER: [
    "documents.read",
    "ocr.run",
    "annotations.manage",
    "ai.use",
    "ai.manage",
    "models.train",
    "models.promote",
    "admin.health.read",
    "admin.events.read",
    "admin.jobs.read",
    "admin.jobs.manage",
    "admin.cache.read"
  ],
  AUDITOR: ["documents.read", "expenses.read", "reports.export", "admin.audit.read"],
  VIEWER: ["documents.read", "expenses.read"]
};

export function roleHasPermission(role: RoleCode, permission: PermissionCode): boolean {
  return rolePermissions[role].includes(permission);
}
