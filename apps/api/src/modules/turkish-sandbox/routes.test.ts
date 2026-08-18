import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app";
import { createSignedToken, hashOpaqueToken } from "../auth/crypto";
import { InMemoryAuthRepository } from "../auth/memory-repository";
import { permissionsForRoles } from "../auth/service";

describe("Turkish sandbox parser routes", () => {
  let app: FastifyInstance;
  let authRepository: InMemoryAuthRepository;
  let accessToken: string;
  let tenantId: string;

  beforeAll(async () => {
    authRepository = new InMemoryAuthRepository();
    app = await buildApp({ authRepository });
    const register = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        tenantName: "Sandbox Tenant",
        tenantSlug: "sandbox-tenant",
        workspaceName: "Finance",
        email: "owner@example.com",
        displayName: "Owner",
        password: "very-secure-password"
      }
    });
    expect(register.statusCode).toBe(201);
    accessToken = register.json().tokens.accessToken;
    tenantId = register.json().tenant.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it("parses local UBL-TR sandbox XML through an authorized API route", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/sandbox/turkish/parse",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        kind: "UBL_TR_XML",
        content: `
          <Invoice xmlns:cbc="urn:cbc" xmlns:cac="urn:cac">
            <cbc:ProfileID>TEMELFATURA</cbc:ProfileID>
            <cbc:ID>SYN2026000000034</cbc:ID>
            <cbc:UUID>aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee</cbc:UUID>
            <cbc:IssueDate>2026-05-12</cbc:IssueDate>
            <cbc:DocumentCurrencyCode>TRY</cbc:DocumentCurrencyCode>
            <cac:AccountingSupplierParty>
              <cac:Party><cac:PartyName><cbc:Name>Mavi Market A.S.</cbc:Name></cac:PartyName><cac:PartyTaxScheme><cbc:CompanyID>1234567890</cbc:CompanyID></cac:PartyTaxScheme></cac:Party>
            </cac:AccountingSupplierParty>
            <cac:TaxTotal><cbc:TaxAmount currencyID="TRY">18.00</cbc:TaxAmount></cac:TaxTotal>
            <cac:LegalMonetaryTotal>
              <cbc:LineExtensionAmount currencyID="TRY">100.00</cbc:LineExtensionAmount>
              <cbc:TaxInclusiveAmount currencyID="TRY">118.00</cbc:TaxInclusiveAmount>
              <cbc:PayableAmount currencyID="TRY">118.00</cbc:PayableAmount>
            </cac:LegalMonetaryTotal>
          </Invoice>
        `
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().parsed).toMatchObject({
      kind: "UBL_TR_XML",
      source: "LOCAL_SANDBOX",
      officialIntegration: false,
      documentNumber: "SYN2026000000034",
      issueDate: "2026-05-12",
      supplier: { name: "Mavi Market A.S.", taxId: "1234567890" },
      payableAmount: { amountMinor: "11800", currency: "TRY" },
      validationIssues: []
    });
  });

  it("parses QR payloads and returns JSON-safe minor-unit amounts", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/sandbox/turkish/parse",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        kind: "QR_PAYLOAD",
        content: "UNVAN: Demo Cafe; VKN: 1234567890; FISNO: RCPT-9; TARIH: 20260512; TOPLAM: 90,50; KDV: 8,23"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().parsed).toMatchObject({
      kind: "QR_PAYLOAD",
      documentType: "receipt_qr",
      documentNumber: "RCPT-9",
      issueDate: "2026-05-12",
      supplier: { name: "Demo Cafe", taxId: "1234567890" },
      total: { amountMinor: "9050", currency: "TRY" },
      taxTotal: { amountMinor: "823", currency: "TRY" },
      officialIntegration: false
    });
  });

  it("rejects unauthenticated and under-scoped parser requests", async () => {
    const unauthenticated = await app.inject({
      method: "POST",
      url: "/sandbox/turkish/parse",
      payload: { kind: "QR_PAYLOAD", content: "UNVAN: Demo; TOPLAM: 1,00" }
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json().error.code).toBe("MISSING_BEARER_TOKEN");

    const viewerToken = await createViewerToken();
    const forbidden = await app.inject({
      method: "POST",
      url: "/sandbox/turkish/parse",
      headers: { authorization: `Bearer ${viewerToken}` },
      payload: { kind: "QR_PAYLOAD", content: "UNVAN: Demo; TOPLAM: 1,00" }
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe("PERMISSION_DENIED");
  });

  async function createViewerToken(): Promise<string> {
    const user = authRepository.addUserWithRoles({
      tenantId,
      email: "viewer@example.com",
      displayName: "Viewer",
      roles: ["VIEWER"]
    });
    const sessionId = randomUUID();
    await authRepository.createSession({
      id: sessionId,
      tenantId,
      userId: user.id,
      refreshTokenHash: hashOpaqueToken("viewer-refresh-token"),
      userAgent: "vitest",
      ipHash: null,
      expiresAt: new Date(Date.now() + 3_600_000)
    });
    return createSignedToken(
      {
        typ: "access",
        sub: user.id,
        tenantId,
        sessionId,
        email: user.email,
        displayName: user.displayName,
        roles: ["VIEWER"],
        permissions: permissionsForRoles(["VIEWER"])
      },
      "development_access_secret_change_me",
      900
    );
  }
});
