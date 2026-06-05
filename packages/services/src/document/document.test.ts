import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import prisma from "@rw/db";
import * as documents from "./index.js";

const storageMock = vi.hoisted(() => ({
  isStorageEnabled: vi.fn(() => true),
  validateDocumentUpload: vi.fn(() => null),
  generateDocumentKey: vi.fn((documentId: string, filename: string) => `documents/${documentId}/mock-${filename}`),
  getPresignedUploadUrl: vi.fn(async () => "https://storage.test/upload"),
  objectExists: vi.fn(async () => true),
  getPresignedDownloadUrl: vi.fn(async () => "https://storage.test/download"),
  deleteObjects: vi.fn(async () => undefined),
}));

vi.mock("@rw/runtime/storage", () => storageMock);

describe("document service", () => {
  let workspaceId: string;
  let siteId: string;
  let databaseInitialized = false;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is required to run document service tests");
    }
    databaseInitialized = true;

    const suffix = randomUUID();
    const workspace = await prisma.workspace.create({
      data: {
        name: `Document Test ${suffix}`,
        slug: `document-test-${suffix}`,
      },
    });
    const site = await prisma.site.create({
      data: {
        name: `Document Test Site ${suffix}`,
        workspaceId: workspace.id,
      },
    });

    workspaceId = workspace.id;
    siteId = site.id;
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    if (!databaseInitialized) return;

    if (workspaceId) {
      await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    }
    await prisma.$disconnect();
  });

  test("manages a labeled file lifecycle without writing to real storage", async () => {
    const folderResult = await documents.createFolder({
      name: "Manuals",
      siteId,
      workspaceId,
      labels: ["Operator Manual", "operator manual", "Safety!!"],
    });
    if ("error" in folderResult) throw new Error(folderResult.error);

    expect(folderResult.data.kind).toBe("FOLDER");
    expect(folderResult.data.labels).toEqual(["operator-manual", "safety"]);

    const body = Buffer.from("# Operator Manual\n");
    const uploadResult = await documents.createUpload({
      name: "Press Operator Manual",
      filename: "press-manual.md",
      contentType: "text/markdown",
      size: body.length,
      siteId,
      parentId: folderResult.data.id,
      workspaceId,
      labels: ["Operator Manual", "AI Context", "operator-manual"],
    });
    if ("error" in uploadResult) throw new Error(uploadResult.error);

    const uploadedDocument = uploadResult.data.document;
    const storageKey = `documents/${uploadedDocument.id}/mock-press-manual.md`;

    expect(uploadResult.data.uploadUrl).toBe("https://storage.test/upload");
    expect(uploadedDocument.kind).toBe("FILE");
    expect(uploadedDocument.status).toBe("PENDING_UPLOAD");
    expect(uploadedDocument.storageKey).toBe(storageKey);
    expect(uploadedDocument.labels).toEqual(["operator-manual", "ai-context"]);
    expect(storageMock.getPresignedUploadUrl).toHaveBeenCalledWith(storageKey, "text/markdown", body.length);

    const completeResult = await documents.completeUpload(uploadedDocument.id);
    if ("error" in completeResult) throw new Error(completeResult.error);

    expect(completeResult.data.status).toBe("READY");
    expect(storageMock.objectExists).toHaveBeenCalledWith(storageKey);

    const listAny = await documents.list({
      parentId: folderResult.data.id,
      labelsAny: ["Operator Manual"],
    });
    expect(listAny.data.map((document) => document.id)).toContain(uploadedDocument.id);

    const listAll = await documents.list({
      parentId: folderResult.data.id,
      labelsAll: ["Operator Manual", "AI Context"],
    });
    expect(listAll.data.map((document) => document.id)).toContain(uploadedDocument.id);

    const updateResult = await documents.update(uploadedDocument.id, {
      labels: ["Operator Manual", "AI Context", "Setup Sheet"],
    });
    if ("error" in updateResult) throw new Error(updateResult.error);
    expect(updateResult.data.labels).toEqual(["operator-manual", "ai-context", "setup-sheet"]);

    const linkResult = await documents.link(uploadedDocument.id, "SITE", siteId);
    if ("error" in linkResult) throw new Error(linkResult.error);

    const targetResult = await documents.listForTarget("SITE", siteId, { labelsAll: ["setup sheet"] });
    expect(targetResult.data.map((document) => document.id)).toContain(uploadedDocument.id);

    const downloadResult = await documents.getDownloadUrl(uploadedDocument.id);
    if ("error" in downloadResult) throw new Error(downloadResult.error);

    expect(downloadResult.data.url).toBe("https://storage.test/download");
    expect(storageMock.getPresignedDownloadUrl).toHaveBeenCalledWith(storageKey, {
      disposition: "attachment",
      filename: "press-manual.md",
      contentType: "text/markdown",
    });

    const openResult = await documents.getOpenUrl(uploadedDocument.id);
    if ("error" in openResult) throw new Error(openResult.error);

    expect(openResult.data.url).toBe("https://storage.test/download");
    expect(storageMock.getPresignedDownloadUrl).toHaveBeenCalledWith(storageKey, {
      disposition: "inline",
      filename: "press-manual.md",
      contentType: "text/markdown",
    });

    const removeResult = await documents.remove(folderResult.data.id);
    if ("error" in removeResult) throw new Error(removeResult.error);

    expect(removeResult.success).toBe(true);
    expect(storageMock.deleteObjects).toHaveBeenCalledWith([storageKey]);

    const deleted = await documents.getById(uploadedDocument.id, { includePending: true });
    expect(deleted).toBeNull();
  });
});
