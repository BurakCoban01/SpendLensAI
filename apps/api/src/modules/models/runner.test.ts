import { afterEach, describe, expect, it, vi } from "vitest";
import {
  customOcrDatasetArgsForManifests,
  customOcrHelperCheckpointArgs,
  ocrServiceCustomOcrTrainingRunner,
  pythonExecOptions
} from "./runner";

describe("model training runners", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sets stable Python environment variables for local runners", () => {
    const options = pythonExecOptions();

    expect(options.cwd).toBeTruthy();
    expect(options.env.PYTHONPATH).toContain(options.cwd);
    expect(options.env.PYTHONIOENCODING).toBe("utf-8");
    expect(options.env.OMP_NUM_THREADS).toBe("1");
    expect(options.env.MKL_NUM_THREADS).toBe("1");
  });

  it("uses combined Custom OCR manifests for full training when they are available", () => {
    expect(customOcrDatasetArgsForManifests(true, "artifacts/datasets/custom-ocr")).toEqual([
      "--dataset-mode",
      "combined_manifest",
      "--combined-manifest-dir",
      "artifacts/datasets/custom-ocr"
    ]);
    expect(customOcrDatasetArgsForManifests(false)).toEqual(["--dataset-mode", "document_lines"]);
  });

  it("benchmarks the same default helper checkpoints used by the Custom OCR runtime", () => {
    expect(customOcrHelperCheckpointArgs({}, () => true)).toEqual([
      "--numeric-char-checkpoint",
      "artifacts/models/local-full-20260620-ocr/numeric-char-cnn-v1/char-cnn.pt",
      "--character-checkpoint",
      "artifacts/models/custom-char-cnn-project-real-v1/char-cnn.pt"
    ]);
    expect(
      customOcrHelperCheckpointArgs(
        {
          CUSTOM_OCR_NUMERIC_CHAR_CHECKPOINT: "artifacts/models/numeric/model.pt",
          CUSTOM_OCR_CHARACTER_CHECKPOINT: "artifacts/models/character/model.pt"
        },
        () => false
      )
    ).toEqual([
      "--numeric-char-checkpoint",
      "artifacts/models/numeric/model.pt",
      "--character-checkpoint",
      "artifacts/models/character/model.pt"
    ]);
    expect(
      customOcrHelperCheckpointArgs(
        {
          CUSTOM_OCR_CRNN_CHALLENGER_CHECKPOINT: "artifacts/models/challenger/model.pt",
          CUSTOM_OCR_CRNN_CHALLENGER_MODE: "validated"
        },
        () => false
      )
    ).toContain("--challenger-checkpoint");
    expect(
      customOcrHelperCheckpointArgs(
        {
          CUSTOM_OCR_CRNN_CHALLENGER_CHECKPOINT: "artifacts/models/challenger/model.pt",
          CUSTOM_OCR_CRNN_CHALLENGER_MODE: "validated"
        },
        () => false
      )
    ).toEqual([
      "--challenger-checkpoint",
      "artifacts/models/challenger/model.pt",
      "--challenger-mode",
      "validated"
    ]);
  });

  it("delegates custom OCR smoke training to the OCR service when configured", async () => {
    const fetchMock = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      expect(String(_url)).toBe("http://ocr-service:8000/models/custom-ocr/smoke-train");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        tenant_id: "tenant_1",
        training_run_id: "run_1",
        seed: 7,
        samples: 8,
        epochs: 1
      });
      return new Response(
        JSON.stringify({
          metrics: { loss: 2.5, accuracy_note: "Smoke training only; not production accurate." },
          artifactBucket: "local-artifacts",
          artifactKey: "artifacts/models/custom-ocr-api/tenant_1-run_1",
          reportKey: "artifacts/models/custom-ocr-api/tenant_1-run_1/metrics.json"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const runner = ocrServiceCustomOcrTrainingRunner("http://ocr-service:8000");
    const result = await runner({
      tenantId: "tenant_1",
      trainingRunId: "run_1",
      seed: 7,
      samples: 8,
      epochs: 1
    });

    expect(result).toEqual({
      metrics: {
        loss: 2.5,
        accuracy_note: "Smoke training only; not production accurate.",
        model: "custom-crnn-ctc",
        engine: "CUSTOM_CRNN",
        seed: 7,
        training_profile: "custom-ocr-smoke"
      },
      artifactBucket: "local-artifacts",
      artifactKey: "artifacts/models/custom-ocr-api/tenant_1-run_1",
      reportKey: "artifacts/models/custom-ocr-api/tenant_1-run_1/metrics.json"
    });
  });

  it("fails clearly when the OCR service training response is invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ metrics: {} }), { status: 200, headers: { "content-type": "application/json" } }))
    );

    const runner = ocrServiceCustomOcrTrainingRunner("http://ocr-service:8000");
    await expect(
      runner({
        tenantId: "tenant_1",
        trainingRunId: "run_1",
        seed: 7,
        samples: 8,
        epochs: 1
      })
    ).rejects.toThrow("OCR_SERVICE_CUSTOM_OCR_TRAINING_INVALID_RESPONSE");
  });

  it("falls back to local custom OCR full training when the OCR service full route is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 404 })));
    const fallback = vi.fn(async () => ({
      metrics: { loss: 1.2, training_profile: "custom-ocr-full-local" },
      artifactBucket: "local-artifacts",
      artifactKey: "artifacts/models/custom-ocr-api/fallback",
      reportKey: "artifacts/models/custom-ocr-api/fallback/metrics.json"
    }));

    const runner = ocrServiceCustomOcrTrainingRunner("http://ocr-service:8000", fallback);
    const result = await runner({
      tenantId: "tenant_1",
      trainingRunId: "run_1",
      seed: 7,
      samples: 128,
      epochs: 5,
      profile: "custom-ocr-full-local"
    });

    expect(fallback).toHaveBeenCalledWith({
      tenantId: "tenant_1",
      trainingRunId: "run_1",
      seed: 7,
      samples: 128,
      epochs: 5,
      profile: "custom-ocr-full-local"
    });
    expect(result.metrics.ocr_service_fallback).toMatchObject({
      used: true,
      note: expect.stringContaining("/models/custom-ocr/full-train returned 404")
    });
  });
});
