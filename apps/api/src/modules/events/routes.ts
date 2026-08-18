import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { authenticateRequest, requirePermission } from "../auth/routes";
import { AuthError, type AuthService } from "../auth/service";
import { EventError, EventService } from "./service";

const ListQuerySchema = z.object({
  topic: z.string().optional(),
  state: z.enum(["pending", "published", "failed"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

const PublishSchema = z.object({
  topic: z.string(),
  aggregateId: z.string().trim().min(1).max(160),
  schemaVersion: z.number().int().min(1).max(100).default(1),
  payload: z.record(z.string(), z.unknown()).default({})
});

const MarkFailedSchema = z.object({
  failureReason: z.string().trim().min(1).max(500)
});
const DrainSchema = z.object({
  limit: z.number().int().min(1).max(100).default(25),
  includeFailed: z.boolean().default(false)
});
const DlqReplaySchema = z.object({
  topic: z.string().optional(),
  reasonContains: z.string().trim().min(1).max(160).optional(),
  limit: z.number().int().min(1).max(100).default(25),
  dryRun: z.boolean().default(false)
});
const InboxListQuerySchema = z.object({
  consumerName: z.string().trim().min(1).max(120).optional(),
  topic: z.string().optional(),
  status: z.enum(["processed", "failed"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});
const InboxRecordSchema = z.object({
  consumerName: z.string().trim().min(1).max(120),
  status: z.enum(["processed", "failed"]).default("processed"),
  failureReason: z.string().trim().min(1).max(500).optional(),
  event: z.object({
    id: z.string().trim().min(1).max(160),
    topic: z.string(),
    tenantId: z.string().trim().min(1).max(160),
    aggregateId: z.string().trim().min(1).max(160),
    schemaVersion: z.number().int().min(1).max(100).default(1),
    correlationId: z.string().trim().min(1).max(160),
    payload: z.record(z.string(), z.unknown()).default({})
  })
});

export async function registerEventRoutes(app: FastifyInstance, auth: AuthService, events: EventService): Promise<void> {
  app.get("/admin/events/catalog", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "admin.events.read");
      return { topics: events.catalog() };
    } catch (error) {
      return sendEventError(reply, error);
    }
  });

  app.get("/admin/events", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "admin.events.read");
      const query = ListQuerySchema.parse(request.query);
      return serialize(
        await events.list({
          principal,
          ...(query.topic ? { topic: query.topic } : {}),
          ...(query.state ? { state: query.state } : {}),
          limit: query.limit
        })
      );
    } catch (error) {
      return sendEventError(reply, error);
    }
  });

  app.post("/admin/events/outbox", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "admin.events.publish");
      const body = PublishSchema.parse(request.body);
      const event = await events.publishForPrincipal({
        principal,
        topic: body.topic,
        aggregateId: body.aggregateId,
        schemaVersion: body.schemaVersion,
        payload: body.payload,
        correlationId: correlationId(request)
      });
      reply.code(201);
      return { event: serializeEvent(event) };
    } catch (error) {
      return sendEventError(reply, error);
    }
  });

  app.post("/admin/events/drain", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "admin.events.publish");
      const body = DrainSchema.parse(request.body ?? {});
      return await events.drain({ principal, limit: body.limit, includeFailed: body.includeFailed });
    } catch (error) {
      return sendEventError(reply, error);
    }
  });

  app.get("/admin/events/inbox", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "admin.events.read");
      const query = InboxListQuerySchema.parse(request.query);
      const eventsList = await events.listInbox({
        principal,
        ...(query.consumerName ? { consumerName: query.consumerName } : {}),
        ...(query.topic ? { topic: query.topic } : {}),
        ...(query.status ? { status: query.status } : {}),
        limit: query.limit
      });
      return { events: eventsList.map(serializeInboxEvent) };
    } catch (error) {
      return sendEventError(reply, error);
    }
  });

  app.post("/admin/events/inbox/record", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "admin.events.publish");
      const body = InboxRecordSchema.parse(request.body);
      const result = await events.recordInbox({
        principal,
        consumerName: body.consumerName,
        event: body.event,
        status: body.status,
        failureReason: body.failureReason ?? null
      });
      reply.code(result.duplicate ? 200 : 201);
      return { duplicate: result.duplicate, event: serializeInboxEvent(result.event) };
    } catch (error) {
      return sendEventError(reply, error);
    }
  });

  app.get("/admin/events/dlq", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "admin.events.read");
      const query = ListQuerySchema.pick({ topic: true, limit: true }).parse(request.query);
      return { events: (await events.listDlq({ principal, ...(query.topic ? { topic: query.topic } : {}), limit: query.limit })).map(serializeEvent) };
    } catch (error) {
      return sendEventError(reply, error);
    }
  });

  app.post("/admin/events/dlq/replay", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "admin.events.publish");
      const body = DlqReplaySchema.parse(request.body ?? {});
      return await events.replayDlq({
        principal,
        ...(body.topic ? { topic: body.topic } : {}),
        ...(body.reasonContains ? { reasonContains: body.reasonContains } : {}),
        limit: body.limit,
        dryRun: body.dryRun
      });
    } catch (error) {
      return sendEventError(reply, error);
    }
  });

  app.post("/admin/events/:id/mark-published", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "admin.events.publish");
      const params = z.object({ id: z.string().min(1) }).parse(request.params);
      return { event: serializeEvent(await events.markPublished({ principal, id: params.id })) };
    } catch (error) {
      return sendEventError(reply, error);
    }
  });

  app.post("/admin/events/:id/mark-failed", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "admin.events.publish");
      const params = z.object({ id: z.string().min(1) }).parse(request.params);
      const body = MarkFailedSchema.parse(request.body);
      return {
        event: serializeEvent(
          await events.markFailed({ principal, id: params.id, failureReason: body.failureReason })
        )
      };
    } catch (error) {
      return sendEventError(reply, error);
    }
  });

  app.post("/admin/events/:id/requeue", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "admin.events.publish");
      const params = z.object({ id: z.string().min(1) }).parse(request.params);
      return { event: serializeEvent(await events.requeueFailed({ principal, id: params.id })) };
    } catch (error) {
      return sendEventError(reply, error);
    }
  });
}

