from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


@dataclass(frozen=True)
class GoldenDocument:
    filename: str
    document_type: str
    split: str
    lines: tuple[str, ...]
    fields: dict[str, str]

    @property
    def text(self) -> str:
        return "\n".join(self.lines)


GOLDEN_DOCUMENTS = (
    GoldenDocument(
        filename="golden_receipt_001.png",
        document_type="receipt",
        split="train",
        lines=(
            "\u00c7A\u011eRI MARKET",
            "TARIH 12.05.2026 SAAT 18:42",
            "EKMEK 1 x 18,50 TL",
            "SUT 1 x 42,75 TL",
            "KDV %1 0,61 TL",
            "TOPLAM 61,25 TL",
            "ODEME KART **** 1234",
        ),
        fields={"merchant": "\u00c7A\u011eRI MARKET", "date": "12.05.2026", "total": "61,25 TL", "currency": "TRY"},
    ),
    GoldenDocument(
        filename="golden_invoice_001.png",
        document_type="invoice",
        split="train",
        lines=(
            "BILGI OFIS LTD",
            "FATURA NO OFS-2026-0042",
            "TARIH 03.05.2026",
            "DEFTER 10 x 24,00 TL",
            "KALEM 20 x 7,50 TL",
            "KDV %20 78,00 TL",
            "GENEL TOPLAM 468,00 TL",
        ),
        fields={"merchant": "BILGI OFIS LTD", "invoiceNo": "OFS-2026-0042", "date": "03.05.2026", "total": "468,00 TL"},
    ),
    GoldenDocument(
        filename="golden_receipt_002.png",
        document_type="receipt",
        split="validation",
        lines=(
            "\u0130ZMIR AKARYAKIT",
            "TARIH 19.04.2026",
            "MOTORIN 35,20 LT",
            "BIRIM 43,21 TL",
            "KDV DAHIL",
            "TOPLAM 1521,00 TL",
        ),
        fields={"merchant": "\u0130ZMIR AKARYAKIT", "date": "19.04.2026", "total": "1521,00 TL", "category": "Akaryak\u0131t"},
    ),
    GoldenDocument(
        filename="golden_invoice_002.png",
        document_type="invoice",
        split="validation",
        lines=(
            "ANADOLU KARGO A.S.",
            "E-ARSIV SANDBOX",
            "BELGE NO KRG-7781",
            "HIZMET BEDELI 210,00 TL",
            "KDV %20 42,00 TL",
            "ODENECEK TUTAR 252,00 TL",
        ),
        fields={"merchant": "ANADOLU KARGO A.S.", "invoiceNo": "KRG-7781", "total": "252,00 TL", "category": "Kargo"},
    ),
    GoldenDocument(
        filename="golden_receipt_003.png",
        document_type="receipt",
        split="test",
        lines=(
            "MAVI YEMEK",
            "27/04/2026 13:08",
            "\u00c7ORBA 85,00 TL",
            "ANA YEMEK 210,00 TL",
            "SERVIS 15,00 TL",
            "TOPLAM 310,00 TL",
        ),
        fields={"merchant": "MAVI YEMEK", "date": "27/04/2026", "total": "310,00 TL", "category": "Yemek"},
    ),
    GoldenDocument(
        filename="golden_invoice_003.png",
        document_type="invoice",
        split="test",
        lines=(
            "NOVA ABONELIK",
            "FATURA NO SUB-2026-99",
            "DONEM 2026-05",
            "YAZILIM ABONELIGI 899,00 TL",
            "KDV %20 179,80 TL",
            "GENEL TOPLAM 1078,80 TL",
        ),
        fields={"merchant": "NOVA ABONELIK", "invoiceNo": "SUB-2026-99", "total": "1078,80 TL", "category": "Abonelik"},
    ),
)


def generate_golden_dataset(output_dir: Path) -> list[GoldenDocument]:
    output_dir.mkdir(parents=True, exist_ok=True)
    font = ImageFont.load_default()
    manifest: list[dict[str, object]] = []

    for index, document in enumerate(GOLDEN_DOCUMENTS):
        image = Image.new("L", (640, 360), color=246)
        draw = ImageDraw.Draw(image)
        draw.rectangle((20, 16, 620, 344), outline=180, width=1)
        y = 34
        for line in document.lines:
            draw.text((42, y), line, fill=25, font=font)
            y += 38
        if document.document_type == "receipt":
            image = image.rotate(-1.2 if index % 2 == 0 else 1.0, expand=False, fillcolor=246)
            image = image.filter(ImageFilter.GaussianBlur(radius=0.25))
        path = output_dir / document.filename
        image.save(path)
        manifest.append(
            {
                "image": document.filename,
                "text": document.text,
                "split": document.split,
                "documentType": document.document_type,
                "fields": document.fields,
            }
        )

    (output_dir / "manifest.jsonl").write_text(
        "\n".join(json.dumps(row, ensure_ascii=False) for row in manifest),
        encoding="utf-8",
    )
    return list(GOLDEN_DOCUMENTS)
