from __future__ import annotations

import torch
from torch import nn


class CharacterCNN(nn.Module):
    def __init__(self, num_classes: int):
        super().__init__()
        self.net = nn.Sequential(
            nn.Conv2d(1, 32, kernel_size=3, padding=1),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(2),
            nn.Conv2d(32, 64, kernel_size=3, padding=1),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(2),
            nn.BatchNorm2d(64),
            nn.Dropout(0.1),
            nn.Flatten(),
            nn.Linear(64 * 8 * 8, 128),
            nn.ReLU(inplace=True),
            nn.Linear(128, num_classes),
        )

    def forward(self, images: torch.Tensor) -> torch.Tensor:
        return self.net(images)


def checkpoint_payload(model: CharacterCNN, *, vocab_version: str, seed: int, metrics: dict[str, object] | None = None) -> dict[str, object]:
    return {
        "model_state": model.state_dict(),
        "model_name": "custom-char-cnn",
        "architecture_version": "char-cnn-v1",
        "vocab_version": vocab_version,
        "seed": seed,
        "metrics": metrics or {},
    }