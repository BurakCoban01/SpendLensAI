"use client";

import { BadgeCheck, ChevronRight, FileCheck2, ScanLine, WalletCards } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useLocale } from "../lib/locale";

const copy = {
  tr: {
    signIn: "Giriş yap",
    register: "Hesap oluştur",
    headline: "SpendLens AI",
    subtitle: "Fiş ve faturaları gider kayıtlarına dönüştürün.",
    detail: "Belgelerinizi yerel ve özel ortamınızda okuyun, çıkarılan alanları kontrol edin ve onay, bütçe ile raporlama akışlarını tek yerden yönetin.",
    trust: ["Belgeler cihazınızdan dışarı çıkmaz", "Tesseract ve Custom OCR seçenekleri", "Düşük güvenli alanlarda insan kontrolü"],
    flowTitle: "Belgeden güvenilir gider kaydına",
    flowDetail: "Her adım kaydedilir; sonuç belirsizse otomatik kabul yerine incelemeye yönlendirilir.",
    steps: [
      ["Belgeyi yükleyin", "Fiş, fatura veya ödeme belgesini seçin; dosya türü ve bütünlüğü yükleme sırasında doğrulanır."],
      ["Metni ve alanları kontrol edin", "OCR sonucu, satırlar, toplam, tarih ve satıcı bilgileri güven değerleriyle birlikte gösterilir."],
      ["Gider akışını tamamlayın", "Doğrulanan kayıtları onay, bütçe, geri ödeme ve raporlama süreçlerinde kullanın."]
    ]
  },
  en: {
    signIn: "Sign in",
    register: "Create account",
    headline: "SpendLens AI",
    subtitle: "Turn receipts and invoices into expense records.",
    detail: "Read documents in your private local environment, verify extracted fields, and manage approval, budget, and reporting workflows in one place.",
    trust: ["Documents stay on your device", "Tesseract and Custom OCR options", "Human review for low-confidence fields"],
    flowTitle: "From document to trustworthy expense record",
    flowDetail: "Every step is persisted; uncertain results are sent to review instead of being accepted automatically.",
    steps: [
      ["Upload the document", "Choose a receipt, invoice, or payment document; file type and integrity are verified during upload."],
      ["Verify text and fields", "OCR text, line items, total, date, and merchant are shown with their confidence values."],
      ["Complete the expense flow", "Use verified records in approval, budget, reimbursement, and reporting workflows."]
    ]
  }
} as const;

const stepIcons = [ScanLine, FileCheck2, WalletCards] as const;

export default function HomePage() {
  const { locale } = useLocale();
  const text = copy[locale];

  return (
    <main className="min-h-screen bg-[var(--app-bg)] text-[var(--text-primary)]">
      <section className="relative min-h-[70svh] overflow-hidden bg-[var(--sidebar-bg)] text-[var(--sidebar-text)]">
        <Image
          src="/spendlens-receipt-sample.jpg"
          alt=""
          aria-hidden="true"
          fill
          priority
          sizes="100vw"
          className="object-cover object-top opacity-25"
        />
        <div className="absolute inset-0 bg-[#071315]/75" aria-hidden="true" />
        <div className="relative mx-auto flex min-h-[70svh] max-w-7xl flex-col px-5 py-6 sm:px-8 lg:px-12">
          <nav className="flex min-h-11 items-center pr-28" aria-label={locale === "tr" ? "Ana sayfa" : "Home"}>
            <Link href={`/?lang=${locale}`} className="text-base font-extrabold">SpendLens AI</Link>
          </nav>

          <div className="my-auto max-w-3xl py-12">
            <h1 className="text-5xl font-semibold leading-none sm:text-6xl lg:text-7xl">{text.headline}</h1>
            <p className="mt-6 max-w-2xl text-2xl font-semibold leading-tight sm:text-3xl">{text.subtitle}</p>
            <p className="mt-5 max-w-2xl text-base leading-7 text-white/78 sm:text-lg">{text.detail}</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href={`/login?lang=${locale}`} className="product-button-primary w-fit">
                {text.signIn}
                <ChevronRight size={18} aria-hidden="true" />
              </Link>
              <Link href={`/register?lang=${locale}`} className="product-button-secondary border-white/30 bg-transparent text-white hover:border-white hover:text-white">
                {text.register}
              </Link>
            </div>
          </div>

          <ul className="grid gap-3 border-t border-white/20 pt-5 text-sm text-white/80 md:grid-cols-3">
            {text.trust.map((item) => (
              <li key={item} className="flex items-center gap-2">
                <BadgeCheck className="shrink-0 text-[var(--primary)]" size={18} aria-hidden="true" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-5 py-12 sm:px-8 lg:px-12 lg:py-16" aria-labelledby="product-flow-title">
        <div className="max-w-2xl">
          <h2 id="product-flow-title" className="text-2xl font-semibold sm:text-3xl">{text.flowTitle}</h2>
          <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)] sm:text-base">{text.flowDetail}</p>
        </div>
        <div className="mt-9 grid gap-8 md:grid-cols-3">
          {text.steps.map(([title, body], index) => {
            const Icon = stepIcons[index]!;
            return (
              <article key={title} className="border-t border-[var(--border-strong)] pt-5">
                <Icon className="text-[var(--primary)]" size={24} aria-hidden="true" />
                <h3 className="mt-4 text-lg font-semibold">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">{body}</p>
              </article>
            );
          })}
        </div>
      </section>
    </main>
  );
}
