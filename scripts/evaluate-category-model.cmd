@echo off
setlocal
if "%DATA_PATH%"=="" set DATA_PATH=data/generated/category-smoke/expenses.csv
if "%MODEL_PATH%"=="" set MODEL_PATH=artifacts/models/category-smoke/category_model.joblib
if "%SPLIT%"=="" set SPLIT=test
if "%REPORT_PATH%"=="" set REPORT_PATH=artifacts/models/category-smoke/evaluation.json
python -m services.ocr.category_model.evaluate --data-path %DATA_PATH% --model-path %MODEL_PATH% --split %SPLIT% --report-path %REPORT_PATH%
