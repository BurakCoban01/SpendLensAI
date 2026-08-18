from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def load_project_fixture_line_references(fixture_root: Path) -> dict[str, str]:
    annotation_path = fixture_root / "annotations" / "fixture-lines.json"
    if not annotation_path.is_file():
        return {}
    payload = json.loads(annotation_path.read_text(encoding="utf-8"))
    documents = payload.get("documents") if isinstance(payload, dict) else None
    if not isinstance(documents, list):
        return {}
    references: dict[str, str] = {}
    for document in documents:
        if not isinstance(document, dict) or not isinstance(document.get("lines"), list):
            continue
        text = "\n".join(
            str(line.get("text") or "").strip()
            for line in document["lines"]
            if isinstance(line, dict) and str(line.get("text") or "").strip()
        )
        aliases = document.get("benchmarkFixtures")
        if not text or not isinstance(aliases, list):
            continue
        for alias in aliases:
            if str(alias).strip():
                references[str(alias).strip()] = text
    return references


def build_project_fixture_reference_text(truth: dict[str, Any]) -> str:
    repaired = _repair_mojibake(truth)
    if not isinstance(repaired, dict):
        return ""

    lines: list[str] = []
    snippets = [
        str(item).strip()
        for item in repaired.get("expectedOcrTextSnippets", [])
        if str(item).strip()
    ]
    for snippet in snippets:
        _append_unique(lines, snippet)

    merchant = _string_or_none(repaired.get("merchant"))
    if merchant:
        _append_unique(lines, merchant)

    date = _string_or_none(repaired.get("date"))
    if date:
        _append_unique(lines, f"TARIH {_format_date(date)}")

    for item in repaired.get("lineItems", []):
        if not isinstance(item, dict):
            continue
        description = _string_or_none(item.get("description"))
        amount = _string_or_none(item.get("amount"))
        if description and amount:
            _append_unique(lines, f"{description} {_format_amount(amount)} TL")
        elif description:
            _append_unique(lines, description)
        elif amount:
            _append_unique(lines, f"{_format_amount(amount)} TL")

    subtotal = _string_or_none(repaired.get("subtotal"))
    if subtotal:
        _append_unique(lines, f"ARA TOPLAM {_format_amount(subtotal)} TL")
    tax = _string_or_none(repaired.get("tax"))
    if tax:
        _append_unique(lines, f"KDV {_format_amount(tax)} TL")
    total = _string_or_none(repaired.get("total"))
    if total:
        _append_unique(lines, f"GENEL TOPLAM {_format_amount(total)} TL")
    payment = _string_or_none(repaired.get("paymentMethod"))
    if payment:
        _append_unique(lines, f"ODEME {payment}")

    return "\n".join(lines)


def _append_unique(lines: list[str], text: str) -> None:
    candidate = " ".join(text.split())
    if not candidate:
        return
    normalized = _normalize_for_duplicate(candidate)
    if all(_normalize_for_duplicate(existing) != normalized for existing in lines):
        lines.append(candidate)


def _normalize_for_duplicate(value: str) -> str:
    return value.casefold().replace(" ", "")


def _format_amount(value: str) -> str:
    text = value.strip()
    if "." in text and "," not in text:
        integer, fraction = text.rsplit(".", 1)
        if len(fraction) == 2 and fraction.isdigit():
            return f"{integer},{fraction}"
    return text


def _format_date(value: str) -> str:
    text = value.strip()
    if len(text) == 10 and text[4] == "-" and text[7] == "-":
        year, month, day = text.split("-", 2)
        return f"{day}.{month}.{year}"
    return text


def _string_or_none(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _repair_mojibake(value: object) -> object:
    if isinstance(value, str):
        if any(marker in value for marker in ("Ãƒ", "Ã„", "Ã…", "Ã¢")):
            try:
                return value.encode("latin1").decode("utf-8")
            except UnicodeError:
                return value
        return value
    if isinstance(value, list):
        return [_repair_mojibake(item) for item in value]
    if isinstance(value, dict):
        return {key: _repair_mojibake(item) for key, item in value.items()}
    return value
