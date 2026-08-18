from __future__ import annotations

import argparse
import json
from pathlib import Path

import joblib

from services.ocr.category_model.dataset import CategorySample, sample_to_text


def predict_category(
    model_path: Path,
    merchant: str,
    description: str,
    amount_minor: int,
    payment_method: str = "unknown",
    occurred_weekday: int = 0
) -> dict[str, object]:
    pipeline = joblib.load(model_path)
    sample = CategorySample(
        merchant=merchant,
        description=description,
        amount_minor=amount_minor,
        payment_method=payment_method,
        occurred_weekday=occurred_weekday,
        category="unknown",
        split="inference"
    )
    probabilities = pipeline.predict_proba([sample_to_text(sample)])[0]
    classes = list(pipeline.classes_)
    ranked = sorted(
        ({"category": category, "confidence": float(probability)} for category, probability in zip(classes, probabilities)),
        key=lambda row: row["confidence"],
        reverse=True
    )
    return {
        "prediction": ranked[0],
        "candidates": ranked[:5],
        "model": "local-sklearn-tfidf-logistic-regression",
        "externalServicesUsed": False
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-path", type=Path, default=Path("artifacts/models/category-smoke/category_model.joblib"))
    parser.add_argument("--merchant", required=True)
    parser.add_argument("--description", required=True)
    parser.add_argument("--amount-minor", type=int, required=True)
    parser.add_argument("--payment-method", default="unknown")
    parser.add_argument("--occurred-weekday", type=int, default=0)
    args = parser.parse_args()

    print(
        json.dumps(
            predict_category(
                args.model_path,
                args.merchant,
                args.description,
                args.amount_minor,
                args.payment_method,
                args.occurred_weekday
            ),
            indent=2
        )
    )


if __name__ == "__main__":
    main()

