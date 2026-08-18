# AI Categorization

SpendLens AI currently includes a local, deterministic baseline for category prediction and anomaly reason generation. It does not use paid AI APIs, paid OCR APIs or external services.

## Implemented Baseline

Code:

- `packages/shared/src/categorization.ts`
- `GET /expenses/:id/ai-analysis` for non-mutating preview
- `POST /expenses/:id/ai-analysis` for persisted analysis runs
- `MLCategoryPrediction` persistence through the expense repository
- `/expenses` UI analysis action

The baseline uses local keyword/rule matching over:

- expense title
- merchant name
- description
- payment method
- line item names when available
- amount and occurrence date
- workspace peer expenses for anomaly context

The API returns:

- predicted category key
- confidence score
- matched keywords
- explanation reasons
- anomaly reason codes
- persisted prediction metadata
- cache-hit status for repeated local inference over the same expense/peer fingerprint
- model metadata showing `externalServicesUsed: false`

Each persisted analysis call writes an `MLCategoryPrediction` row, ensures a tenant-scoped `ExpenseCategory` exists for the predicted category key, updates the analyzed expense `categoryId`, and writes an `expense.category_predicted` audit log. This keeps the feature inspectable in PostgreSQL instead of returning a transient-only result. The `GET` endpoint intentionally remains preview-only.

Repeated analysis can reuse the hot-state cache key:

```text
model-inference:<tenantId>:expense-category:<expenseId>:<fingerprint>
```

The fingerprint includes the analyzed expense, workspace peer context and local model version. Cache hits skip repeated local prediction/anomaly computation, while `POST /expenses/:id/ai-analysis` still writes durable prediction and audit records.

Supported category keys include:

- `market`
- `ulasim`
- `yemek`
- `akaryakit`
- `konaklama`
- `ofis`
- `saglik`
- `egitim`
- `abonelik`
- `kargo`
- `vergi_harc`
- `diger`

Implemented anomaly reason codes:

- `UNUSUALLY_HIGH_AMOUNT`
- `POSSIBLE_DUPLICATE`
- `WEEKEND_BUSINESS_EXPENSE`
- `NEGATIVE_AMOUNT`
- `MISSING_MERCHANT`
- `UNUSUAL_MERCHANT`

Predictions are assistive and must not be treated as absolute truth.

## Trainable Category Model

Implemented code:

- `services/ocr/category_model/dataset.py`
- `services/ocr/category_model/train.py`
- `services/ocr/category_model/evaluate.py`
- `services/ocr/category_model/infer.py`
- `scripts/train-category-smoke.sh`
- `scripts/train-category-smoke.cmd`
- `scripts/evaluate-category-model.sh`
- `scripts/evaluate-category-model.cmd`
- `GET /models`
- `POST /models/category/smoke-train`
- `POST /models/custom-ocr/smoke-train`
- `POST /models/:id/promote`
- `/models` UI

The trainable model is a local scikit-learn pipeline:

- TF-IDF features over merchant, description, payment method, amount bucket and weekday/weekend signal
- logistic regression classifier with deterministic seed
- generated synthetic expense dataset with train/validation/test splits
- saved `category_model.joblib` artifact
- saved `metrics.json` and evaluation reports
- accuracy, macro F1, classification report and confusion matrix
- local inference returning ranked category candidates and confidence values

Smoke commands:

```bash
scripts/train-category-smoke.sh
scripts/evaluate-category-model.sh
```

On Windows:

```cmd
scripts\train-category-smoke.cmd
scripts\evaluate-category-model.cmd
```

Generated datasets and model artifacts are written under ignored `data/generated/` and `artifacts/` paths. The synthetic smoke metrics can be high because the generated dataset is intentionally small and regular; they must not be treated as production accuracy.

The API model registry wraps the smoke training command with real tenant-scoped persistence. Category versions use the `CATEGORY_ML` engine code so promotion state is separated from OCR engines. A successful run records:

- `ModelTrainingRun` status, profile, seed, metrics and logs key
- `ModelVersion` name, engine, artifact location, status and metrics
- `ModelEvaluationRun` metrics and report key
- outbox events for `model.training.started`, `model.training.completed` and `model.evaluation.completed`

The `/models` dashboard reads the same registry, starts category smoke training, starts custom OCR CRNN/CTC smoke training, displays accuracy, macro F1, custom OCR smoke loss and confusion matrix output, lists run history and promotes candidate versions to active when the signed-in user has `models.promote`.

## Pending ML Work

Remaining work:

- rollback flow for active models
- full local training profile wiring from the dashboard
- model comparison against broader benchmark datasets
- benchmark history and regression tests over broader datasets
