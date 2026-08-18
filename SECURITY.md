# Security

Security requirements:

- password hashing
- refresh token rotation
- RBAC and tenant isolation
- API key hashing at rest
- MIME and file size validation
- path traversal prevention
- rate limiting
- security headers
- audit logs for sensitive actions
- no raw secrets or OCR document contents in logs

Initial shared utilities include filename normalization and CSV formula injection protection.

Implemented auth foundation:

- scrypt password hashing with per-password random salt
- signed access and refresh tokens
- refresh token hash-at-rest
- refresh token rotation with old-token reuse rejection
- session inventory
- logout from one session and all sessions
- server-side permission guard example for admin health access
- audit log writes for register, login and logout-all actions
- API key hashing at rest with configurable pepper
- scoped API key creation, listing, revocation and automation authentication
- permission-protected audit log browser at `/admin/audit`
- tenant-scoped audit filters for action, resource type and actor user ID
- Helmet-backed baseline HTTP security headers on API responses
- configurable CORS allow-listing through `CORS_ALLOWED_ORIGINS`
- configurable API request rate limiting through `RATE_LIMIT_MAX` and `RATE_LIMIT_TIME_WINDOW`
- Redis-backed distributed API request budgets when `REDIS_URL` is configured and memory adapters are disabled
- opt-in live Redis rate-limit verification proving real `spendlens-rate-limit-` keys enforce configured budgets with TTL-backed counters and 429 responses
- automated repository secret scanning through `pnpm security:secrets`
- static API route authorization auditing through `pnpm security:routes`

HTTP security configuration:

- `CORS_ALLOWED_ORIGINS` is a comma-separated list of explicit frontend origins. Local development origins on `localhost` and `127.0.0.1` are also accepted to support non-public local ports.
- Requests without an `Origin` header are allowed for server-to-server, health-check and CLI use.
- Untrusted browser origins do not receive `Access-Control-Allow-Origin`.
- Rate limiting is process-local when Redis is not configured. With `REDIS_URL`, the API uses a Redis-backed `spendlens-rate-limit-` namespace and skips limiter failures so local core flows do not fail solely because Redis is temporarily degraded.

CSRF stance:

- The current browser authentication flow stores the access token client-side and sends it explicitly as a bearer token. The API does not accept ambient browser cookies for authenticated mutations, so classic cookie-session CSRF token middleware is intentionally not required for the current auth surface.
- If cookie-authenticated browser sessions are introduced later, unsafe methods must require SameSite `Lax` or `Strict`, `Secure` and `HttpOnly` cookies, a per-session synchronizer token or double-submit token, Origin/Referer checks, and API or Playwright regression tests proving cross-origin form/script submissions fail.

Threat model summary:

- SpendLens AI is local-first and must not require public internet exposure for core functionality.
- Core OCR/AI flows use local open-source services and synthetic/demo data only; no paid OCR, AI or SaaS dependency is required.
- Server-side controls include authentication, refresh-token rotation, RBAC, tenant isolation, API-key hashing, permission guards, audit records for sensitive actions, file validation, safe object-key handling, CORS allow-listing, security headers, route authorization audit, secret scanning and Redis-backed rate limiting.
- Logs and audit metadata must avoid raw secrets, API keys, password material and OCR document contents.
- Remaining project-level security work includes broader P19 audit closure, continued permission-aware UI hardening in product flows, destructive deletion/anonymization drills and final security audit before any release candidate.

Security audit commands:

- `pnpm security:secrets` scans source/config/documentation files for common committed-secret patterns and hardcoded production-style secret assignments.
- `pnpm security:routes` checks every registered Fastify API route and fails unless it is explicitly public, authenticated-only by design or protected by a permission guard.
- `pnpm security:audit` runs both checks together.
