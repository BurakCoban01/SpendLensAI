export type ExpenseCategoryKey =
  | "market"
  | "ulasim"
  | "yemek"
  | "akaryakit"
  | "konaklama"
  | "ofis"
  | "saglik"
  | "egitim"
  | "abonelik"
  | "kargo"
  | "vergi_harc"
  | "diger";

export const expenseCategoryLabels: Record<ExpenseCategoryKey, string> = {
  market: "Market",
  ulasim: "Ulaşım",
  yemek: "Yemek",
  akaryakit: "Akaryakıt",
  konaklama: "Konaklama",
  ofis: "Ofis",
  saglik: "Sağlık",
  egitim: "Eğitim",
  abonelik: "Abonelik",
  kargo: "Kargo",
  vergi_harc: "Vergi/harç sandbox",
  diger: "Diğer"
};

export type ExpenseCategorizationInput = {
  title: string;
  merchantName?: string | null;
  description?: string | null;
  amountMinor: bigint;
  currency?: string;
  occurredAt: Date;
  paymentMethodName?: string | null;
  lineItemNames?: string[];
  businessExpense?: boolean;
  reimbursable?: boolean;
};

export type CategoryPrediction = {
  categoryKey: ExpenseCategoryKey;
  confidence: number;
  reasons: string[];
  matchedKeywords: string[];
};

export type ExpenseAnomaly = {
  code:
    | "UNUSUALLY_HIGH_AMOUNT"
    | "POSSIBLE_DUPLICATE"
    | "WEEKEND_BUSINESS_EXPENSE"
    | "NEGATIVE_AMOUNT"
    | "MISSING_MERCHANT"
    | "UNUSUAL_MERCHANT";
  severity: "info" | "warning" | "critical";
  message: string;
  evidence: Record<string, string | number | boolean | null>;
};

const categoryKeywords: Record<ExpenseCategoryKey, string[]> = {
  market: ["market", "bakkal", "gida", "super", "migros", "sok", "carrefour", "a101", "bim", "sut", "ekmek"],
  ulasim: ["taksi", "metro", "ulasim", "otobus", "tren", "havabus", "otopark", "yol", "uber"],
  yemek: ["yemek", "restoran", "lokanta", "cafe", "kahve", "burger", "pizza", "doner", "firin"],
  akaryakit: ["akaryakit", "benzin", "motorin", "petrol", "opet", "shell", "bp", "aytemiz"],
  konaklama: ["otel", "hotel", "konaklama", "pansiyon", "airbnb"],
  ofis: ["ofis", "kirtasiye", "kalem", "defter", "printer", "toner", "yazici", "bilgisayar"],
  saglik: ["saglik", "eczane", "hastane", "klinik", "ilac", "muayene"],
  egitim: ["egitim", "kurs", "okul", "universite", "kitap", "udemy"],
  abonelik: ["abonelik", "subscription", "netflix", "spotify", "hosting", "saas", "domain", "cloud"],
  kargo: ["kargo", "kurye", "cargo", "ptt", "aras", "mng", "yurtici", "ups"],
  vergi_harc: ["vergi", "harc", "noter", "belediye", "damga"],
  diger: []
};

export function predictExpenseCategory(input: ExpenseCategorizationInput): CategoryPrediction {
  const haystack = normalize(
    [input.title, input.merchantName, input.description, input.paymentMethodName, ...(input.lineItemNames ?? [])]
      .filter(Boolean)
      .join(" ")
  );

  const scored = Object.entries(categoryKeywords)
    .filter(([key]) => key !== "diger")
    .map(([key, keywords]) => {
      const matched = keywords.filter((keyword) => haystack.includes(keyword));
      return { categoryKey: key as ExpenseCategoryKey, matched };
    })
    .sort((left, right) => right.matched.length - left.matched.length);

  const best = scored[0];
  if (!best || best.matched.length === 0) {
    return {
      categoryKey: "diger",
      confidence: 0.25,
      reasons: ["No deterministic category keyword matched the expense text."],
      matchedKeywords: []
    };
  }

  const confidence = Math.min(0.95, 0.48 + best.matched.length * 0.14);
  return {
    categoryKey: best.categoryKey,
    confidence,
    reasons: [
      `Matched ${best.matched.length} keyword(s) for ${best.categoryKey}.`,
      "Prediction is a local heuristic baseline and must not be treated as absolute truth."
    ],
    matchedKeywords: best.matched
  };
}

export function detectExpenseAnomalies(
  input: ExpenseCategorizationInput,
  peers: ExpenseCategorizationInput[] = []
): ExpenseAnomaly[] {
  const anomalies: ExpenseAnomaly[] = [];

  if (input.amountMinor < 0n) {
    anomalies.push({
      code: "NEGATIVE_AMOUNT",
      severity: "critical",
      message: "Expense amount is negative.",
      evidence: { amountMinor: input.amountMinor.toString() }
    });
  }

  if (!input.merchantName?.trim()) {
    anomalies.push({
      code: "MISSING_MERCHANT",
      severity: "warning",
      message: "Expense has no merchant name.",
      evidence: { title: input.title }
    });
  }

  const positivePeerAmounts = peers.map((peer) => peer.amountMinor).filter((amount) => amount > 0n);
  if (input.amountMinor > 0n && positivePeerAmounts.length >= 3) {
    const average = positivePeerAmounts.reduce((sum, amount) => sum + amount, 0n) / BigInt(positivePeerAmounts.length);
    const threshold = average * 3n;
    if (threshold > 0n && input.amountMinor > threshold) {
      anomalies.push({
        code: "UNUSUALLY_HIGH_AMOUNT",
        severity: "warning",
        message: "Expense amount is more than three times the workspace peer average.",
        evidence: { amountMinor: input.amountMinor.toString(), peerAverageMinor: average.toString() }
      });
    }
  }

  const occurredDay = input.occurredAt.toISOString().slice(0, 10);
  const duplicate = peers.find(
    (peer) =>
      peer !== input &&
      normalize(peer.merchantName ?? "") === normalize(input.merchantName ?? "") &&
      peer.amountMinor === input.amountMinor &&
      peer.occurredAt.toISOString().slice(0, 10) === occurredDay
  );
  if (duplicate && input.merchantName) {
    anomalies.push({
      code: "POSSIBLE_DUPLICATE",
      severity: "warning",
      message: "Same merchant, amount and date already exist in the workspace sample.",
      evidence: { merchantName: input.merchantName, amountMinor: input.amountMinor.toString(), occurredDate: occurredDay }
    });
  }

  const day = input.occurredAt.getUTCDay();
  if (input.businessExpense && (day === 0 || day === 6)) {
    anomalies.push({
      code: "WEEKEND_BUSINESS_EXPENSE",
      severity: "info",
      message: "Business expense occurred on a weekend.",
      evidence: { occurredDate: occurredDay, reimbursable: input.reimbursable ?? false }
    });
  }

  const merchant = normalize(input.merchantName ?? "");
  const merchantSeen = merchant && peers.some((peer) => normalize(peer.merchantName ?? "") === merchant);
  if (merchant && peers.length >= 5 && !merchantSeen) {
    anomalies.push({
      code: "UNUSUAL_MERCHANT",
      severity: "info",
      message: "Merchant has not appeared in the workspace sample used for this local analysis.",
      evidence: { merchantName: input.merchantName ?? null, peerCount: peers.length }
    });
  }

  return anomalies;
}

export function normalizeCategoryConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, Math.round(value * 10000) / 10000));
}

function normalize(value: string): string {
  return value
    .toLocaleLowerCase("tr-TR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
