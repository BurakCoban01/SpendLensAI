@echo off
setlocal
if "%SAMPLES_PER_CATEGORY%"=="" set SAMPLES_PER_CATEGORY=12
if "%SEED%"=="" set SEED=42
python -m services.ocr.category_model.train --samples-per-category %SAMPLES_PER_CATEGORY% --seed %SEED%

