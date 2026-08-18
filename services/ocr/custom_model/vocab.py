from __future__ import annotations

BLANK_TOKEN = "<blank>"
VOCAB_VERSION = "tr-finance-v1"
SUPPORTED_CHARACTERS = (
    "abcdefghijklmnopqrstuvwxyz"
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    "0123456789"
    "çğıİöşüÇĞIÖŞÜ"
    " .,;:-_/\\()[]{}%+*=#'\"!?&@"
    "₺$€"
)
CHARS = SUPPORTED_CHARACTERS
VOCAB = [BLANK_TOKEN, *list(dict.fromkeys(SUPPORTED_CHARACTERS))]
CHAR_TO_INDEX = {char: index for index, char in enumerate(VOCAB)}
INDEX_TO_CHAR = {index: char for char, index in CHAR_TO_INDEX.items()}


def encode(text: str, *, strict: bool = False) -> list[int]:
    indices: list[int] = []
    for char in text:
        index = CHAR_TO_INDEX.get(char)
        if index is None:
            if strict:
                raise ValueError(f"Character is not in OCR vocabulary {VOCAB_VERSION}: {char!r}")
            continue
        indices.append(index)
    return indices


def decode(indices: list[int]) -> str:
    chars: list[str] = []
    previous = 0
    for index in indices:
        if index != 0 and index != previous:
            chars.append(INDEX_TO_CHAR.get(index, ""))
        previous = index
    return "".join(chars)


def raw_round_trip(text: str) -> str:
    return "".join(INDEX_TO_CHAR[index] for index in encode(text, strict=True))
