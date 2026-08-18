import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { kafkaTopics } from "@spendlens/shared";
import { authenticateRequest, requirePermission } from "../auth/routes";
import { AuthError, type AuthService } from "../auth/service";
import { WebhookError, WebhookService } from "./service";

const kafkaTopicSet = new Set<string>(kafkaTopics);

const CreateEndpointSchema = z.object({
  url: z.string().url().max(500),
  eventTypes: z.array(z.string().refine((value) => kafkaTopicSet.has(value), "UNKNOWN_KAFKA_TOPIC")).min(1).max(32)
});

const ListQuerySchema = z.object({
  includeDisabled: z.coerce.boolean().default(false)
});

const IdParamSchema = z.object({
  id: z.string().trim().min(1)
});

export async function registerWebhookRoutes(app: FastifyInstance, auth: AuthService, webhooks: WebhookService): Promise<void> {
  app.get("/webhooks", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "webhooks.manage");
      const query = ListQuerySchema.parse(request.query);
      return { endpoints: await webhooks.listEndpoints({ principal, includeDisabled: query.includeDisabled }) };
    } catch (error) {
      return sendWebhookError(reply, error);
    }
  });

  app.post("/webhooks", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "webhooks.manage");
      const body = CreateEndpointSchema.parse(request.body);
      const created = await webhooks.createEndpoint({ principal, url: body.url, eventTypes: body.eventTypes });
      reply.code(201);
      return created;
    } catch (error) {
      return sendWebhookError(reply, error);
    }
  });

  app.delete("/webhooks/:id", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "webhooks.manage");
      const params = IdParamSchema.parse(request.params);
      return { endpoint: await webhooks.disableEndpoint({ principal, id: params.id }) };
    } catch (error) {
      return sendWebhookError(reply, error);
    }
  });
}

function sendWebhookError(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) {
    reply.code(400);
    return { error: { code: "VALIDATION_ERROR", issues: error.issues } };
  }
  if (error instanceof AuthError || error instanceof WebhookError) {
    reply.code(error.statusCode);
    return { error: { code: error.code } };
  }
  reply.code(500);
  return { error: { code: "INTERNAL_ERROR" } };
}
