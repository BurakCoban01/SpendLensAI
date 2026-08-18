from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import sklearn
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import GroupKFold, cross_val_predict
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from services.ocr.custom_model.router_reranker import (
    ROUTER_FEATURE_NAMES,
    ROUTER_FEATURE_VERSION,
    comparison_row_features,
)


def train_pairwise_router(
    prediction_paths: list[Path],
    artifact_dir: Path,
    *,
    model_version: str,
    minimum_threshold: float = 0.95,
) -> dict[str, object]:
    rows = [
        json.loads(raw_line)
        for path in prediction_paths
        for raw_line in path.read_text(encoding="utf-8").splitlines()
        if raw_line.strip()
    ]
    groups = np.asarray([str(row["image"]) for row in rows])
    if len(set(groups)) < 5:
        raise ValueError("Pairwise router training requires at least five independent document groups.")
    features = np.asarray([comparison_row_features(row) for row in rows], dtype=np.float64)
    labels = np.asarray(
        [float(row["challengerCer"]) + 0.02 < float(row["championCer"]) for row in rows], dtype=np.int64
    )
    if labels.min() == labels.max():
        raise ValueError("Pairwise router training requires both challenger-win and fallback examples.")
    model = _new_model()
    oof_probability = cross_val_predict(
        model,
        features,
        labels,
        groups=groups,
        cv=GroupKFold(n_splits=5),
        method="predict_proba",
    )[:, 1]
    threshold, threshold_metrics = _select_threshold(rows, oof_probability, minimum_threshold)
    model.fit(features, labels)

    metadata: dict[str, object] = {
        "modelVersion": model_version,
        "featureVersion": ROUTER_FEATURE_VERSION,
        "featureNames": list(ROUTER_FEATURE_NAMES),
        "decisionThreshold": threshold,
        "trainingSamples": len(rows),
        "trainingDocuments": len(set(groups)),
        "trainingPredictionArtifacts": [
            {"path": path.as_posix(), "sha256": _sha256(path)} for path in prediction_paths
        ],
        "labelPolicy": "challenger_cer_plus_0.02_below_champion",
        "validationPolicy": "document_grouped_5_fold_oof_zero_regression_threshold",
        "oofMetrics": threshold_metrics,
        "scikitLearnVersion": sklearn.__version__,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    artifact_dir.mkdir(parents=True, exist_ok=True)
    scaler = model.named_steps["standardscaler"]
    classifier = model.named_steps["logisticregression"]
    checkpoint_path = artifact_dir / "router.json"
    checkpoint_path.write_text(
        json.dumps(
            {
                "metadata": metadata,
                "model": {
                    "type": "standard-scaled-logistic-regression",
                    "means": scaler.mean_.tolist(),
                    "scales": scaler.scale_.tolist(),
                    "coefficients": classifier.coef_[0].tolist(),
                    "intercept": float(classifier.intercept_[0]),
                },
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    report = {
        "checkpoint": checkpoint_path.as_posix(),
        "checkpointSha256": _sha256(checkpoint_path),
        "metadata": metadata,
    }
    (artifact_dir / "metrics.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


def _new_model() -> object:
    return make_pipeline(
        StandardScaler(),
        LogisticRegression(C=0.2, max_iter=2000, class_weight="balanced", random_state=41),
    )


def _select_threshold(
    rows: list[dict[str, object]], probabilities: np.ndarray, minimum_threshold: float
) -> tuple[float, dict[str, object]]:
    candidates: list[tuple[float, dict[str, object]]] = []
    for threshold in np.arange(minimum_threshold, 0.991, 0.01):
        selected = [index for index, probability in enumerate(probabilities) if probability >= threshold]
        wins = sum(float(rows[index]["championCer"]) - float(rows[index]["challengerCer"]) > 0.02 for index in selected)
        regressions = sum(
            float(rows[index]["challengerCer"]) - float(rows[index]["championCer"]) > 0.02 for index in selected
        )
        significant_regressions = sum(
            float(rows[index]["challengerCer"]) - float(rows[index]["championCer"]) > 0.10 for index in selected
        )
        cer_gain = sum(
            float(rows[index]["championCer"]) - float(rows[index]["challengerCer"]) for index in selected
        ) / max(len(rows), 1)
        metrics = {
            "threshold": round(float(threshold), 4),
            "selected": len(selected),
            "wins": wins,
            "regressions": regressions,
            "significantRegressions": significant_regressions,
            "averageCerGain": cer_gain,
        }
        if len(selected) >= 20 and regressions == 0 and significant_regressions == 0:
            candidates.append((cer_gain, metrics))
    if not candidates:
        raise ValueError("No pairwise router threshold met the grouped zero-regression calibration gate.")
    _gain, metrics = max(candidates, key=lambda item: (item[0], -float(item[1]["threshold"])))
    return float(metrics["threshold"]), metrics


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description="Train a document-grouped project-owned OCR candidate reranker.")
    parser.add_argument("--predictions", action="append", required=True, type=Path)
    parser.add_argument("--artifact-dir", required=True, type=Path)
    parser.add_argument("--model-version", required=True)
    parser.add_argument("--minimum-threshold", type=float, default=0.95)
    args = parser.parse_args()
    report = train_pairwise_router(
        args.predictions,
        args.artifact_dir,
        model_version=args.model_version,
        minimum_threshold=args.minimum_threshold,
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
