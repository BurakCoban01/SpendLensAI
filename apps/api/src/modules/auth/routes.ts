import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PermissionCode } from "@spendlens/shared";
import { AuthError, AuthService } from "./service";
import type { AuthPrincipal } from "./types";

const RegisterSchema = z.object({
  tenantName: z.string().trim().min(2).max(120),
  tenantSlug: z.string().trim().min(2).max(80),
  workspaceName: z.string().trim().min(2).max(120).default("Main Workspace"),
  email: z.string().email(),
  displayName: z.string().trim().min(2).max(120),
  password: z.string().min(12).max(256)
});

const LoginSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(80),
  email: z.string().email(),
  password: z.string().min(1).max(256)
});

const RefreshSchema = z.object({
  refreshToken: z.string().min(20)
});

const SessionListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

export async function registerAuthRoutes(app: FastifyInstance, auth: AuthService): Promise<void> {
  app.post("/auth/register", async (request, reply) => {
    try {
      const body = RegisterSchema.parse(request.body);
      const result = await auth.register({
        ...body,
        userAgent: request.headers["user-agent"] ?? null,
        ipHash: hashIp(request.ip),
        correlationId: correlationId(request)
      });
      reply.code(201);
      return publicAuthResponse(result);
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.post("/auth/login", async (request, reply) => {
    try {
      const body = LoginSchema.parse(request.body);
      const result = await auth.login({
        ...body,
        userAgent: request.headers["user-agent"] ?? null,
        ipHash: hashIp(request.ip),
        correlationId: correlationId(request)
      });
      return publicAuthResponse(result);
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.post("/auth/refresh", async (request, reply) => {
    try {
      const body = RefreshSchema.parse(request.body);
      return { tokens: await auth.refresh(body.refreshToken, { correlationId: correlationId(request) }) };
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.post("/auth/logout", async (request, reply) => {
    try {
      const body = RefreshSchema.parse(request.body);
      await auth.logout(body.refreshToken, { correlationId: correlationId(request) });
      reply.code(204);
      return null;
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.get("/auth/me", async (request, reply) => {
    try {
      return { principal: await authenticateRequest(auth, request) };
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.get("/auth/sessions", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      const query = SessionListQuerySchema.parse(request.query);
      return await auth.listSessions(principal, {
        page: query.page,
        limit: query.limit,
        correlationId: correlationId(request)
      });
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.post("/auth/logout-all", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      await auth.logoutAll(principal, { correlationId: correlationId(request) });
      reply.code(204);
      return null;
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.get("/admin/auth-check", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "admin.health.read");
      return { ok: true, principal };
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });
}

export async function authenticateRequest(auth: AuthService, request: FastifyRequest): Promise<AuthPrincipal> {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new AuthError("MISSING_BEARER_TOKEN", 401);
  }
  return auth.authenticateAccessToken(header.slice("Bearer ".length));
}

export function requirePermission(auth: AuthService, principal: AuthPrincipal, permission: PermissionCode): void {
  auth.requirePermission(principal, permission);
}

function publicAuthResponse(result: {
  tenant: { id: string; name: string; slug: string };
  user: { id: string; email: string; displayName: string };
  roles: string[];
  permissions: string[];
  tokens: unknown;
}) {
  return {
    tenant: result.tenant,
    user: {
      id: result.user.id,
      email: result.user.email,
      displayName: result.user.displayName
    },
    roles: result.roles,
    permissions: result.permissions,
    tokens: result.tokens
  };
}

function sendAuthError(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) {
    reply.code(400);
    return { error: { code: "VALIDATION_ERROR", issues: error.issues } };
  }
  if (error instanceof AuthError) {
    reply.code(error.statusCode);
    return { error: { code: error.code } };
  }
  if (error instanceof Error && error.message === "TENANT_SLUG_TAKEN") {
    reply.code(409);
    return { error: { code: "TENANT_SLUG_TAKEN" } };
  }
  if (isDatabaseNotReadyError(error)) {
    reply.code(503);
    return { error: { code: "DATABASE_NOT_READY" } };
  }
  reply.code(500);
  return { error: { code: "INTERNAL_ERROR" } };
}

function isDatabaseNotReadyError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientInitializationError) return true;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return ["P1001", "P1003", "P2021", "P2022"].includes(error.code);
  }
  if (!(error instanceof Error)) return false;
  return /database .* does not exist|table .* does not exist|schema .* does not exist/i.test(error.message);
}

function hashIp(ip: string): string {
  return createHash("sha256").update(ip).digest("base64url");
}

function correlationId(request: FastifyRequest): string | null {
  const value = request.headers["x-correlation-id"];
  return typeof value === "string" ? value : null;
}
