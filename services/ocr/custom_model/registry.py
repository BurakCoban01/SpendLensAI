from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


@dataclass(frozen=True)
class LocalModelArtifact:
    model_code: str
    version: str
    artifact_path: str
    dataset_manifest_id: str
    vocabulary_version: str
    metrics: dict[str, object]
    status: str = "READY"


def write_local_registry_entry(registry_path: Path, artifact: LocalModelArtifact) -> dict[str, object]:
    registry_path.parent.mkdir(parents=True, exist_ok=True)
    rows = []
    if registry_path.exists():
        rows = json.loads(registry_path.read_text(encoding="utf-8"))
    entry = {
        **artifact.__dict__,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    rows = [row for row in rows if not (row["model_code"] == artifact.model_code and row["version"] == artifact.version)]
    rows.append(entry)
    registry_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    return entry


def find_ready_model(registry_path: Path, model_code: str) -> dict[str, object] | None:
    if not registry_path.exists():
        return None
    rows = json.loads(registry_path.read_text(encoding="utf-8"))
    ready = [row for row in rows if row.get("model_code") == model_code and row.get("status") == "READY"]
    return ready[-1] if ready else None