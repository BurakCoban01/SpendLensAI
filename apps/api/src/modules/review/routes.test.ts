import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app";
import { InMemoryAuthRepository } from "../auth/memory-repository";
import { InMemoryDocumentRepository } from "../documents/memory-repository";
import { InMemoryDocumentStorage } from "../documents/storage";
import { InMemoryReviewRepository } from "./memory-repository";

describe("review and annotation routes", () => {
  let app: FastifyInstance;
  let accessToken: string;
  let userId: string;
  let reviewerUserId: string;
  let employeeUserId: string;
  let documentRepository: InMemoryDocumentRepository;
  let reviewRepository: InMemoryReviewRepository;
  let documentId: string;

  beforeAll(async () => {
    documentRepository = new InMemoryDocumentRepository();
    reviewRepository = new InMemoryReviewRepository();
    const authRepository = new InMemoryAuthRepository();
    app = await buildApp({
      authRepository,
      documentRepository,
      documentStorage: new InMemoryDocumentStorage(),
      reviewRepository
    });
    const register = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        tenantName: "Review Tenant",
        tenantSlug: "review",
        workspaceName: "Finance",
        email: "owner@example.com",
        displayName: "Owner",
        password: "very-secure-password"
      }
    });
    const body = register.json();
    accessToken = body.tokens.accessToken;
    userId = body.user.id;
    reviewerUserId = authRepository.addUserWithRoles({
      tenantId: body.tenant.id,
      email: "reviewer@example.com",
      displayName: "Queue Reviewer",
      roles: ["REVIEWER"]
    }).id;
    employeeUserId = authRepository.addUserWithRoles({
      tenantId: body.tenant.id,
      email: "employee@example.com",
      displayName: "Employee",
      roles: ["EMPLOYEE"]
    }).id;
    documentRepository.addWorkspace(body.tenant.id, "workspace_1");
    documentId = await uploadDocument();
  });

  afterAll(async () => {
    await app.close();
  });

  it("creates, lists, approves and rejects tenant-scoped review tasks", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/documents/${documentId}/review-tasks`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        reasonCodes: ["low confidence", "amount mismatch"],
        dueAt: "2026-05-20T10:00:00.000Z"
      }
    });

    expect(created.statusCode).toBe(201);
    const task = created.json();
    expect(task.reasonCodes).toEqual(["LOW_CONFIDENCE", "AMOUNT_MISMATCH"]);
    expect(task.status).toBe("QUEUED");

    const reviewers = await app.inject({
      method: "GET",
      url: "/review/reviewers",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(reviewers.statusCode).toBe(200);
    expect(reviewers.json().reviewers.map((reviewer: { id: string }) => reviewer.id)).toEqual(
      expect.arrayContaining([userId, reviewerUserId])
    );
    expect(reviewers.json().reviewers.map((reviewer: { id: string }) => reviewer.id)).not.toContain(employeeUserId);

    const assignedToReviewer = await app.inject({
      method: "POST",
      url: `/review/tasks/${task.id}/assign`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { assignedToId: reviewerUserId }
    });
    expect(assignedToReviewer.statusCode).toBe(200);
    expect(assignedToReviewer.json().assignedToId).toBe(reviewerUserId);

    const ineligibleAssignment = await app.inject({
      method: "POST",
      url: `/review/tasks/${task.id}/assign`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { assignedToId: employeeUserId }
    });
    expect(ineligibleAssignment.statusCode).toBe(400);
    expect(ineligibleAssignment.json().error.code).toBe("REVIEW_ASSIGNEE_NOT_ELIGIBLE");

    const assigned = await app.inject({
      method: "POST",
      url: `/review/tasks/${task.id}/assign`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {}
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json().assignedToId).toBe(userId);

    const assignedList = await app.inject({
      method: "GET",
      url: `/review/tasks?workspaceId=workspace_1&assignedToId=${encodeURIComponent(userId)}`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(assignedList.statusCode).toBe(200);
    expect(assignedList.json().reviewTasks[0].task.id).toBe(task.id);

    const unassigned = await app.inject({
      method: "POST",
      url: `/review/tasks/${task.id}/assign`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { assignedToId: null }
    });
    expect(unassigned.statusCode).toBe(200);
    expect(unassigned.json().assignedToId).toBeNull();

    const list = await app.inject({
      method: "GET",
      url: "/review/tasks?workspaceId=workspace_1&status=QUEUED",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().reviewTasks[0].task.id).toBe(task.id);
    expect(list.json().reviewTasks[0].document.id).toBe(documentId);

    const boundedList = await app.inject({
      method: "GET",
      url: "/review/tasks?workspaceId=workspace_1&limit=1",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(boundedList.statusCode).toBe(200);
    expect(boundedList.json().reviewTasks).toHaveLength(1);

    const excessiveLimit = await app.inject({
      method: "GET",
      url: "/review/tasks?workspaceId=workspace_1&limit=101",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(excessiveLimit.statusCode).toBe(400);
    expect(excessiveLimit.json().error.code).toBe("VALIDATION_ERROR");

    const completed = await app.inject({
      method: "POST",
      url: `/review/tasks/${task.id}/complete`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().status).toBe("SUCCEEDED");

    const rejectable = await app.inject({
      method: "POST",
      url: `/documents/${documentId}/review-tasks`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { reasonCodes: ["OCR_CONFLICT"] }
    });
    const rejected = await app.inject({
      method: "POST",
      url: `/review/tasks/${rejectable.json().id}/reject`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { rejectionReason: "Totals still conflict after correction." }
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().status).toBe("FAILED");

    const failed = await app.inject({
      method: "GET",
      url: "/review/tasks?workspaceId=workspace_1&status=FAILED",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(failed.statusCode).toBe(200);
    expect(failed.json().reviewTasks[0].task.id).toBe(rejectable.json().id);

    const dueSoonTask = await app.inject({
      method: "POST",
      url: `/documents/${documentId}/review-tasks`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        reasonCodes: ["SLA_DUE_SOON"],
        assignedToId: reviewerUserId,
        dueAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
      }
    });
    expect(dueSoonTask.statusCode).toBe(201);
    const overdueTask = await app.inject({
      method: "POST",
      url: `/documents/${documentId}/review-tasks`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        reasonCodes: ["SLA_OVERDUE"],
        dueAt: new Date(Date.now() - 60 * 60 * 1000).toISOString()
      }
    });
    expect(overdueTask.statusCode).toBe(201);

    const workload = await app.inject({
      method: "GET",
      url: "/review/workload?workspaceId=workspace_1",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(workload.statusCode).toBe(200);
    const reviewerSummary = workload.json().reviewers.find((item: { reviewer: { id: string } }) => item.reviewer.id === reviewerUserId);
    expect(reviewerSummary).toMatchObject({ queued: 1, dueSoon: 1, overdue: 0 });
    expect(workload.json().unassigned).toMatchObject({ queued: 1, overdue: 1 });
    expect(workload.json().totals).toMatchObject({ queued: 2, overdue: 1, dueSoon: 1 });

    const rebalancing = await app.inject({
      method: "GET",
      url: "/review/rebalance-suggestions?workspaceId=workspace_1",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(rebalancing.statusCode).toBe(200);
    expect(rebalancing.json().suggestions[0]).toMatchObject({
      action: "ASSIGN",
      reasonCode: "SLA_OVERDUE_UNASSIGNED",
      currentAssigneeId: null,
      targetReviewer: { id: userId },
      task: { id: overdueTask.json().id }
    });

    const dryRunEscalation = await app.inject({
      method: "POST",
      url: "/review/escalations/run",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { workspaceId: "workspace_1", dryRun: true, maxActions: 1 }
    });
    expect(dryRunEscalation.statusCode).toBe(200);
    expect(dryRunEscalation.json().dryRun).toBe(true);
    expect(dryRunEscalation.json().planned[0]).toMatchObject({
      reasonCode: "SLA_OVERDUE_UNASSIGNED",
      task: { id: overdueTask.json().id },
      escalationReasonCodes: ["SLA_ESCALATED", "SLA_OVERDUE_UNASSIGNED"]
    });
    expect(dryRunEscalation.json().applied).toEqual([]);

    const escalation = await app.inject({
      method: "POST",
      url: "/review/escalations/run",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { workspaceId: "workspace_1", maxActions: 1 }
    });
    expect(escalation.statusCode).toBe(200);
    expect(escalation.json().dryRun).toBe(false);
    expect(escalation.json().applied[0]).toMatchObject({
      task: {
        id: overdueTask.json().id,
        assignedToId: userId,
        reasonCodes: expect.arrayContaining(["SLA_OVERDUE", "SLA_ESCALATED", "SLA_OVERDUE_UNASSIGNED"])
      },
      targetReviewer: { id: userId }
    });
    const taskAudit = await app.inject({
      method: "GET",
      url: `/admin/audit?resourceType=OCRReviewTask&limit=40`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(taskAudit.statusCode).toBe(200);
    expect(taskAudit.json().logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "review.task.created", resourceId: task.id }),
        expect.objectContaining({ action: "review.task.assigned", resourceId: task.id }),
        expect.objectContaining({ action: "review.task.completed", resourceId: task.id }),
        expect.objectContaining({ action: "review.task.rejected", resourceId: rejectable.json().id }),
        expect.objectContaining({ action: "review.task.escalated", resourceId: overdueTask.json().id })
      ])
    );
    expect(JSON.stringify(taskAudit.json().logs)).not.toContain("Totals still conflict after correction.");

    const suggestedAssignment = await app.inject({
      method: "POST",
      url: `/review/tasks/${overdueTask.json().id}/assign`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { assignedToId: rebalancing.json().suggestions[0].targetReviewer.id }
    });
    expect(suggestedAssignment.statusCode).toBe(200);
    expect(suggestedAssignment.json().assignedToId).toBe(userId);
  });

  it("records corrections, creates annotation data and queues active learning", async () => {
    const correction = await app.inject({
      method: "POST",
      url: `/documents/${documentId}/corrections`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        fieldName: "total",
        beforeValue: "7905",
        afterValue: "7205",
        createAnnotation: true,
        annotationLabel: "corrected_total"
      }
    });

    expect(correction.statusCode).toBe(201);
    const body = correction.json();
    expect(body.correction.afterValue).toBe("7205");
    expect(body.annotation.label).toBe("corrected_total");
    expect(body.suggestion.reasonCode).toBe("HUMAN_CORRECTION");

    const corrections = await app.inject({
      method: "GET",
      url: `/documents/${documentId}/corrections`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(corrections.statusCode).toBe(200);
    expect(corrections.json().corrections[0].fieldName).toBe("total");

    const suggestions = await app.inject({
      method: "GET",
      url: "/active-learning/suggestions?workspaceId=workspace_1",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(suggestions.statusCode).toBe(200);
    expect(suggestions.json().suggestions[0].documentFileId).toBe(documentId);

    const audit = await app.inject({
      method: "GET",
      url: `/admin/audit?action=ocr.correction.created&resourceType=OCRCorrection&limit=10`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceId: body.correction.id,
          metadata: expect.objectContaining({
            documentFileId: documentId,
            workspaceId: "workspace_1",
            fieldName: "total",
            beforeValuePresent: true,
            afterValuePresent: true,
            annotationId: body.annotation.id,
            activeLearningSuggestionId: body.suggestion.id
          })
        })
      ])
    );
    const auditBody = audit.json<{
      logs: Array<{ resourceId: string; metadata?: Record<string, unknown> }>;
    }>();
    const correctionAudit = auditBody.logs.find((entry) => entry.resourceId === body.correction.id);
    expect(correctionAudit?.metadata).not.toHaveProperty("beforeValue");
    expect(correctionAudit?.metadata).not.toHaveProperty("afterValue");
    expect(correctionAudit?.metadata).not.toHaveProperty("annotationLabel");
  });

  it("records direct bounding-box annotations for reviewed OCR tokens", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/documents/${documentId}/annotations`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        label: "ocr_bbox_total",
        payload: {
          type: "ocr_bbox_annotation",
          engine: "TESSERACT",
          text: "TOPLAM",
          pageNumber: 1,
          bbox: [18, 140, 76, 20],
          confidence: 0.91
        }
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().label).toBe("ocr_bbox_total");
    expect(created.json().payload.bbox).toEqual([18, 140, 76, 20]);

    const annotations = await app.inject({
      method: "GET",
      url: `/documents/${documentId}/annotations`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(annotations.statusCode).toBe(200);
    expect(annotations.json().annotations[0]).toMatchObject({
      documentFileId: documentId,
      label: "ocr_bbox_total"
    });

    const audit = await app.inject({
      method: "GET",
      url: `/admin/audit?action=annotation.created&resourceType=Annotation&limit=10`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(audit.statusCode).toBe(200);
    const annotationAudit = audit.json().logs.find((log: { resourceId: string }) => log.resourceId === created.json().id);
    expect(annotationAudit).toMatchObject({
      metadata: {
        documentFileId: documentId,
        workspaceId: "workspace_1",
        label: "ocr_bbox_total",
        payloadType: "object"
      }
    });
    expect(JSON.stringify(annotationAudit)).not.toContain("TOPLAM");
    expect(JSON.stringify(annotationAudit)).not.toContain("\"bbox\":");
  });

  it("records multi-token and multi-page OCR annotations for training export review", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/documents/${documentId}/annotations`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        label: "ocr_multi_page_total_context",
        payload: {
          type: "ocr_multi_token_annotation",
          engine: "TESSERACT",
          text: "ARA TOPLAM KDV TOPLAM",
          pageNumbers: [1, 2],
          bbox: null,
          confidence: 0.83,
          tokens: [
            { engine: "TESSERACT", text: "ARA", pageNumber: 1, bbox: [16, 118, 34, 18], confidence: 0.88 },
            { engine: "TESSERACT", text: "TOPLAM", pageNumber: 1, bbox: [54, 118, 68, 18], confidence: 0.86 },
            { engine: "TESSERACT", text: "KDV", pageNumber: 2, bbox: [18, 44, 42, 18], confidence: 0.79 },
            { engine: "TESSERACT", text: "TOPLAM", pageNumber: 2, bbox: [64, 44, 72, 18], confidence: 0.8 }
          ]
        }
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().payload).toMatchObject({
      type: "ocr_multi_token_annotation",
      pageNumbers: [1, 2],
      tokens: [
        { text: "ARA", pageNumber: 1 },
        { text: "TOPLAM", pageNumber: 1 },
        { text: "KDV", pageNumber: 2 },
        { text: "TOPLAM", pageNumber: 2 }
      ]
    });

    const annotations = await app.inject({
      method: "GET",
      url: `/documents/${documentId}/annotations`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(annotations.statusCode).toBe(200);
    expect(
      annotations
        .json()
        .annotations.some(
          (annotation: { label: string; payload: { type?: string; pageNumbers?: number[]; tokens?: unknown[] } }) =>
            annotation.label === "ocr_multi_page_total_context" &&
            annotation.payload.type === "ocr_multi_token_annotation" &&
            annotation.payload.pageNumbers?.length === 2 &&
            annotation.payload.tokens?.length === 4
        )
    ).toBe(true);

    const audit = await app.inject({
      method: "GET",
      url: `/admin/audit?action=annotation.created&resourceType=Annotation&limit=20`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(audit.statusCode).toBe(200);
    const annotationAudit = audit.json().logs.find((log: { resourceId: string }) => log.resourceId === created.json().id);
    expect(annotationAudit).toMatchObject({
      metadata: {
        documentFileId: documentId,
        workspaceId: "workspace_1",
        label: "ocr_multi_page_total_context",
        payloadType: "object",
        payloadKind: "OCR_MULTI_TOKEN_ANNOTATION",
        engine: "TESSERACT",
        pageCount: 2,
        tokenCount: 4,
        hasBoundingBoxes: true
      }
    });
    const serializedAudit = JSON.stringify(annotationAudit);
    expect(serializedAudit).not.toContain("ARA TOPLAM KDV TOPLAM");
    expect(serializedAudit).not.toContain("\"tokens\"");
    expect(serializedAudit).not.toContain("\"bbox\"");
    expect(serializedAudit).not.toContain("[16,118,34,18]");
  });

  it("rejects review creation for missing documents", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/documents/missing/review-tasks",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { reasonCodes: ["LOW_CONFIDENCE"] }
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("DOCUMENT_NOT_FOUND");
  });

  async function uploadDocument(): Promise<string> {
    const upload = await app.inject({
      method: "POST",
      url: "/documents/upload?workspaceId=workspace_1&kind=RECEIPT",
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...multipartHeaders("boundary")
      },
      payload: multipartBody("boundary", "receipt.png", "image/png", pngBytes())
    });
    expect(upload.statusCode).toBe(201);
    return upload.json().document.id;
  }
});

function pngBytes(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
}

function multipartHeaders(boundary: string) {
  return { "content-type": `multipart/form-data; boundary=${boundary}` };
}

function multipartBody(boundary: string, filename: string, mimeType: string, content: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      [
        `--${boundary}`,
        `Content-Disposition: form-data; name="file"; filename="${filename}"`,
        `Content-Type: ${mimeType}`,
        "",
        ""
      ].join("\r\n")
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
}
