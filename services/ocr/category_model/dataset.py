from __future__ import annotations

import csv
import random
from dataclasses import dataclass
from pathlib import Path


CATEGORY_FIXTURES: dict[str, dict[str, list[str]]] = {
    "market": {
        "merchants": ["Mavi Market", "Migros", "Bim", "A101", "Sok Market"],
        "items": ["sut ekmek peynir", "sebze meyve gida", "temizlik gida", "market alisverisi"]
    },
    "ulasim": {
        "merchants": ["City Taxi", "Metro Istanbul", "Havabus", "Otopark A"],
        "items": ["taksi yolculuk", "metro kart dolum", "otopark odemesi", "ulasim bileti"]
    },
    "yemek": {
        "merchants": ["Office Cafe", "Anadolu Lokanta", "Burger House", "Karadeniz Firin"],
        "items": ["ogle yemegi", "kahve sandvic", "doner ayran", "restoran hesap"]
    },
    "akaryakit": {
        "merchants": ["Shell", "Opet", "BP", "Aytemiz"],
        "items": ["motorin yakit", "benzin akaryakit", "petrol istasyonu", "arac yakit"]
    },
    "ofis": {
        "merchants": ["Ankara Kirtasiye", "Bilgi Ofis", "Tekno Yazici", "Ofis Depo"],
        "items": ["kalem defter", "printer toner", "ofis malzemesi", "bilgisayar aksesuar"]
    },
    "abonelik": {
        "merchants": ["Cloud Host", "SaaS Panel", "Spotify", "Domainci"],
        "items": ["hosting abonelik", "saas lisans", "domain yenileme", "subscription odemesi"]
    },
    "kargo": {
        "merchants": ["Aras Kargo", "MNG Kargo", "Yurtici Kargo", "PTT"],
        "items": ["kargo gonderi", "kurye teslimat", "cargo ucreti", "paket gonderimi"]
    },
    "saglik": {
        "merchants": ["Merkez Eczane", "Sağlık Klinik", "Ankara Hastane"],
        "items": ["ilaç eczane", "muayene ücreti", "sağlık hizmeti", "klinik ödeme"]
    }
}


@dataclass(frozen=True)
class CategorySample:
    merchant: str
    description: str
    amount_minor: int
    payment_method: str
    occurred_weekday: int
    category: str
    split: str


def generate_category_dataset(output_path: Path, count_per_category: int = 12, seed: int = 42) -> list[CategorySample]:
    rng = random.Random(seed)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    samples: list[CategorySample] = []

    for category, fixture in CATEGORY_FIXTURES.items():
        for index in range(count_per_category):
            merchant = rng.choice(fixture["merchants"])
            item_text = rng.choice(fixture["items"])
            amount_minor = _amount_for_category(category, rng)
            payment_method = rng.choice(["corporate_card", "cash", "personal_card", "bank_transfer"])
            occurred_weekday = rng.randint(0, 6)
            description = f"{merchant} {item_text} fiş no {rng.randint(1000, 9999)}"
            samples.append(
                CategorySample(
                    merchant=merchant,
                    description=description,
                    amount_minor=amount_minor,
                    payment_method=payment_method,
                    occurred_weekday=occurred_weekday,
                    category=category,
                    split=_split(index, count_per_category)
                )
            )

    rng.shuffle(samples)
    with output_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=["merchant", "description", "amount_minor", "payment_method", "occurred_weekday", "category", "split"]
        )
        writer.writeheader()
        for sample in samples:
            writer.writerow(
                {
                    "merchant": sample.merchant,
                    "description": sample.description,
                    "amount_minor": sample.amount_minor,
                    "payment_method": sample.payment_method,
                    "occurred_weekday": sample.occurred_weekday,
                    "category": sample.category,
                    "split": sample.split
                }
            )
    return samples


def read_category_dataset(path: Path) -> list[CategorySample]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return [
            CategorySample(
                merchant=row["merchant"],
                description=row["description"],
                amount_minor=int(row["amount_minor"]),
                payment_method=row["payment_method"],
                occurred_weekday=int(row["occurred_weekday"]),
                category=row["category"],
                split=row["split"]
            )
            for row in csv.DictReader(handle)
        ]


def sample_to_text(sample: CategorySample) -> str:
    amount_bucket = "high_amount" if sample.amount_minor >= 100000 else "normal_amount"
    weekend = "weekend" if sample.occurred_weekday in {5, 6} else "weekday"
    return f"{sample.merchant} {sample.description} {sample.payment_method} {amount_bucket} {weekend}"


def _split(index: int, count: int) -> str:
    ratio = index / max(count, 1)
    if ratio < 0.7:
        return "train"
    if ratio < 0.85:
        return "validation"
    return "test"


def _amount_for_category(category: str, rng: random.Random) -> int:
    ranges = {
        "market": (5000, 65000),
        "ulasim": (3000, 45000),
        "yemek": (7500, 85000),
        "akaryakit": (45000, 250000),
        "ofis": (10000, 180000),
        "abonelik": (9000, 120000),
        "kargo": (3500, 55000),
        "saglik": (12000, 200000)
    }
    low, high = ranges[category]
    return rng.randint(low, high)
