import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app";
import { InMemoryAuthRepository } from "../auth/memory-repository";
import { RecordingEventProducer } from "./producer";
import { InMemoryEventRepository } from "./memory-repository";

describe("event outbox admin routes", () => {
  let app: FastifyInstance;
  let accessToken: string;
  let producer: RecordingEventProducer;

  beforeAll(async () => {
    producer = new RecordingEventProducer();
    app = await buildApp({
      authRepository: new InMemoryAuthRepository(),
      eventRepository: new InMemoryEventRepository(),
      eventProducer: producer
    });
    const register = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        tenantName: "Events Tenant",
        tenantSlug: "events",
        workspaceName: "Events",
        email: "owner@example.com",
        displayName: "Owner",
        password: "very-secure-password"
      }
    });
    accessToken = register.json().tokens.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it("requires authentication before exposing event catalog", async () => {
    const response = await app.inject({ method: "GET", url: "/admin/events/catalog" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("MISSING_BEARER_TOKEN");
  });

  it("persists, lists and transitions outbox events", async () => {
    const catalog = await app.inject({
      method: "GET",
      url: "/admin/events/catalog",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().topics["expense.created"].aggregate).toBe("Expense");

    const created = await app.inject({
      method: "POST",
      url: "/admin/events/outbox",
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-events-test" },
      payload: {
        topic: "expense.created",
        aggregateId: "expense_1",
        payload: { workspaceId: "workspace_1", amountMinor: "1200" }
      }
    });
    expect(created.statusCode).toBe(201);
    const event = created.json().event;
    expect(event.topic).toBe("expense.created");
    expect(event.correlationId).toBe("corr-events-test");
    expect(event.publishedAt).toBeNull();

    const pending = await app.inject({
      method: "GET",
      url: "/admin/events?state=pending&topic=expense.created",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(pending.statusCode).toBe(200);
    expect(pending.json().backlog.pending).toBe(1);
    expect(pending.json().events).toHaveLength(1);

    const failed = await app.inject({
      method: "POST",
      url: `/admin/events/${event.id}/mark-failed`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { failureReason: "Kafka unavailable" }
    });
    expect(failed.statusCode).toBe(200);
    expect(failed.json().event.failureReason).toBe("Kafka unavailable");

    const published = await app.inject({
      method: "POST",
      url: `/admin/events/${event.id}/mark-published`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(published.statusCode).toBe(200);
    expect(published.json().event.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(published.json().event.failureReason).toBeNull();

    const audit = await app.inject({
      method: "GET",
      url: "/admin/audit?resourceType=OutboxEvent&limit=20",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "event.outbox.published",
          resourceId: event.id,
          correlationId: "corr-events-test",
          metadata: expect.objectContaining({
            topic: "expense.created",
            aggregateId: "expense_1",
            schemaVersion: 1,
            state: "pending",
            payloadPresent: true,
            payloadKeyCount: 2,
            failureReasonPresent: false
          })
        }),
        expect.objectContaining({
          action: "event.outbox.mark_failed",
          resourceId: event.id,
          metadata: expect.objectContaining({
            topic: "expense.created",
            aggregateId: "expense_1",
            state: "failed",
            failureReasonPresent: true
          })
        }),
        expect.objectContaining({
          action: "event.outbox.mark_published",
          resourceId: event.id,
          metadata: expect.objectContaining({
            topic: "expense.created",
            aggregateId: "expense_1",
            state: "published",
            failureReasonPresent: false
          })
        })
      ])
    );
    const serializedAudit = JSON.stringify(audit.json().logs.filter((log: { resourceId: string }) => log.resourceId === event.id));
    expect(serializedAudit).not.toContain("workspace_1");
    expect(serializedAudit).not.toContain("1200");
    expect(serializedAudit).not.toContain("Kafka unavailable");
  });

  it("drains pending outbox events to the event producer", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/admin/events/outbox",
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-drain-test" },
      payload: {
        topic: "report.generated",
        aggregateId: "export_1",
        payload: { workspaceId: "workspace_1", objectKey: "exports/monthly.pdf" }
      }
    });
    expect(created.statusCode).toBe(201);

    const drained = await app.inject({
      method: "POST",
      url: "/admin/events/drain",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { limit: 5 }
    });
    expect(drained.statusCode).toBe(200);
    expect(drained.json()).toMatchObject({ attempted: 1, published: 1, failed: 0, dlqPublished: 0 });
    expect(producer.messages.at(-1)).toMatchObject({
      topic: "report.generated",
      key: "export_1",
      headers: {
        "x-spendlens-correlation-id": "corr-drain-test"
      }
    });

    const list = await app.inject({
      method: "GET",
      url: "/admin/events?state=published&topic=report.generated",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().events[0].publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("marks failed events and emits a DLQ envelope when producer delivery fails", async () => {
    producer.failTopics.add("expense.updated");
    const created = await app.inject({
      method: "POST",
      url: "/admin/events/outbox",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        topic: "expense.updated",
        aggregateId: "expense_2",
        payload: { status: "APPROVED" }
      }
    });
    expect(created.statusCode).toBe(201);

    const drained = await app.inject({
      method: "POST",
      url: "/admin/events/drain",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { limit: 5 }
    });
    expect(drained.statusCode).toBe(200);
    expect(drained.json()).toMatchObject({ attempted: 1, published: 0, failed: 1, dlqPublished: 1 });
    expect(drained.json().events[0].dlqTopic).toBe("expense.updated.dlq");
    expect(producer.messages.at(-1)).toMatchObject({
      topic: "expense.updated.dlq",
      key: "expense_2",
      value: {
        originalTopic: "expense.updated",
        failureReason: "PRODUCER_FAILED:expense.updated"
      },
      headers: {
        "x-spendlens-dlq": "true"
      }
    });

    const dlq = await app.inject({
      method: "GET",
      url: "/admin/events/dlq?topic=expense.updated",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(dlq.statusCode).toBe(200);
    expect(dlq.json().events).toHaveLength(1);
    expect(dlq.json().events[0]).toMatchObject({
      id: created.json().event.id,
      failureReason: expect.stringContaining("DLQ:expense.updated.dlq")
    });

    const requeued = await app.inject({
      method: "POST",
      url: `/admin/events/${created.json().event.id}/requeue`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(requeued.statusCode).toBe(200);
    expect(requeued.json().event.failureReason).toBeNull();
    expect(requeued.json().event.publishedAt).toBeNull();

    const pending = await app.inject({
      method: "GET",
      url: "/admin/events?state=pending&topic=expense.updated",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(pending.statusCode).toBe(200);
    expect(pending.json().events.some((event: { id: string }) => event.id === created.json().event.id)).toBe(true);

    producer.failTopics.delete("expense.updated");
  });

  it("previews and batch replays DLQ events with policy filters", async () => {
    producer.failTopics.add("expense.rejected");
    const first = await app.inject({
      method: "POST",
      url: "/admin/events/outbox",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        topic: "expense.rejected",
        aggregateId: "expense_replay_1",
        payload: { status: "REJECTED", reason: "policy_violation" }
      }
    });
    const second = await app.inject({
      method: "POST",
      url: "/admin/events/outbox",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        topic: "expense.rejected",
        aggregateId: "expense_replay_2",
        payload: { status: "REJECTED", reason: "duplicate" }
      }
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);

    const drained = await app.inject({
      method: "POST",
      url: "/admin/events/drain",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { limit: 10 }
    });
    expect(drained.statusCode).toBe(200);

    const preview = await app.inject({
      method: "POST",
      url: "/admin/events/dlq/replay",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { topic: "expense.rejected", reasonContains: "PRODUCER_FAILED", limit: 1, dryRun: true }
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      dryRun: true,
      policy: { topic: "expense.rejected", reasonContains: "PRODUCER_FAILED", limit: 1 },
      replayed: 0
    });
    expect(preview.json().events).toHaveLength(1);
    expect(preview.json().events[0]).toMatchObject({ action: "would_requeue", failureReason: expect.stringContaining("DLQ:expense.rejected.dlq") });

    const replay = await app.inject({
      method: "POST",
      url: "/admin/events/dlq/replay",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { topic: "expense.rejected", reasonContains: "PRODUCER_FAILED", limit: 5 }
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ dryRun: false, replayed: 2, skipped: 0 });
    expect(replay.json().events.map((event: { action: string }) => event.action)).toEqual(["requeued", "requeued"]);

    const pending = await app.inject({
      method: "GET",
      url: "/admin/events?state=pending&topic=expense.rejected",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(pending.statusCode).toBe(200);
    const pendingIds = pending.json().events.map((event: { id: string }) => event.id);
    expect(pendingIds).toEqual(expect.arrayContaining([first.json().event.id, second.json().event.id]));

    const audit = await app.inject({
      method: "GET",
      url: "/admin/audit?resourceType=EventDlqReplay&limit=10",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "event.dlq.replay_previewed",
          metadata: expect.objectContaining({
            topic: "expense.rejected",
            reasonFilterPresent: true,
            dryRun: true,
            replayed: 0,
            eventCount: 1
          })
        }),
        expect.objectContaining({
          action: "event.dlq.replayed",
          metadata: expect.objectContaining({
            topic: "expense.rejected",
            reasonFilterPresent: true,
            dryRun: false,
            replayed: 2,
            skipped: 0
          })
        })
      ])
    );
    const serializedAudit = JSON.stringify(audit.json().logs);
    expect(serializedAudit).not.toContain("PRODUCER_FAILED");
    expect(serializedAudit).not.toContain("policy_violation");
    expect(serializedAudit).not.toContain("duplicate");
    expect(serializedAudit).not.toContain("expense.rejected.dlq");

    producer.failTopics.delete("expense.rejected");
  });

  it("records inbox events once per consumer for idempotent handling", async () => {
    const me = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    const tenantId = me.json().principal.tenantId;
    const envelope = {
      id: "evt-inbox-1",
      topic: "expense.created",
      tenantId,
      aggregateId: "expense_inbox_1",
      schemaVersion: 1,
      correlationId: "corr-inbox-test",
      payload: { workspaceId: "workspace_1", amountMinor: "4200" }
    };

    const first = await app.inject({
      method: "POST",
      url: "/admin/events/inbox/record",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { consumerName: "Expense Projection", event: envelope }
    });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      duplicate: false,
      event: {
        consumerName: "expense projection",
        eventId: "evt-inbox-1",
        status: "processed",
        processedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)
      }
    });

    const duplicate = await app.inject({
      method: "POST",
      url: "/admin/events/inbox/record",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { consumerName: "Expense Projection", event: envelope }
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({ duplicate: true });

    const list = await app.inject({
      method: "GET",
      url: "/admin/events/inbox?consumerName=expense%20projection&topic=expense.created",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().events).toHaveLength(1);
    expect(list.json().events[0]).toMatchObject({ eventId: "evt-inbox-1", correlationId: "corr-inbox-test" });

    const failed = await app.inject({
      method: "POST",
      url: "/admin/events/inbox/record",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        consumerName: "Expense Projection",
        status: "failed",
        failureReason: "Projection failed after seeing raw payload amount 4200",
        event: {
          ...envelope,
          id: "evt-inbox-2",
          aggregateId: "expense_inbox_2",
          correlationId: "corr-inbox-failed",
          payload: { workspaceId: "workspace_1", amountMinor: "4200", internalNote: "raw payload value" }
        }
      }
    });
    expect(failed.statusCode).toBe(201);

    const audit = await app.inject({
      method: "GET",
      url: "/admin/audit?resourceType=InboxEvent&limit=10",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "event.inbox.recorded",
          resourceId: first.json().event.id,
          correlationId: "corr-inbox-test",
          metadata: expect.objectContaining({
            consumerName: "expense projection",
            eventId: "evt-inbox-1",
            topic: "expense.created",
            aggregateId: "expense_inbox_1",
            status: "processed",
            duplicate: false,
            payloadKeyCount: 2,
            failureReasonPresent: false
          })
        }),
        expect.objectContaining({
          action: "event.inbox.recorded",
          resourceId: duplicate.json().event.id,
          metadata: expect.objectContaining({
            eventId: "evt-inbox-1",
            duplicate: true
          })
        }),
        expect.objectContaining({
          action: "event.inbox.recorded",
          resourceId: failed.json().event.id,
          correlationId: "corr-inbox-failed",
          metadata: expect.objectContaining({
            eventId: "evt-inbox-2",
            status: "failed",
            payloadKeyCount: 3,
            failureReasonPresent: true
          })
        })
      ])
    );
    const serializedAudit = JSON.stringify(audit.json().logs);
    expect(serializedAudit).not.toContain("workspace_1");
    expect(serializedAudit).not.toContain("4200");
    expect(serializedAudit).not.toContain("raw payload value");
    expect(serializedAudit).not.toContain("Projection failed after seeing raw payload amount");
  });

  it("rejects inbox envelopes for another tenant", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/admin/events/inbox/record",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        consumerName: "expense-projection",
        event: {
          id: "evt-cross-tenant",
          topic: "expense.created",
          tenantId: "other-tenant",
          aggregateId: "expense_cross",
          schemaVersion: 1,
          correlationId: "corr-cross",
          payload: {}
        }
      }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("EVENT_TENANT_MISMATCH");
  });

  it("rejects unknown topics before writing to the outbox", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/admin/events/outbox",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        topic: "expense.deleted",
        aggregateId: "expense_1",
        payload: {}
      }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("UNKNOWN_KAFKA_TOPIC");
  });
});
