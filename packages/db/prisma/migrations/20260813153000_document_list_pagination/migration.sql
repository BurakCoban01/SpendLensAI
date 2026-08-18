CREATE INDEX "DocumentFile_tenantId_workspaceId_createdAt_id_idx"
ON "DocumentFile"("tenantId", "workspaceId", "createdAt", "id");
