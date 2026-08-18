from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact-dir", type=Path, default=Path("artifacts/models/custom-crnn-smoke"))
    args = parser.parse_args()
    model_path = args.artifact_dir / "model.pt"
    if not model_path.exists():
        raise FileNotFoundError(f"No model artifact found at {model_path}")
    manifest = {
        "name": "custom-crnn-smoke",
        "engine": "CUSTOM_CRNN",
        "artifact": str(model_path),
        "metrics": str(args.artifact_dir / "metrics.json"),
        "accuracy_note": "Smoke artifact; must be evaluated before promotion.",
    }
    (args.artifact_dir / "model-version.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
