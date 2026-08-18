from __future__ import annotations

import unittest

from services.ocr.custom_model.normalization import normalize_for_extraction, normalize_raw_input
from services.ocr.custom_model.vocab import SUPPORTED_CHARACTERS, VOCAB_VERSION, raw_round_trip


class CustomVocabularyTests(unittest.TestCase):
    def test_every_supported_character_round_trips(self) -> None:
        self.assertEqual(VOCAB_VERSION, "tr-finance-v1")
        self.assertEqual(raw_round_trip(SUPPORTED_CHARACTERS), SUPPORTED_CHARACTERS)

    def test_turkish_i_distinctions_are_not_destroyed_in_raw_layer(self) -> None:
        text = "i İ ı I ç ğ ö ş ü Ç Ğ Ö Ş Ü ₺"
        self.assertEqual(normalize_raw_input(text), text)
        self.assertEqual(raw_round_trip(text), text)

    def test_extraction_normalization_is_downstream_only(self) -> None:
        self.assertEqual(normalize_for_extraction("FIS NO: 1\nTARIH 16.06.2026\nT0PLAM 12.50 TL"), "FİŞ NO: 1\nTARİH 16.06.2026\nTOPLAM 12,50 TL")

    def test_extraction_normalization_does_not_rewrite_identifiers_or_names(self) -> None:
        normalized = normalize_for_extraction("BILGI OFIS\nFIS NO FIS-2026-00001")
        self.assertEqual(normalized, "BILGI OFIS\nFİŞ NO FIS-2026-00001")

    def test_extraction_normalization_repairs_scoped_product_line_confusions(self) -> None:
        normalized = normalize_for_extraction("0:R0N KDV TUTAR\nS0T %10 32,50 TL\nS0T TEKNOLOJI")

        self.assertEqual(normalized, "ÜRÜN KDV TUTAR\nSÜT %10 32,50 TL\nS0T TEKNOLOJI")

    def test_extraction_normalization_repairs_scoped_character_model_confusions(self) -> None:
        normalized = normalize_for_extraction(
            "F,S N:0: SLP2026P0001\n"
            "TAR,H: 02.06.2026\n"
            "SUT 0K010 32.50 TL\n"
            "SENEL TOPLAM 72.05 TL\n"
            "PARA B,R,M,: TRV 1 TL"
        )

        self.assertEqual(
            normalized,
            "FİŞ NO: SLP2026P0001\n"
            "TARİH: 02.06.2026\n"
            "SÜT %10 32,50 TL\n"
            "GENEL TOPLAM 72,05 TL\n"
            "PARA BİRİMİ: TRY / TL",
        )

    def test_extraction_normalization_repairs_scoped_pdf_structure_confusions(self) -> None:
        normalized = normalize_for_extraction(
            "E.ARS,VSANDBOX\n"
            "FATURA N::: EARS202600001\n"
            "TAR.1H: 02.06.2026\n"
            "SAT,C,: SPENDLENS MARKET SANDDOX\n"
            "RN TOLA 600,00 TL\n"
            "PARAB.1R.1M.1: TRV1TL"
        )

        self.assertEqual(
            normalized,
            "E-ARŞİV SANDBOX\n"
            "FATURA NO: EARS202600001\n"
            "TARİH: 02.06.2026\n"
            "SATICI: SPENDLENS MARKET SANDBOX\n"
            "GENEL TOPLAM 600,00 TL\n"
            "PARA BİRİMİ: TRY / TL",
        )

    def test_extraction_normalization_cleans_webp_line_prefixes_before_structure_repairs(self) -> None:
        normalized = normalize_for_extraction(
            "1 SPENDLENS MARKET SANDBOX\n"
            ", F,S N:0: SLP2026P0001\n"
            ", TAR,H: 0210612026\n"
            ", SENEL TOPLAM 72,05 TL"
        )

        self.assertEqual(
            normalized,
            "SPENDLENS MARKET SANDBOX\n"
            "FİŞ NO: SLP2026P0001\n"
            "TARİH: 02.06.2026\n"
            "GENEL TOPLAM 72,05 TL",
        )

if __name__ == "__main__":
    unittest.main()
