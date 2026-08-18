import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { authenticateRequest } from "../auth/routes";
import { AuthError, AuthService } from "../auth/service";
import type { AuthRepository } from "../auth/types";

export async function registerWorkspaceRoutes(
  app: FastifyInstance,
  auth: AuthService,
  repository: AuthRepository
): Promise<void> {
  app.get("/workspaces", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      return { workspaces: await repository.listWorkspaces(principal.tenantId) };
    } catch (error) {
      return sendWorkspaceError(reply, error);
    }
  });
}

function sendWorkspaceError(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) {
    reply.code(400);
    return { error: { code: "VALIDATION_ERROR", issues: error.issues } };
  }
  if (error instanceof AuthError) {
    reply.code(error.statusCode);
    return { error: { code: error.code } };
  }
  reply.code(500);
  return { error: { code: "INTERNAL_ERROR" } };
}
