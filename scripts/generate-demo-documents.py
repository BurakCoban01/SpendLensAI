from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path("data/demo-fixtures")
GROUND_TRUTH = ROOT / "ground-truth"


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        Path("C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf"),
        Path("C:/Windows/Fonts/calibrib.ttf" if bold else "C:/Windows/Fonts/calibri.ttf"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size)
    try:
        return ImageFont.truetype("DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf", size)
    except OSError:
        return ImageFont.load_default()


def receipt_image(title: str, total: str, payment: str, receipt_number: str = "SL-2026-0001") -> Image.Image:
    image = Image.new("RGB", (980, 1360), "#fbfaf6")
    draw = ImageDraw.Draw(image)
    x = 86
    y = 72
    draw.text((x, y), title, fill="#111111", font=font(44, True))
    y += 78
    lines = [
        f"FİŞ NO: {receipt_number}",
        "TARİH: 02.06.2026",
        "SAAT: 11:20",
        "VKN: 1111111111",
        "",
        "ÜRÜN                    KDV      TUTAR",
        "EKMEK                   %1       20,00 TL",
        "SÜT                     %10      32,50 TL",
        "KAHVE                   %20      12,00 TL",
        "",
        "ARA TOPLAM                       64,50 TL",
        "KDV                               7,55 TL",
        f"GENEL TOPLAM                    {total}",
        f"ÖDEME: {payment}",
        "PARA BİRİMİ: TRY / TL",
    ]
    for line in lines:
        draw.text((x, y), line, fill="#171717", font=font(30, line.startswith("GENEL TOPLAM")))
        y += 52 if line else 32
    draw.rectangle((58, 44, 922, 1310), outline="#222222", width=4)
    return image


def invoice_image(title: str, number: str, total: str) -> Image.Image:
    image = Image.new("RGB", (1240, 1754), "#ffffff")
    draw = ImageDraw.Draw(image)
    x = 92
    y = 96
    draw.text((x, y), title, fill="#111111", font=font(52, True))
    y += 90
    lines = [
        f"FATURA NO: {number}",
        "TARİH: 02.06.2026",
        "SATICI: SPENDLENS MARKET SANDBOX",
        "VKN: 1111111111",
        "ALICI: TEST MÜŞTERİ SANDBOX",
        "VKN/TCKN: 2222222222",
        "",
        "HİZMET / ÜRÜN             MİKTAR     KDV       TUTAR",
        "Ofis kırtasiye             1          %20       420,00 TL",
        "Kargo hizmeti              1          %20        80,00 TL",
        "",
        "ARA TOPLAM                                      500,00 TL",
        "KDV                                             100,00 TL",
        f"GENEL TOPLAM                                   {total}",
        "ÖDEME: KART",
        "PARA BİRİMİ: TRY / TL",
    ]
    for line in lines:
        draw.text((x, y), line, fill="#171717", font=font(31, line.startswith("GENEL TOPLAM")))
        y += 54 if line else 34
    draw.rectangle((62, 62, 1178, 1688), outline="#222222", width=4)
    return image


def payment_image(title: str, reference: str, total: str) -> Image.Image:
    image = Image.new("RGB", (1240, 1500), "#ffffff")
    draw = ImageDraw.Draw(image)
    x = 92
    y = 96
    draw.text((x, y), title, fill="#111111", font=font(50, True))
    y += 105
    lines = [
        f"İŞLEM REFERANSI: {reference}",
        "İŞLEM TARİHİ: 02.06.2026 14:35",
        "GÖNDEREN: PUSULA TEKNOLOJİ A.Ş.",
        "ALICI: TEDARİKÇİ SANDBOX A.Ş.",
        "ALICI IBAN: TR00 0000 0000 0000 0000 0000 00",
        "AÇIKLAMA: TEDARİKÇİ ÖDEMESİ",
        "",
        f"GÖNDERİLEN TUTAR: {total}",
        "PARA BİRİMİ: TRY / TL",
        "DURUM: TAMAMLANDI",
    ]
    for line in lines:
        draw.text((x, y), line, fill="#171717", font=font(32, line.startswith("GÖNDERİLEN TUTAR")))
        y += 66 if line else 38
    draw.rectangle((62, 62, 1178, 1438), outline="#222222", width=4)
    return image


