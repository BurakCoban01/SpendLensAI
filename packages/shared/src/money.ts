import { z } from "zod";

export const CurrencyCodeSchema = z.enum(["TRY", "USD", "EUR", "GBP"]);
export type CurrencyCode = z.infer<typeof CurrencyCodeSchema>;

export type Money = Readonly<{
  amountMinor: bigint;
  currency: CurrencyCode;
}>;

const MINOR_UNITS: Record<CurrencyCode, number> = {
  TRY: 2,
  USD: 2,
  EUR: 2,
  GBP: 2
};

export function createMoney(amountMinor: bigint | number | string, currency: CurrencyCode = "TRY"): Money {
  return {
    amountMinor: BigInt(amountMinor),
    currency
  };
}

export function addMoney(left: Money, right: Money): Money {
  assertSameCurrency(left, right);
  return createMoney(left.amountMinor + right.amountMinor, left.currency);
}

export function subtractMoney(left: Money, right: Money): Money {
  assertSameCurrency(left, right);
  return createMoney(left.amountMinor - right.amountMinor, left.currency);
}

export function formatMoney(value: Money, locale = "tr-TR"): string {
  const unit = MINOR_UNITS[value.currency];
  const divisor = 10n ** BigInt(unit);
  const whole = value.amountMinor / divisor;
  const fraction = value.amountMinor < 0n ? -(value.amountMinor % divisor) : value.amountMinor % divisor;
  const normalized = `${whole}.${fraction.toString().padStart(unit, "0")}`;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: value.currency,
    minimumFractionDigits: unit,
    maximumFractionDigits: unit
  }).format(Number(normalized));
}

export function parseTurkishMoney(input: string, currency: CurrencyCode = "TRY"): Money {
  const cleaned = input
    .trim()
    .replace(/\s/g, "")
    .replace(/[₺TRYTL]/gi, "")
    .replace(/[^\d,.-]/g, "");

  if (!cleaned) {
    throw new Error("Amount is empty after normalization");
  }

  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  const decimalSeparator = lastComma > lastDot ? "," : lastDot >= 0 ? "." : "";
  const normalized =
    decimalSeparator === ","
      ? cleaned.replace(/\./g, "").replace(",", ".")
      : decimalSeparator === "."
        ? cleaned.replace(/,/g, "")
        : cleaned;

  if (!/^-?\d+(\.\d{1,2})?$/.test(normalized)) {
    throw new Error(`Invalid monetary amount: ${input}`);
  }

  const [wholePart = "0", fractionPart = ""] = normalized.split(".");
  const sign = wholePart.startsWith("-") ? -1n : 1n;
  const absoluteWhole = wholePart.replace("-", "");
  const fraction = fractionPart.padEnd(2, "0").slice(0, 2);
  return createMoney(sign * (BigInt(absoluteWhole) * 100n + BigInt(fraction)), currency);
}

export function assertSameCurrency(left: Money, right: Money): void {
  if (left.currency !== right.currency) {
    throw new Error(`Currency mismatch: ${left.currency} !== ${right.currency}`);
  }
}