function serializeInboxEvent(event: {
  id: string;
  tenantId: string;
  consumerName: string;
  eventId: string;
  topic: string;
  aggregateId: string;
  schemaVersion: number;
  correlationId: string;
  payload: Record<string, unknown>;
  status: string;
  failureReason: string | null;
  receivedAt: Date;
  processedAt: Date | null;
}) {
  return {
    ...event,
    receivedAt: event.receivedAt.toISOString(),
    processedAt: event.processedAt?.toISOString() ?? null
  };
}

function serialize(input: Awaited<ReturnType<EventService["list"]>>) {
  return {
    backlog: input.backlog,
    events: input.events.map(serializeEvent)
  };
}

function serializeEvent(event: {
  id: string;
  tenantId: string;
  topic: string;
  aggregateId: string;
  schemaVersion: number;
  payload: Record<string, unknown>;
  correlationId: string;
  createdAt: Date;
  publishedAt: Date | null;
  failureReason: string | null;
}) {
  return {
    ...event,
    createdAt: event.createdAt.toISOString(),
    publishedAt: event.publishedAt?.toISOString() ?? null
  };
}

function sendEventError(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) {
    reply.code(400);
    return { error: { code: "VALIDATION_ERROR", issues: error.issues } };
  }
  if (error instanceof AuthError || error instanceof EventError) {
    reply.code(error.statusCode);
    return { error: { code: error.code } };
  }
  if (error instanceof Error && error.message === "UNKNOWN_KAFKA_TOPIC") {
    reply.code(400);
    return { error: { code: "UNKNOWN_KAFKA_TOPIC" } };
  }
  reply.code(500);
  return { error: { code: "INTERNAL_ERROR" } };
}

function correlationId(request: { headers: Record<string, unknown>; id: string }): string {
  const value = request.headers["x-correlation-id"];
  return typeof value === "string" ? value : request.id;
}
