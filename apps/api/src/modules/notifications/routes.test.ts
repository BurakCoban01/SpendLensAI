import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app";
import { InMemoryAuditRepository } from "../audit/memory-repository";
import { InMemoryAuthRepository } from "../auth/memory-repository";
import type { AuthPrincipal } from "../auth/types";
import { InMemoryNotificationRepository } from "./memory-repository";
import { NotificationService } from "./service";

describe("notification routes and audit evidence", () => {
  let app: FastifyInstance;
  let accessToken: string;
  let tenantId: string;
  let userId: string;
  let auditRepository: InMemoryAuditRepository;
  let notificationRepository: InMemoryNotificationRepository;

  beforeAll(async () => {
    auditRepository = new InMemoryAuditRepository();
    notificationRepository = new InMemoryNotificationRepository();
    app = await buildApp({
      authRepository: new InMemoryAuthRepository(),
      auditRepository,
      notificationRepository
    });
    const register = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        tenantName: "Notification Tenant",
        tenantSlug: "notifications",
        workspaceName: "Inbox",
        email: "owner@example.com",
        displayName: "Owner",
        password: "very-secure-password"
      }
    });
    const body = register.json();
    accessToken = body.tokens.accessToken;
    tenantId = body.tenant.id;
    userId = body.user.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it("lists and marks notifications read with tenant-scoped audit evidence", async () => {
    const service = new NotificationService(notificationRepository, auditRepository);
    const principal: AuthPrincipal = {
      tenantId,
      userId,
      sessionId: "corr-notification-create",
      email: "owner@example.com",
      displayName: "Owner",
      roles: ["OWNER"],
      permissions: ["admin.audit.read"]
    };
    const created = await service.create({
      principal,
      type: "expense.approval",
      title: "Expense approved",
      body: "Your reimbursement claim was approved.",
      payload: { expenseId: "expense_1", internalNote: "visible notification payload is not copied to audit" }
    });

    const unread = await app.inject({
      method: "GET",
      url: "/notifications?unreadOnly=true",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(unread.statusCode).toBe(200);
    expect(unread.json().notifications[0]).toMatchObject({
      id: created.id,
      title: "Expense approved",
      readAt: null
    });

    const read = await app.inject({
      method: "POST",
      url: `/notifications/${created.id}/read`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().notification.readAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const audit = await app.inject({
      method: "GET",
      url: "/admin/audit?resourceType=Notification",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(audit.statusCode).toBe(200);
    const actions = audit.json().logs.map((log: { action: string }) => log.action);
    expect(actions).toEqual(expect.arrayContaining(["notification.created", "notification.read"]));

    const createdLog = audit
      .json()
      .logs.find((log: { action: string; resourceId: string }) => log.action === "notification.created" && log.resourceId === created.id);
    expect(createdLog).toMatchObject({
      actorUserId: userId,
      resourceId: created.id,
      metadata: {
        notificationId: created.id,
        userId,
        type: "expense.approval",
        title: "Expense approved",
        deliveredToActor: true
      }
    });
    expect(JSON.stringify(createdLog.metadata)).not.toContain("internalNote");

    const readLog = audit
      .json()
      .logs.find((log: { action: string; resourceId: string }) => log.action === "notification.read" && log.resourceId === created.id);
    expect(readLog).toMatchObject({
      actorUserId: userId,
      resourceId: created.id,
      metadata: {
        notificationId: created.id,
        userId,
        type: "expense.approval"
      }
    });
    expect(readLog.metadata.readAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
