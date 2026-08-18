from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from services.ocr.custom_model.router_reranker import (
    comparison_row_features,
    load_pairwise_router,
    pair_semantic_guard_reason,
)


def evaluate_pairwise_router(checkpoint: Path, predictions_path: Path, output_path: Path) -> dict[str, Any]:
    router = load_pairwise_router(checkpoint)
    rows = [json.loads(line) for line in predictions_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    decisions: list[dict[str, Any]] = []
    for row in rows:
        probability = router.challenger_probability(comparison_row_features(row))
        guard_reason = pair_semantic_guard_reason(
            str(row["championPrediction"]), str(row["challengerPrediction"])
        )
        base_selected = bool(row.get("challengerSelected"))
        router_eligible = not base_selected and float(row["aspectRatio"]) < 6.0
        router_selected = router_eligible and probability >= router.threshold and guard_reason is None
        selected = base_selected or router_selected
        decisions.append(
            {
                "sampleId": row["sampleId"],
                "image": row["image"],
                "probability": probability,
                "baseSelected": base_selected,
                "routerEligible": router_eligible,
                "routerSelected": router_selected,
                "selected": selected,
                "selectionReason": (
                    str(row.get("selectionReason") or "validated_existing_route")
                    if base_selected
                    else "validated_pairwise_router"
                    if router_selected
                    else guard_reason or "champion_fallback_pairwise_router_threshold"
                ),
                "championCer": row["championCer"],
                "challengerCer": row["challengerCer"],
            }
        )
    selected_rows = [row for row in decisions if row["selected"]]
    router_selected_rows = [row for row in decisions if row["routerSelected"]]
    champion_cer = sum(float(row["championCer"]) for row in decisions) / max(len(decisions), 1)
    active_cer = sum(
        float(row["challengerCer"] if row["baseSelected"] else row["championCer"]) for row in decisions
    ) / max(len(decisions), 1)
    composed_cer = sum(
        float(row["challengerCer"] if row["selected"] else row["championCer"]) for row in decisions
    ) / max(len(decisions), 1)
    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "routerCheckpoint": checkpoint.as_posix(),
        "routerCheckpointSha256": _sha256(checkpoint),
        "routerModelVersion": router.metadata.get("modelVersion"),
        "decisionThreshold": router.threshold,
        "predictionsArtifact": predictions_path.as_posix(),
        "predictionsSha256": _sha256(predictions_path),
        "samples": len(decisions),
        "documents": len({_decision_lineage(row) for row in decisions}),
        "selected": len(selected_rows),
        "baseSelected": sum(bool(row["baseSelected"]) for row in decisions),
        "routerSelected": len(router_selected_rows),
        "wins": sum(float(row["championCer"]) - float(row["challengerCer"]) > 0.02 for row in selected_rows),
        "regressions": sum(
            float(row["challengerCer"]) - float(row["championCer"]) > 0.02 for row in selected_rows
        ),
        "significantRegressions": sum(
            float(row["challengerCer"]) - float(row["championCer"]) > 0.10 for row in selected_rows
        ),
        "routerWins": sum(
            float(row["championCer"]) - float(row["challengerCer"]) > 0.02 for row in router_selected_rows
        ),
        "routerRegressions": sum(
            float(row["challengerCer"]) - float(row["championCer"]) > 0.02 for row in router_selected_rows
        ),
        "routerSignificantRegressions": sum(
            float(row["challengerCer"]) - float(row["championCer"]) > 0.10 for row in router_selected_rows
        ),
        "championCer": champion_cer,
        "activeCer": active_cer,
        "composedCer": composed_cer,
        "absoluteCerGain": champion_cer - composed_cer,
        "absoluteCerGainVsActive": active_cer - composed_cer,
        "decisions": decisions,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _decision_lineage(row: dict[str, Any]) -> str:
    sample_id = str(row["sampleId"])
    if sample_id.startswith("OCRTurk:") and ":p" in sample_id:
        return sample_id.split(":p", 1)[0]
    return str(row["image"])


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate a pairwise OCR router on immutable paired predictions.")
    parser.add_argument("--checkpoint", required=True, type=Path)
    parser.add_argument("--predictions", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    report = evaluate_pairwise_router(args.checkpoint, args.predictions, args.output)
    print(json.dumps({key: value for key, value in report.items() if key != "decisions"}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
