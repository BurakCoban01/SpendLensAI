import { describe, expect, it } from "vitest";
import { parseTurkishSandboxDocument, parseTurkishReceiptQrPayload, parseUblTrSandboxInvoiceXml } from "./index";

describe("Turkish local sandbox document parsing", () => {
  it("parses UBL-TR style invoice XML into integer minor units without official integration claims", () => {
    const result = parseUblTrSandboxInvoiceXml(`
      <Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
        xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
        xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2">
        <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
        <cbc:ProfileID>TEMELFATURA</cbc:ProfileID>
        <cbc:ID>SYN2026000000012</cbc:ID>
        <cbc:UUID>11111111-2222-3333-4444-555555555555</cbc:UUID>
        <cbc:IssueDate>2026-05-12</cbc:IssueDate>
        <cbc:IssueTime>14:35:00</cbc:IssueTime>
        <cbc:DocumentCurrencyCode>TRY</cbc:DocumentCurrencyCode>
        <cac:AccountingSupplierParty>
          <cac:Party>
            <cac:PartyName><cbc:Name>Mavi Market A.S.</cbc:Name></cac:PartyName>
            <cac:PartyTaxScheme>
              <cbc:CompanyID>1234567890</cbc:CompanyID>
              <cac:TaxScheme><cbc:Name>VKN</cbc:Name></cac:TaxScheme>
            </cac:PartyTaxScheme>
          </cac:Party>
        </cac:AccountingSupplierParty>
        <cac:AccountingCustomerParty>
          <cac:Party>
            <cac:PartyName><cbc:Name>Demo Musteri Ltd.</cbc:Name></cac:PartyName>
            <cac:PartyTaxScheme><cbc:CompanyID>1098765432</cbc:CompanyID></cac:PartyTaxScheme>
          </cac:Party>
        </cac:AccountingCustomerParty>
        <cac:TaxTotal>
          <cbc:TaxAmount currencyID="TRY">18.00</cbc:TaxAmount>
        </cac:TaxTotal>
        <cac:LegalMonetaryTotal>
          <cbc:LineExtensionAmount currencyID="TRY">100.00</cbc:LineExtensionAmount>
          <cbc:TaxInclusiveAmount currencyID="TRY">118.00</cbc:TaxInclusiveAmount>
          <cbc:PayableAmount currencyID="TRY">118.00</cbc:PayableAmount>
        </cac:LegalMonetaryTotal>
        <cac:InvoiceLine>
          <cbc:ID>1</cbc:ID>
          <cbc:InvoicedQuantity unitCode="C62">2</cbc:InvoicedQuantity>
          <cbc:LineExtensionAmount currencyID="TRY">100.00</cbc:LineExtensionAmount>
          <cac:TaxTotal><cac:TaxSubtotal><cbc:TaxAmount currencyID="TRY">18.00</cbc:TaxAmount><cbc:Percent>18</cbc:Percent></cac:TaxSubtotal></cac:TaxTotal>
          <cac:Item><cbc:Name>Ofis sarf malzemesi</cbc:Name></cac:Item>
          <cac:Price><cbc:PriceAmount currencyID="TRY">50.00</cbc:PriceAmount></cac:Price>
        </cac:InvoiceLine>
      </Invoice>
    `);

    expect(result.kind).toBe("UBL_TR_XML");
    expect(result.source).toBe("LOCAL_SANDBOX");
    expect(result.officialIntegration).toBe(false);
    expect(result.documentNumber).toBe("SYN2026000000012");
    expect(result.issueDate).toBe("2026-05-12");
    expect(result.issueTime).toBe("14:35");
    expect(result.supplier).toMatchObject({ name: "Mavi Market A.S.", taxId: "1234567890" });
    expect(result.customer.name).toBe("Demo Musteri Ltd.");
    expect(result.subtotal?.amountMinor).toBe(10000n);
    expect(result.taxTotal?.amountMinor).toBe(1800n);
    expect(result.payableAmount?.amountMinor).toBe(11800n);
    expect(result.lineItems[0]).toMatchObject({
      id: "1",
      name: "Ofis sarf malzemesi",
      quantity: "2",
      unitCode: "C62",
      taxRate: "18"
    });
    expect(result.lineItems[0]?.unitPrice?.amountMinor).toBe(5000n);
    expect(result.validationIssues).toEqual([]);
  });

  it("parses Turkish receipt QR payloads from query-string and key-value formats", () => {
    const query = parseTurkishReceiptQrPayload(
      "https://sandbox.local/qr?unvan=Mavi%20Market&vkn=1234567890&fisNo=FIS-42&tarih=12052026&saat=14:35&toplam=118,00&kdv=18,00&paraBirimi=TRY&odeme=Kredi%20Karti&kartSon4=1234"
    );
    expect(query.documentType).toBe("receipt_qr");
    expect(query.supplier.name).toBe("Mavi Market");
    expect(query.supplier.taxId).toBe("1234567890");
    expect(query.documentNumber).toBe("FIS-42");
    expect(query.issueDate).toBe("2026-05-12");
    expect(query.total?.amountMinor).toBe(11800n);
    expect(query.taxTotal?.amountMinor).toBe(1800n);
    expect(query.paymentMethod).toBe("CARD");
    expect(query.cardLast4).toBe("1234");
    expect(query.officialIntegration).toBe(false);

    const keyValue = parseTurkishSandboxDocument({
      kind: "QR_PAYLOAD",
      content: "UNVAN: Demo Cafe; VKN: 1234567890; FISNO: RCPT-9; TARIH: 2026-05-12; TOPLAM: 90.50; KDV: 8.23"
    });
    expect(keyValue.supplier.name).toBe("Demo Cafe");
    expect(keyValue.documentNumber).toBe("RCPT-9");
    expect(keyValue.issueDate).toBe("2026-05-12");
    expect(keyValue.total?.amountMinor).toBe(9050n);
    expect(keyValue.taxTotal?.amountMinor).toBe(823n);
  });

  it("flags malformed sandbox inputs and reconciliation mismatches", () => {
    const mismatched = parseUblTrSandboxInvoiceXml(`
      <Invoice>
        <cbc:ID>SYN-BAD-1</cbc:ID>
        <cbc:IssueDate>2026-05-12</cbc:IssueDate>
        <cac:AccountingSupplierParty><cac:Party><cac:PartyName><cbc:Name>Bad Supplier</cbc:Name></cac:PartyName><cac:PartyTaxScheme><cbc:CompanyID>12</cbc:CompanyID></cac:PartyTaxScheme></cac:Party></cac:AccountingSupplierParty>
        <cac:TaxTotal><cbc:TaxAmount currencyID="TRY">18.00</cbc:TaxAmount></cac:TaxTotal>
        <cac:LegalMonetaryTotal>
          <cbc:LineExtensionAmount currencyID="TRY">100.00</cbc:LineExtensionAmount>
          <cbc:PayableAmount currencyID="TRY">100.00</cbc:PayableAmount>
        </cac:LegalMonetaryTotal>
      </Invoice>
    `);

    expect(mismatched.validationIssues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["INVALID_TAX_ID", "TOTAL_TAX_MISMATCH"])
    );

    const malformedQr = parseTurkishReceiptQrPayload("not a key value payload");
    expect(malformedQr.validationIssues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["MALFORMED_DOCUMENT", "MISSING_TOTAL", "MISSING_MERCHANT"])
    );
  });
});
