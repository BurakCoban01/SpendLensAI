import { expect, test } from "@playwright/test";

const expiredSessionPayload = {
  tokens: { accessToken: "expired-token", refreshToken: "expired-refresh" },
  tenant: { id: "tenant", name: "Expired Tenant", slug: "expired" },
  user: { id: "user", email: "expired@example.com", displayName: "Expired User" }
};

test("shows sign-in actions when the dashboard session is expired", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "spendlens.auth",
      JSON.stringify({
        tokens: { accessToken: "expired-token", refreshToken: "expired-refresh" },
        tenant: { id: "tenant", name: "Expired Tenant", slug: "expired" },
        user: { id: "user", email: "expired@example.com", displayName: "Expired User" }
      })
    );
  });
  await page.goto("/dashboard?lang=tr");
  await expect(page.getByRole("heading", { name: "Oturum hatası" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Giriş yap" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Kayıt ol" })).toBeVisible();
});

test("registers a tenant and exercises permission-aware dashboard and expense AI actions", async ({ page }) => {
  test.setTimeout(420_000);

  const suffix = Date.now().toString(36);
  const tenantName = `E2E Tenant ${suffix}`;
  const tenantSlug = `e2e-${suffix}`;

  await page.goto("/register?lang=tr");
  await page.getByLabel(/Çalışma alanı adı|Workspace name|Tenant adı/).fill(tenantName);
  await page.getByLabel(/Çalışma alanı kısa adı|Workspace slug|Tenant kısa adı/).fill(tenantSlug);
  await page.getByLabel("Çalışma alanı", { exact: true }).fill("Finance");
  await page.getByLabel(/Görünen ad|Display name/).fill("E2E Owner");
  await page.getByLabel(/E-posta|Email/).fill(`owner-${suffix}@example.com`);
  await page.getByLabel(/Parola|Password/).fill("very-secure-password");
  await page.getByRole("button", { name: /Çalışma alanı oluştur|Create workspace/ }).click();

  await expect(page).toHaveURL(/\/dashboard(\?.*)?$/);
  await expect(page.getByRole("heading", { name: tenantName })).toBeVisible();
  await expect(page.getByText("Belge yükleme", { exact: true })).toBeVisible();
  await expect(page.getByText("Yetkili").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Belge yüklemeyi aç" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "API anahtarları" })).toBeVisible();

  await page.getByPlaceholder("Anahtar adı").fill(`E2E key ${suffix}`);
  await page.locator('input[name="documents.upload"]').check();
  await page.getByRole("button", { name: "API anahtarı oluştur" }).click();

  await expect(page.getByText("Ham anahtar")).toBeVisible();
  await expect(page.getByText("documents.read, documents.upload")).toBeVisible();

  await Promise.all([
    page.waitForURL(/\/documents\/upload(\?.*)?$/, { timeout: 30_000 }),
    page.getByRole("link", { name: "Belge yüklemeyi aç" }).click()
  ]);
  await expect(page.getByRole("heading", { name: /Document intake and upload|Belge kabul ve yükleme/ })).toBeVisible({ timeout: 30_000 });
  await page.locator('input[type="file"]').setInputFiles({
    name: "receipt.jpg",
    mimeType: "image/jpg",
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9])
  });
  await page.getByRole("button", { name: /Upload document|Belgeyi yükle/ }).click();
  await expect(page.getByText(/(Uploaded|Yüklendi) - receipt\.jpg/)).toBeVisible();
  await Promise.all([
    page.waitForURL(/\/documents\/ocr\?.*documentId=/, { timeout: 30_000 }),
    page.getByRole("link", { name: /OCR incele|Review OCR/ }).click()
  ]);
  await expect(page.getByRole("heading", { name: "OCR çalışma alanı" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Sıradaki adım" })).toBeVisible();
  await expect(page.getByText("Bu belge için henüz kaydedilmiş OCR sonucu yok")).toBeVisible();
  await expect(page.getByText(/Gelişmiş \/ hata ayıklama elle OCR karşılaştırması|Advanced/)).toBeVisible();
  await page.getByText(/Gelişmiş \/ hata ayıklama elle OCR karşılaştırması|Advanced/).click();
  await page.getByRole("button", { name: /Elle karşılaştırmayı kaydet|Manuel karşılaştırmayı kaydet|Save manual comparison/ }).click();
  await expect(page.getByText("TESSERACT", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Seçilen motor|Selected engine/).first()).toBeVisible();
  await expect(page.getByText("Güven", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Benzerlik", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("CER", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "OCR alan kararları" })).toBeVisible();
  await expect(page.getByText("Çakışan alanlar: total")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Ham OCR metni" })).toBeVisible();
  await page.getByRole("button", { name: /Create extraction|Çıkarım oluştur|Extraction oluştur/ }).click();
  await expect(page.getByRole("heading", { name: /Extraction result|Çıkarım sonucu|Extraction sonucu/ })).toBeVisible();
  await expect(page.getByText(/No validation warnings|Doğrulama uyarısı yok|Validation uyarısı yok/)).toBeVisible();
  await page.getByRole("button", { name: /Create expense|Gider oluştur/ }).click();
  await expect(page.getByText("Gider oluşturuldu: MAVI MARKET")).toBeVisible();
  await expect(page.getByRole("heading", { name: "OCR geçmişi" })).toBeVisible();
  await expect(page.getByText("CUSTOM_CRNN", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("ENSEMBLE", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("SUCCEEDED", { exact: true }).first()).toBeVisible();
  await page.goto("/review?lang=en");
  await expect(page.getByRole("heading", { name: /Review|İnceleme/, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Document workspace|Belge çalışma alanı/ })).toBeVisible();
  await expect(page.getByText("RECEIPT - image/jpeg - receipt.jpg")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open document" })).toBeVisible();
  await page
    .getByLabel("OCR text for extraction")
    .fill(["MAVI MARKET", "FIS NO: TR-12345", "TARIH: 12.05.2026 SAAT 14:35", "EKMEK 20,00 TL", "SUT 45,50 TL", "KDV 6,55 TL", "TOPLAM 72,05 TL"].join("\n"));
  await page.getByRole("button", { name: "Run extraction" }).click();
  await expect(page.getByText("72,05 TRY")).toBeVisible();
  await expect(page.getByText("No validation issues.")).toBeVisible();
  await page.getByLabel("Reviewed merchant").fill("MAVI GIDA");
  await page.getByLabel("Reviewed receipt number").fill("TR-12345-APPROVED");
  await page.getByLabel("Extraction review status").selectOption("APPROVED");
  const fieldReviewResponse = page.waitForResponse((response) => response.url().includes("/extraction/fields"));
  await page.getByRole("button", { name: "Save field review" }).click();
  expect((await fieldReviewResponse).status()).toBe(200);
  await expect(page.getByTestId("extraction-review-state")).toHaveText(/APPROVED|Approved|Onaylandı/);
  await expect(page.getByText("MAVI GIDA").first()).toBeVisible();
  await expect(page.getByText("TR-12345-APPROVED").first()).toBeVisible();
  await page.getByLabel("Review reasons").fill("LOW_CONFIDENCE, TOTAL_CONFLICT");
  await page.getByRole("button", { name: "Create review task" }).click();
  await expect(page.getByText("LOW_CONFIDENCE, TOTAL_CONFLICT")).toBeVisible();
  await page.getByLabel(/Field|Alan/).fill("total");
  await page.getByLabel(/Before|Previous value|Önceki değer/).fill("95,00");
  await page.getByLabel(/After|New value|Yeni değer/).fill("100,00");
  await page.getByLabel("Annotation label").fill("receipt_total");
  await page.getByRole("button", { name: "Save correction" }).click();
  await expect(page.getByText("total = 100,00")).toBeVisible();
  await expect(page.getByText("95,00 -> 100,00")).toBeVisible();
  await expect(page.getByText(/Training sample created|Eğitim örneği oluşturuldu/)).toBeVisible();
  await expect(page.getByText(/Included in training dataset exports|Eğitim veri kümesine dahil edilir/)).toBeVisible();
  await expect(page.getByText("HUMAN_CORRECTION", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Dashboard" }).click();
  await page.locator('a[href^="/expenses"]').first().click();
  await expect(page.getByRole("heading", { name: /Expenses|Giderler/, exact: true })).toBeVisible();
  await page.getByPlaceholder(/Receipt required above (threshold|limit)/).fill("Business project required");
  await page.locator('select[name="ruleType"]').selectOption("PROJECT_REQUIRED");
  await page.locator('select[name="severity"]').selectOption("warning");
  await page.getByRole("button", { name: "Save rule" }).click();
  await expect(page.getByText(/Expense policy saved|The expense policy was saved|Gider politikası kaydedildi/)).toBeVisible();

  await page.getByLabel("Title").fill("Shell motorin weekend");
  await page.getByLabel(/Amount|Tutar/).fill("5000,00");
  await page.getByLabel(/Date|Tarih/).fill("2026-05-16T10:00");
  await page.getByLabel(/Merchant|Satıcı/).fill("Shell");
  await page.getByLabel(/Payment method|Ödeme/).fill("Corporate card");
  await page.getByLabel(/Business|Kurumsal/).check();
  await page.getByRole("button", { name: "Create expense" }).click();

  await expect(page.getByText("Expense created.")).toBeVisible();
  await expect(page.getByText("Shell motorin weekend")).toBeVisible();
  await page.goto("/approvals");
  await expect(page.getByRole("heading", { name: "Pending" })).toBeVisible();
  await expect(page.getByText("ON TRACK").first()).toBeVisible();
  await expect(page.getByText(/Due /).first()).toBeVisible();
  await page.locator('a[href^="/expenses"]').first().click();
  const shellExpense = page.getByRole("region", { name: /Expense Shell motorin weekend|Gider Shell motorin weekend/ });
  await shellExpense.locator('select[name="documentFileId"]').selectOption({ label: "receipt.jpg" });
  await shellExpense.getByRole("button", { name: /Attach|Ekle/ }).click();
  await expect(page.getByText(/Attached receipt\.jpg|receipt\.jpg attached|receipt\.jpg eklendi|The document was attached/).first()).toBeVisible();
  await shellExpense.getByRole("button", { name: "Policy" }).click();
  await expect(page.locator("span").filter({ hasText: /^PROJECT REQUIRED$/ }).last()).toBeVisible();
  await shellExpense.getByRole("button", { name: "Edit" }).click();
  await shellExpense.locator('input[name="amount"]').fill("5100,00");
  await shellExpense.locator('input[name="projectCode"]').fill("OPS");
  await shellExpense.getByRole("button", { name: /Save|Kaydet/ }).click();

  await expect(page.getByText("Project OPS")).toBeVisible();
  await expect(page.getByText("5100,00 TRY").first()).toBeVisible();
  await page.getByLabel("Title").fill("Shell motorin prior");
  await page.getByLabel(/Amount|Tutar/).fill("5100,00");
  await page.getByLabel(/Date|Tarih/).fill("2026-04-16T10:00");
  await page.getByLabel(/Merchant|Satıcı/).fill("Shell");
  await page.getByRole("button", { name: "Create expense" }).click();

  await expect(page.getByText("Shell motorin prior")).toBeVisible();
  await page.getByRole("button", { name: /Detect subscriptions|Abonelikleri tespit et/ }).click();
  await expect(page.getByText(/1 subscription candidates saved\.|1 abonelik adayi kaydedildi\.|1 abonelik adayı kaydedildi\./)).toBeVisible();
  await expect(page.getByText("monthly - 5100,00 TRY")).toBeVisible();
  await shellExpense.getByRole("button", { name: "Recurring" }).click();
  await expect(
    page.getByText(/The monthly recurring expense rule was saved\.|Monthly recurring rule saved\.|Aylık yinelenen gider kuralı kaydedildi\./)
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Generate next|Sonrakini olustur|Sonrakini oluştur/ })).toBeVisible();
  await shellExpense.getByRole("button", { name: "Analyze" }).click();

  await expect(page.getByText(/Fuel|Akaryakıt/)).toBeVisible();
  await expect(page.getByText(/Source: Local rule-based model|Kaynak: Kural tabanlı yerel model/)).toBeVisible();
  await expect(page.getByText(/No external service|Dış servis yok/)).toBeVisible();
  await expect(page.getByText(/Saved prediction|Kaydedilen tahmin/)).toBeVisible();
  await expect(page.getByText(/WEEKEND BUSINESS EXPENSE|HAFTA SONU IS GIDERI|HAFTA SONU İŞ GİDERİ/)).toBeVisible();
  await expect(page.getByText(/Categorized with AI|AI categorized|AI ile kategorilendi|Yapay zeka kategorilendirdi/)).toBeVisible();
  await shellExpense.getByPlaceholder("Add review note").fill("Receipt checked before archive.");
  await shellExpense.getByRole("button", { name: /Comment|Yorum ekle/ }).click();
  await expect(page.getByText("Receipt checked before archive.")).toBeVisible();
  await expect(page.getByText(/1 comments|1 yorum/).first()).toBeVisible();
  await shellExpense.getByRole("button", { name: "Archive" }).click();
  await page.getByRole("region", { name: /Expense Shell motorin prior|Gider Shell motorin prior/ }).getByRole("button", { name: "Archive" }).click();
  await page.getByLabel("Title").fill("Split parking");
  await page.getByLabel(/Amount|Tutar/).fill("100,00");
  await page.getByLabel(/Date|Tarih/).fill("2026-05-18T09:00");
  await page.getByRole("button", { name: "Create expense" }).click();

  await expect(page.getByText("Split parking")).toBeVisible();
  await page.getByRole("region", { name: /Expense Split parking|Gider Split parking/ }).getByRole("button", { name: "Split" }).click();
  await expect(page.getByText("Split parking - A")).toBeVisible();
  await expect(page.getByText("Split parking - B")).toBeVisible();
  await page.getByLabel("CSV source").fill("playwright-import.csv");
  await page
    .getByLabel("CSV content")
    .fill('title,merchant,amount,occurred_at,currency,reimbursable\nCSV metro,Istanbul Metro,"42,50",2026-05-17T08:00:00.000Z,TRY,true');
  await page.getByRole("button", { name: "Import CSV" }).click();
  await expect(page.getByText("1 imported, 0 failed.")).toBeVisible();
  const csvMetroReimbursementOption = page.locator("label").filter({ hasText: "CSV metro" });
  await expect(csvMetroReimbursementOption).toBeVisible();
  await csvMetroReimbursementOption.locator('input[type="checkbox"]').check();
  await page.getByRole("button", { name: /1 send claims|1 talep gonder|1 talep gönder|Submit 1/ }).click();
  await expect(page.getByText(/The reimbursement claim was submitted\.|Reimbursement claim submitted\.|Geri odeme talebi gonderildi\.|Geri ödeme talebi gönderildi\./)).toBeVisible();
  await expect(page.getByText(/42,50 TRY - NEEDS REVIEW|42,50 TRY - Needs review|42,50 TRY - Incelemede|42,50 TRY - İncelemede/)).toBeVisible();
  await page.getByRole("button", { name: /Approve|Onayla/ }).click();
  await expect(page.getByText(/Claim approved\.|Talep onaylandi\.|Talep onaylandı\./)).toBeVisible();
  await page.getByRole("button", { name: /Mark paid|Odendi isaretle|Ödendi işaretle/ }).click();
  await expect(page.getByText(/Claim marked paid\.|Talep odendi olarak isaretlendi\.|Talep ödendi olarak işaretlendi\./)).toBeVisible();
  await expect(page.getByText(/42,50 TRY - REIMBURSED|42,50 TRY - Reimbursed|42,50 TRY - Geri odendi|42,50 TRY - Geri ödendi/)).toBeVisible();

  await page.goto("/reports?lang=en");
  await expect(page.getByRole("heading", { name: /Reports|Raporlar/ })).toBeVisible();
  await page.getByLabel(/Report type|Export type|Rapor turu|Rapor türü|Disa aktarma turu|Dışa aktarma türü/).selectOption("monthly_expense_report_pdf");
  await page.getByRole("button", { name: /Generate export|Generate|Disa aktarim uret|Dışa aktarım üret/ }).click();
  await expect(page.getByText("application/pdf")).toBeVisible();
  await page.getByLabel(/Report type|Export type|Rapor turu|Rapor türü|Disa aktarma turu|Dışa aktarma türü/).selectOption("reimbursement_batch_csv");
  await page.getByRole("button", { name: /Generate export|Generate|Disa aktarim uret|Dışa aktarım üret/ }).click();
  await expect(page.getByText("text/csv")).toBeVisible();
  await page.getByLabel(/Report type|Export type|Rapor turu|Rapor türü|Disa aktarma turu|Dışa aktarma türü/).selectOption("reimbursement_claim_report_pdf");
  await page.getByRole("button", { name: /Generate export|Generate|Disa aktarim uret|Dışa aktarım üret/ }).click();
  await expect(page.getByText("reimbursement_claim_report_pdf")).toBeVisible();
  await page.getByLabel(/Report type|Export type|Rapor turu|Rapor türü|Disa aktarma turu|Dışa aktarma türü/).selectOption("ocr_quality_report_csv");
  await page.getByRole("button", { name: /Generate export|Generate|Disa aktarim uret|Dışa aktarım üret/ }).click();
  await expect(page.getByText("ocr_quality_report_csv")).toBeVisible();
  await page.getByLabel(/Report type|Export type|Rapor turu|Rapor türü|Disa aktarma turu|Dışa aktarma türü/).selectOption("model_evaluation_report_csv");
  await page.getByRole("button", { name: /Generate export|Generate|Disa aktarim uret|Dışa aktarım üret/ }).click();
  await expect(page.getByText("model_evaluation_report_csv")).toBeVisible();
  await page.getByLabel(/Report type|Export type|Rapor turu|Rapor türü|Disa aktarma turu|Dışa aktarma türü/).selectOption("audit_pack_csv");
  await page.getByRole("button", { name: /Generate export|Generate|Disa aktarim uret|Dışa aktarım üret/ }).click();
  await expect(page.getByText("audit_pack_csv")).toBeVisible();
  await page.getByLabel(/Report type|Export type|Rapor turu|Rapor türü|Disa aktarma turu|Dışa aktarma türü/).selectOption("dataset_export_jsonl");
  await page.getByRole("button", { name: /Generate export|Generate|Disa aktarim uret|Dışa aktarım üret/ }).click();
  await expect(page.getByText("dataset_export_jsonl")).toBeVisible();

  await page.goto("/models?lang=en");
  await expect(page.getByRole("heading", { name: /Models|Modeller/ })).toBeVisible();
  await expect(page.getByText(/TensorFlow|Keras/)).toHaveCount(0);
  const categoryTrainingForm = page.locator("form").filter({ has: page.getByRole("button", { name: "Start category training" }) }).first();
  await categoryTrainingForm.getByLabel("Category seed").fill("77");
  await categoryTrainingForm.getByLabel("Samples per category").fill("4");
  await categoryTrainingForm.getByRole("button", { name: "Start category training" }).click();

  await expect(page.getByText("category-ml-v1-seed-77").first()).toBeVisible({ timeout: 90000 });
  await expect(page.getByText(/CANDIDATE|Candidate|Aday/).first()).toBeVisible();
  await expect(page.getByText(/SUCCEEDED|Succeeded|Tamamlandı/).first()).toBeVisible();
  await page.getByRole("button", { name: /category-ml-v1-seed-77 sürümünü yükselt|Promote category-ml-v1-seed-77/ }).click();
  await expect(page.locator("div").filter({ hasText: "category-ml-v1-seed-77" }).filter({ hasText: /ACTIVE|Active|Aktif/ }).first()).toBeVisible();

  await categoryTrainingForm.getByLabel("Category seed").fill("78");
  await categoryTrainingForm.getByLabel("Samples per category").fill("4");
  await categoryTrainingForm.getByRole("button", { name: "Start category training" }).click();
  await expect(page.getByText("category-ml-v1-seed-78").first()).toBeVisible({ timeout: 90000 });
  await page.getByRole("button", { name: /category-ml-v1-seed-78 sürümünü yükselt|Promote category-ml-v1-seed-78/ }).click();
  await expect(page.getByRole("button", { name: /category-ml-v1-seed-77 sürümünü geri al|Rollback category-ml-v1-seed-77/ })).toBeVisible();
  await page.getByRole("button", { name: /category-ml-v1-seed-77 sürümünü geri al|Rollback category-ml-v1-seed-77/ }).click();
  await expect(page.locator("div").filter({ hasText: "category-ml-v1-seed-77" }).filter({ hasText: /ACTIVE|Active|Aktif/ }).first()).toBeVisible();

  const customOcrTrainingForm = page.locator("form").filter({ has: page.getByRole("button", { name: /Start custom OCR training|Start Custom OCR training/ }) }).first();
  await customOcrTrainingForm.getByLabel("OCR seed").fill("88");
  await customOcrTrainingForm.getByLabel(/Samples|Sample count|Örnek sayısı/).fill("8");
  await customOcrTrainingForm.getByLabel(/Epochs|Epoch count|Epok sayısı/).fill("1");
  await customOcrTrainingForm.getByRole("button", { name: /Start custom OCR training|Start Custom OCR training/ }).click();
  await expect(page.getByText("custom-crnn-smoke-seed-88").first()).toBeVisible({ timeout: 120000 });
  const benchmarkRow = page.getByTestId("ocr-benchmark-row-custom-crnn-smoke-seed-88");
  await expect(benchmarkRow.getByRole("button", { name: /custom-crnn-smoke-seed-88 için kıyaslamayı çalıştır|Run benchmark for custom-crnn-smoke-seed-88/ })).toBeVisible();
  await benchmarkRow.getByRole("button", { name: /custom-crnn-smoke-seed-88 için kıyaslamayı çalıştır|Run benchmark for custom-crnn-smoke-seed-88/ }).click();
  await expect(benchmarkRow).toContainText("3", { timeout: 90000 });
  await expect(benchmarkRow).toContainText(/ok|unavailable|skipped/i);
  await expect(benchmarkRow).toContainText(/ms|n\/a/i);
  await expect(page.getByText("artifacts/benchmarks/ocr-api").first()).toBeVisible();
});

for (const route of [
  "/documents/upload?lang=tr",
  "/documents/ocr?lang=tr",
  "/review?lang=tr",
  "/expenses?lang=tr",
  "/approvals?lang=tr",
  "/budgets?lang=tr",
  "/reports?lang=tr",
  "/models?lang=tr",
  "/settings?lang=tr",
  "/admin/health?lang=tr",
  "/admin/jobs?lang=tr",
  "/admin/events?lang=tr",
  "/admin/cache?lang=tr",
  "/admin/audit?lang=tr"
]) {
  test(`shows direct sign-in actions for expired session on ${route}`, async ({ page }) => {
    await page.addInitScript((session) => {
      window.localStorage.setItem("spendlens.auth", JSON.stringify(session));
    }, expiredSessionPayload);
    await page.goto(route);
    await expect(page.getByRole("link", { name: /Giriş yap/ })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("link", { name: /Kayıt ol/ })).toBeVisible();
  });
}
