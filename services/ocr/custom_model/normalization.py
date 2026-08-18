from __future__ import annotations

import re
import unicodedata

from services.ocr.custom_model.vocab import CHAR_TO_INDEX


def normalize_raw_input(text: str) -> str:
    """Preserve Turkish characters while making Unicode representation stable."""
    return unicodedata.normalize("NFC", text.replace("\r\n", "\n").replace("\r", "\n"))


def normalize_for_extraction(text: str) -> str:
    normalized = normalize_raw_input(text)
    normalized = re.sub(r"(?m)^,\s*", "", normalized)
    normalized = re.sub(r"(?im)^1\s+(?=SPENDLENS\b)", "", normalized)
    replacements = {
        "IŞLEM": "İŞLEM",
        "ISLEM": "İŞLEM",
        "ODEME": "ÖDEME",
        "URUN": "ÜRÜN",
        "TARIH": "TARİH",
        "GENEL T0PLAM": "GENEL TOPLAM",
        "T0PLAM": "TOPLAM",
    }
    normalized = re.sub(r"\bFIS(?=\s+NO\b)", "FİŞ", normalized, flags=re.IGNORECASE)
    for source, target in replacements.items():
        normalized = re.sub(source, target, normalized, flags=re.IGNORECASE)
    normalized = re.sub(r"(?im)^F[,İI]S\s+N[:0O]+:", "FİŞ NO:", normalized)
    normalized = re.sub(r"(?im)^FP?1?S\s+N[:0O]+:", "FİŞ NO:", normalized)
    normalized = re.sub(r"(?im)^FATURA\s+N:+", "FATURA NO:", normalized)
    normalized = re.sub(r"(?im)^TAR[,İI]H(?=\s*:)", "TARİH", normalized)
    normalized = re.sub(r"(?im)^TAR[.,1İI]+H(?=\s*:)", "TARİH", normalized)
    normalized = re.sub(r"(?im)^(TARİH\s*:\s*)(\d{2})1(\d{2})1(\d{4})$", r"\1\2.\3.\4", normalized)
    normalized = re.sub(r"(?im)^SENEL(?=\s+TOPLAM\b)", "GENEL", normalized)
    normalized = re.sub(r"(?im)^SUT(?=\s)", "SÜT", normalized)
    normalized = re.sub(r"(?im)^S[0O]T(?=\s+(?:0K0|%)\s*\d{1,2}\b)", "SÜT", normalized)
    normalized = re.sub(r"(?im)^[0O]:?R[0O]N(?=\s+KDV\s+TUTAR\b)", "ÜRÜN", normalized)
    normalized = re.sub(r"\b0K0(?=\d{1,2}\b)", "%", normalized)
    normalized = re.sub(r"(?im)^PARA\s+B[,İI]R[,İI]M[,İI]:", "PARA BİRİMİ:", normalized)
    normalized = re.sub(r"\bTRV\s+1\s+TL\b", "TRY / TL", normalized)
    normalized = re.sub(r"(?m)^,\s*", "", normalized)
    normalized = re.sub(r"(?im)^1\s+(?=SPENDLENS\b)", "", normalized)
    normalized = re.sub(r"(?im)^ARATOP(?:LAM|VM)\b", "ARA TOPLAM", normalized)
    normalized = re.sub(r"(?im)^[A-Z0-9.,: ]*\bTOLA[A-Z]*\s+(?=\d)", "GENEL TOPLAM ", normalized)
    normalized = re.sub(r"(?im)^E[.-]ARS[,İI]V(?=SANDBOX)", "E-ARŞİV ", normalized)
    normalized = re.sub(r"(?im)^SAT[,İI]C[,İI](?=\s*:)", "SATICI", normalized)
    normalized = re.sub(r"\bM0STER[.İI1]+\b", "MÜŞTERİ", normalized, flags=re.IGNORECASE)
    normalized = re.sub(r"\bSANDDOX\b", "SANDBOX", normalized, flags=re.IGNORECASE)
    normalized = re.sub(r"\bH[.İI]12MET1\b", "HİZMET", normalized, flags=re.IGNORECASE)
    normalized = re.sub(r"\bM[.İI]1KTAR\b", "MİKTAR", normalized, flags=re.IGNORECASE)
    normalized = re.sub(r"(?im)^PARAB[.İI]1R[.İI]1M[.İI]1:", "PARA BİRİMİ:", normalized)
    normalized = re.sub(r"\bTRV1TL\b", "TRY / TL", normalized)
    normalized = re.sub(r"(?<=\d)[.](?=\d{2}\s*(?:TL|TRY|₺))", ",", normalized)
    normalized = re.sub(r"[ \t]+", " ", normalized)
    return "\n".join(line.strip() for line in normalized.splitlines()).strip()


def remove_unsupported_characters(text: str) -> str:
    return "".join(char for char in normalize_raw_input(text) if char == "\n" or char in CHAR_TO_INDEX)
