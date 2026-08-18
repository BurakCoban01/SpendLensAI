import type { FastifyCorsOptions } from "@fastify/cors";

export function parseAllowedOrigins(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  );
}

export function isCorsOriginAllowed(origin: string | undefined, allowedOrigins: Set<string>): boolean {
  if (!origin) {
    return true;
  }
  if (allowedOrigins.has(origin)) {
    return true;
  }
  return /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
}

export function buildCorsOptions(allowedOriginValue: string): FastifyCorsOptions {
  const allowedOrigins = parseAllowedOrigins(allowedOriginValue);
  return {
    credentials: true,
    origin: (origin, callback) => {
      callback(null, isCorsOriginAllowed(origin, allowedOrigins));
    }
  };
}