def write_truth(name: str, canonical_mime: str, snippets: list[str], document_type: str, total: str, payment: str, mismatch: bool = False) -> None:
    path = GROUND_TRUTH / f"{name}.json"
    if path.exists():
        return
    payload = {
        "merchant": "SPENDLENS MARKET SANDBOX",
        "date": "2026-06-02",
        "currency": "TRY",
        "subtotal": "64.50" if document_type == "receipt" else "500.00",
        "tax": "7.55" if document_type == "receipt" else "100.00",
        "total": total,
        "paymentMethod": payment,
        "lineItems": [
            {"description": "EKMEK", "amount": "20.00"},
            {"description": "SÜT", "amount": "32.50"},
        ]
        if document_type == "receipt"
        else [
            {"description": "Ofis kırtasiye", "amount": "420.00"},
            {"description": "Kargo hizmeti", "amount": "80.00"},
        ],
        "documentType": document_type,
        "expectedOcrTextSnippets": snippets,
        "expectedCanonicalMime": canonical_mime,
        "expectedExtensionMismatchWarning": mismatch,
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    GROUND_TRUTH.mkdir(parents=True, exist_ok=True)

    receipt = receipt_image("SPENDLENS MARKET SANDBOX", "72,05 TL", "KART")
    mislabeled_receipt = receipt.copy()
    ImageDraw.Draw(mislabeled_receipt).text((650, 1260), "WEBP MISMATCH", fill="#171717", font=font(24, True))
    invoice = invoice_image("SPENDLENS FATURA SANDBOX", "SLF202600001", "600,00 TL")
    e_archive = invoice_image("E-ARŞİV SANDBOX", "EARS202600001", "600,00 TL")

    save_if_missing(ROOT / "valid-fis-01.jpg", receipt, "JPEG", quality=92)
    save_if_missing(ROOT / "valid-fis-02.webp", receipt, "WEBP", quality=92)
    save_if_missing(ROOT / "valid-fis-03.png", receipt, "PNG")
    save_if_missing(ROOT / "valid-fis-04.tiff", receipt, "TIFF")
    save_if_missing(ROOT / "valid-fis-05.bmp", receipt, "BMP")
    save_if_missing(ROOT / "valid-fis-06.gif", receipt, "GIF")
    save_if_missing(ROOT / "valid-mislabeled-webp-as-jpg.jpg", mislabeled_receipt, "WEBP", quality=92)
    save_if_missing(ROOT / "valid-fatura-01.pdf", invoice, "PDF", resolution=200.0)
    save_if_missing(ROOT / "valid-e-arsiv-sandbox.pdf", e_archive, "PDF", resolution=200.0)

    receipt_snippets = ["SPENDLENS MARKET SANDBOX", "FİŞ NO", "KDV", "GENEL TOPLAM", "72,05 TL", "ÖDEME"]
    for name, mime, mismatch in [
        ("valid-fis-01", "image/jpeg", False),
        ("valid-fis-02", "image/webp", False),
        ("valid-fis-03", "image/png", False),
        ("valid-fis-04", "image/tiff", False),
        ("valid-fis-05", "image/bmp", False),
        ("valid-fis-06", "image/gif", False),
        ("valid-mislabeled-webp-as-jpg", "image/webp", True),
    ]:
        write_truth(name, mime, receipt_snippets, "receipt", "72.05", "KART", mismatch)

    write_truth("valid-fatura-01", "application/pdf", ["SPENDLENS FATURA SANDBOX", "FATURA NO", "KDV", "GENEL TOPLAM", "600,00 TL"], "invoice", "600.00", "KART")
    write_truth("valid-e-arsiv-sandbox", "application/pdf", ["E-ARŞİV SANDBOX", "FATURA NO", "KDV", "GENEL TOPLAM", "600,00 TL"], "invoice", "600.00", "KART")

    generate_rich_demo_fixtures()


def generate_rich_demo_fixtures() -> None:
    target = ROOT / "demo-fixtures"
    truth_target = target / "ground-truth"
    target.mkdir(parents=True, exist_ok=True)
    truth_target.mkdir(parents=True, exist_ok=True)

    merchants = [
        "MAVİ MARKET", "LOKANTA 34", "OFİS DEPO", "ŞEHİR TAKSİ", "HIZLI KURYE", "FİBERNET",
        "PUSULA KIRTASİYE", "MARMARA OTEL", "İSTANBUL METRO", "SHELL İSTASYONU", "KENT OTOPARK", "KAHVE DURAĞI",
    ]
    for index, merchant in enumerate(merchants, start=1):
        image = receipt_image(merchant, "72,05 TL", "KART", f"PSL-2026-{index:04d}")
        filename = f"demo-fis-{index:02d}.jpg"
        save_if_missing(target / filename, image, "JPEG", quality=88, optimize=True)
        write_demo_truth(
            truth_target / f"demo-fis-{index:02d}.json",
            filename,
            "receipt",
            merchant,
            "72.05",
            [merchant, "FİŞ NO", "GENEL TOPLAM", "72,05 TL"],
        )

    invoice_titles = ["OFİS HİZMET FATURASI", "E-ARŞİV HİZMET FATURASI", "KURUMSAL ABONELİK FATURASI", "LOJİSTİK FATURASI"]
    for index, title in enumerate(invoice_titles, start=1):
        image = invoice_image(title, f"PSLF2026{index:05d}", "600,00 TL")
        filename = f"demo-fatura-{index:02d}.pdf"
        save_if_missing(target / filename, image, "PDF", resolution=160.0)
        write_demo_truth(
            truth_target / f"demo-fatura-{index:02d}.json",
            filename,
            "invoice",
            title,
            "600.00",
            [title, "FATURA NO", "GENEL TOPLAM", "600,00 TL"],
        )

    for index in range(1, 5):
        title = "BANKA ÖDEME DEKONTU"
        image = payment_image(title, f"PSL-DEKONT-{index:05d}", f"{index * 1250},00 TL")
        filename = f"demo-dekont-{index:02d}.png"
        save_if_missing(target / filename, image, "PNG", optimize=True)
        write_demo_truth(
            truth_target / f"demo-dekont-{index:02d}.json",
            filename,
            "payment_proof",
            "TEDARİKÇİ SANDBOX A.Ş.",
            f"{index * 1250}.00",
            [title, "İŞLEM REFERANSI", "GÖNDERİLEN TUTAR", "TAMAMLANDI"],
        )


def write_demo_truth(path: Path, filename: str, document_type: str, merchant: str, total: str, snippets: list[str]) -> None:
    if path.exists():
        return
    payload = {
        "filename": filename,
        "merchant": merchant,
        "date": "2026-06-02",
        "currency": "TRY",
        "total": total,
        "documentType": document_type,
        "expectedOcrTextSnippets": snippets,
        "synthetic": True,
        "source": "scripts/generate-demo-documents.py",
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def save_if_missing(path: Path, image: Image.Image, image_format: str, **options: object) -> None:
    if path.exists():
        return
    image.save(path, image_format, **options)


if __name__ == "__main__":
    main()
