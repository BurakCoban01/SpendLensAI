import { spawn } from "node:child_process";

const tests = [
  "services.ocr.tests.test_custom_vocab",
  "services.ocr.tests.test_custom_segmentation",
  "services.ocr.tests.test_custom_fourier_features",
  "services.ocr.tests.test_custom_char_cnn",
  "services.ocr.tests.test_custom_numeric_field_recognizer",
  "services.ocr.tests.test_stage_diagnostics",
  "services.ocr.tests.test_recognizer_comparison",
  "services.ocr.tests.test_custom_model",
  "services.ocr.tests.test_custom_infer_pipeline"
];

const child = spawn(
  process.env.PYTHON || "python",
  ["-m", "unittest", ...tests, "-v"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONIOENCODING: "utf-8",
      OMP_NUM_THREADS: process.env.OMP_NUM_THREADS ?? "1",
      MKL_NUM_THREADS: process.env.MKL_NUM_THREADS ?? "1"
    }
  }
);

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`Custom OCR tests terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
