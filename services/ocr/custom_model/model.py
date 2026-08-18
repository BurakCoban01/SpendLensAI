from __future__ import annotations

from services.ocr.custom_model.crnn import CRNNCTCRecognizer


class CRNNOCR(CRNNCTCRecognizer):
    """Backward-compatible alias for persisted smoke checkpoints."""
