import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { authenticateRequest } from "../auth/routes";
import { AuthError, type AuthService } from "../auth/service";
import { NotificationError, NotificationService } from "./service";

const ListQuerySchema = z.object({
  unreadOnly: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

const IdParamSchema = z.object({
  id: z.string().trim().min(1)
});

export async function registerNotificationRoutes(
  app: FastifyInstance,
  auth: AuthService,
  notifications: NotificationService
): Promise<void> {
  app.get("/notifications", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      const query = ListQuerySchema.parse(request.query);
      return { notifications: await notifications.list({ principal, ...query }) };
    } catch (error) {
      return sendNotificationError(reply, error);
    }
  });

  app.post("/notifications/:id/read", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      const params = IdParamSchema.parse(request.params);
      return { notification: await notifications.markRead({ principal, id: params.id }) };
    } catch (error) {
      return sendNotificationError(reply, error);
    }
  });
}

function sendNotificationError(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) {
    reply.code(400);
    return { error: { code: "VALIDATION_ERROR", issues: error.issues } };
  }
  if (error instanceof AuthError || error instanceof NotificationError) {
    reply.code(error.statusCode);
    return { error: { code: error.code } };
  }
  reply.code(500);
  return { error: { code: "INTERNAL_ERROR" } };
}
