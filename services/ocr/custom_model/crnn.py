from __future__ import annotations

from datetime import datetime, timezone

import torch
from torch import nn
from torch.nn.utils.rnn import pack_padded_sequence, pad_packed_sequence

from services.ocr.custom_model.vocab import VOCAB_VERSION


class ResidualConvBlock(nn.Module):
    def __init__(self, channels: int):
        super().__init__()
        self.layers = nn.Sequential(
            nn.Conv2d(channels, channels, kernel_size=3, padding=1, bias=False),
            nn.BatchNorm2d(channels),
            nn.ReLU(inplace=True),
            nn.Conv2d(channels, channels, kernel_size=3, padding=1, bias=False),
            nn.BatchNorm2d(channels),
        )
        self.activation = nn.ReLU(inplace=True)

    def forward(self, inputs: torch.Tensor) -> torch.Tensor:
        return self.activation(inputs + self.layers(inputs))


class CRNNCTCRecognizer(nn.Module):
    def __init__(
        self,
        num_classes: int,
        hidden_size: int = 128,
        temporal_downsample: int = 4,
        backbone_version: str = "legacy",
    ):
        super().__init__()
        if temporal_downsample not in {2, 4}:
            raise ValueError("temporal_downsample must be 2 or 4.")
        if backbone_version not in {"legacy", "residual"}:
            raise ValueError("backbone_version must be 'legacy' or 'residual'.")
        self.temporal_downsample = temporal_downsample
        self.backbone_version = backbone_version
        if backbone_version == "residual":
            feature_channels = 128
            self.cnn = nn.Sequential(
                nn.Conv2d(1, 32, kernel_size=3, padding=1, bias=False),
                nn.BatchNorm2d(32),
                nn.ReLU(inplace=True),
                nn.MaxPool2d((2, 2 if temporal_downsample == 4 else 1)),
                ResidualConvBlock(32),
                nn.Conv2d(32, 64, kernel_size=3, padding=1, bias=False),
                nn.BatchNorm2d(64),
                nn.ReLU(inplace=True),
                nn.MaxPool2d(2, 2),
                ResidualConvBlock(64),
                nn.Conv2d(64, 128, kernel_size=3, padding=1, bias=False),
                nn.BatchNorm2d(128),
                nn.ReLU(inplace=True),
                nn.MaxPool2d((2, 1)),
                ResidualConvBlock(128),
                nn.Conv2d(128, 128, kernel_size=3, padding=1, bias=False),
                nn.BatchNorm2d(128),
                nn.ReLU(inplace=True),
                nn.AdaptiveAvgPool2d((1, None)),
            )
        else:
            feature_channels = 128
            self.cnn = nn.Sequential(
                nn.Conv2d(1, 32, kernel_size=3, padding=1),
                nn.ReLU(inplace=True),
                nn.MaxPool2d((2, 2 if temporal_downsample == 4 else 1)),
                nn.Conv2d(32, 64, kernel_size=3, padding=1),
                nn.ReLU(inplace=True),
                nn.MaxPool2d(2, 2),
                nn.Conv2d(64, 128, kernel_size=3, padding=1),
                nn.ReLU(inplace=True),
                nn.AdaptiveAvgPool2d((1, None)),
            )
        self.encoder = nn.LSTM(
            input_size=feature_channels,
            hidden_size=hidden_size,
            num_layers=2,
            bidirectional=True,
            batch_first=False,
            dropout=0.1,
        )
        self.classifier = nn.Linear(hidden_size * 2, num_classes)

    def forward(self, images: torch.Tensor, input_lengths: torch.Tensor | None = None) -> torch.Tensor:
        features = self.cnn(images).squeeze(2)
        sequence = features.permute(2, 0, 1)
        if input_lengths is None:
            encoded, _ = self.encoder(sequence)
        else:
            lengths = input_lengths.detach().to(device="cpu", dtype=torch.long).clamp(max=sequence.shape[0])
            packed = pack_padded_sequence(sequence, lengths, enforce_sorted=False)
            packed_encoded, _ = self.encoder(packed)
            encoded, _ = pad_packed_sequence(packed_encoded, total_length=sequence.shape[0])
        logits = self.classifier(encoded)
        return logits.log_softmax(dim=2)


def crnn_checkpoint_payload(
    model: CRNNCTCRecognizer,
    *,
    model_version: str,
    dataset_manifest_id: str,
    seed: int,
    metrics: dict[str, object] | None = None,
) -> dict[str, object]:
    return {
        "model_state": model.state_dict(),
        "metadata": {
            "model_name": "custom-crnn-ctc",
            "model_version": model_version,
            "architecture_version": crnn_architecture_version(model.temporal_downsample, model.backbone_version),
            "temporal_downsample": model.temporal_downsample,
            "backbone_version": model.backbone_version,
            "vocab_version": VOCAB_VERSION,
            "dataset_manifest_id": dataset_manifest_id,
            "seed": seed,
            "metrics": metrics or {},
            "created_at": datetime.now(timezone.utc).isoformat(),
        },
    }


def crnn_architecture_version(temporal_downsample: int, backbone_version: str = "legacy") -> str:
    if backbone_version == "residual":
        return f"crnn-ctc-v5-residual-td{temporal_downsample}-length-aware"
    return f"crnn-ctc-v{4 if temporal_downsample == 2 else 3}-length-aware"
