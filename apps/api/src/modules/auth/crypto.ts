import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
const PASSWORD_KEY_BYTES = 64;
const SCRYPT_PARAMS = { N: 16_384, r: 8, p: 1 } as const;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("base64url");
  const derived = scryptSync(password, salt, PASSWORD_KEY_BYTES, SCRYPT_PARAMS);
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  const [algorithm, n, r, p, salt, expectedHash] = encodedHash.split("$");
  if (algorithm !== "scrypt" || !n || !r || !p || !salt || !expectedHash) {
    return false;
  }

  const derived = scryptSync(password, salt, PASSWORD_KEY_BYTES, {
    N: Number(n),
    r: Number(r),
    p: Number(p)
  });
  const expected = Buffer.from(expectedHash, "base64url");
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

export function hashOpaqueToken(token: string): string {
  return createHmac("sha256", "spendlens-token-hash-v1").update(token).digest("base64url");
}

export function createSignedToken<TPayload extends Record<string, unknown>>(
  payload: TPayload,
  secret: string,
  expiresInSeconds: number
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const body = { ...payload, iat: now, exp: now + expiresInSeconds };
  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(body)}`;
  const signature = createHmac("sha256", secret).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

export function verifySignedToken<TPayload extends Record<string, unknown>>(token: string, secret: string): TPayload {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) {
    throw new Error("Malformed token");
  }

  const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new Error("Invalid token signature");
  }

  const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TPayload & { exp?: number };
  if (typeof parsed.exp !== "number" || parsed.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("Token expired");
  }
  return parsed;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
