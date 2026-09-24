import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import prisma, { ensureAccountWorkspace } from "@rw/db";
import * as documents from "./index.js";
import * as jobs from "../job/job.js";
import * as tools from "../job/tool.js";
import * as products from "../inventory/product.js";
import * as materials from "../inventory/material.js";

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

/**
 * Delete a test site's master data in dependency order (these relations
 * restrict rather than cascade), then the site itself.
 */
async function removeSiteRecords(siteId: string) {
  await prisma.station.updateMany({ where: { siteId }, data: { currentJobId: null } });
  const jobs = { job: { siteId } };
  await prisma.jobProduct.updateMany({ where: jobs, data: { currentVersionId: null } });
  await prisma.jobProductVersion.deleteMany({ where: { jobProduct: jobs } });
  await prisma.jobProduct.deleteMany({ where: jobs });
  await prisma.jobTool.deleteMany({ where: jobs });
  await prisma.job.updateMany({ where: { siteId }, data: { currentVersionId: null } });
  await prisma.jobVersion.deleteMany({ where: jobs });
  await prisma.job.deleteMany({ where: { siteId } });
  const products = { product: { siteId } };
  await prisma.productMaterial.updateMany({ where: products, data: { currentVersionId: null } });
  await prisma.productMaterialVersion.deleteMany({ where: { productMaterial: products } });
  await prisma.productMaterial.deleteMany({ where: products });
  await prisma.product.updateMany({ where: { siteId }, data: { currentVersionId: null } });
  await prisma.productVersion.deleteMany({ where: products });
  await prisma.product.deleteMany({ where: { siteId } });
  await prisma.material.updateMany({ where: { siteId }, data: { currentVersionId: null } });
  await prisma.materialVersion.deleteMany({ where: { material: { siteId } } });
  await prisma.material.deleteMany({ where: { siteId } });
  await prisma.tool.updateMany({ where: { siteId }, data: { currentVersionId: null } });
  await prisma.toolVersion.deleteMany({ where: { tool: { siteId } } });
  await prisma.tool.deleteMany({ where: { siteId } });
  await prisma.site.delete({ where: { id: siteId } });
}

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
    const workspace = await ensureAccountWorkspace({ name: "Test Account", slug: "test-account" });
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

    // The account's workspace is shared; clean up this test's site only.
    if (siteId) {
      await prisma.site.deleteMany({ where: { id: siteId } });
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

    // The root listing never reaches into folders; allFolders spans the tree.
    const rootFiles = await documents.list({ siteId, kind: "FILE" });
    expect(rootFiles.data.map((document) => document.id)).not.toContain(uploadedDocument.id);
    const everyFile = await documents.list({ siteId, kind: "FILE", allFolders: true });
    expect(everyFile.data.map((document) => document.id)).toContain(uploadedDocument.id);
    expect(everyFile.data.every((document) => document.kind === "FILE")).toBe(true);

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

  test("keeps every uploaded version and serves the newest by default", async () => {
    const user = await prisma.user.create({
      data: { email: `docs-${randomUUID()}@example.test`, firstName: "Dana", lastName: "Reyes" },
    });
    let key = 0;
    storageMock.generateDocumentKey.mockImplementation(
      (documentId: string, filename: string) => `documents/${documentId}/${++key}-${filename}`,
    );

    try {
      const created = await documents.createUpload({
        filename: "setup.md",
        contentType: "text/markdown",
        size: 10,
        siteId,
        workspaceId,
        createdById: user.id,
      });
      if ("error" in created) throw new Error(created.error);
      const documentId = created.data.document.id;
      const v1Key = created.data.document.storageKey!;
      expect(created.data.document.version).toBe(1);
      await documents.completeUpload(documentId);

      // A new version of any type waits, unseen, until its bytes land.
      const v2 = await documents.createVersionUpload(documentId, {
        filename: "setup.pdf",
        contentType: "application/pdf",
        size: 2048,
        createdById: user.id,
      });
      if ("error" in v2) throw new Error(v2.error);
      expect(v2.data.version).toMatchObject({ version: 2, isCurrent: false, filename: "setup.pdf" });
      expect(v2.data.uploadUrl).toBe("https://storage.test/upload");

      const beforeComplete = await documents.getById(documentId);
      if (!beforeComplete || "error" in beforeComplete) throw new Error("missing document");
      expect(beforeComplete.data).toMatchObject({ filename: "setup.md", version: 1 });
      const pendingList = await documents.listVersions(documentId);
      if ("error" in pendingList) throw new Error(pendingList.error);
      expect(pendingList.data.map((file) => file.version)).toEqual([1]);

      const completed = await documents.completeVersionUpload(documentId, v2.data.version.id);
      if ("error" in completed) throw new Error(completed.error);
      expect(completed.data).toMatchObject({
        filename: "setup.pdf",
        contentType: "application/pdf",
        size: 2048,
        version: 2,
        status: "READY",
      });

      const history = await documents.listVersions(documentId);
      if ("error" in history) throw new Error(history.error);
      expect(history.data.map((file) => [file.version, file.isCurrent])).toEqual([
        [2, true],
        [1, false],
      ]);
      expect(history.data[0]?.createdBy).toEqual({ id: user.id, name: "Dana Reyes" });

      // Older versions stay downloadable under their own filename.
      const v1Id = history.data[1]!.id;
      const oldUrl = await documents.getVersionDownloadUrl(documentId, v1Id);
      if ("error" in oldUrl) throw new Error(oldUrl.error);
      expect(storageMock.getPresignedDownloadUrl).toHaveBeenLastCalledWith(v1Key, {
        disposition: "attachment",
        filename: "setup.md",
        contentType: "text/markdown",
      });

      // Search finds the document by its current file's name.
      const found = await documents.list({ siteId, q: "setup.pdf" });
      expect(found.data.map((document) => document.id)).toContain(documentId);

      // Any finished version can be made current again; nothing is lost.
      const rolledBack = await documents.setCurrentVersion(documentId, v1Id);
      if ("error" in rolledBack) throw new Error(rolledBack.error);
      expect(rolledBack.data).toMatchObject({ filename: "setup.md", version: 1 });
      const afterRollback = await documents.listVersions(documentId);
      if ("error" in afterRollback) throw new Error(afterRollback.error);
      expect(afterRollback.data.map((file) => [file.version, file.isCurrent])).toEqual([
        [2, false],
        [1, true],
      ]);
      const forward = await documents.setCurrentVersion(documentId, history.data[0]!.id);
      if ("error" in forward) throw new Error(forward.error);
      expect(forward.data).toMatchObject({ filename: "setup.pdf", version: 2 });
      const wrongDocument = await documents.setCurrentVersion(randomUUID(), v1Id);
      expect(wrongDocument).toMatchObject({ code: "DOCUMENT_NOT_FOUND" });
      const unknownVersion = await documents.setCurrentVersion(documentId, randomUUID());
      expect(unknownVersion).toMatchObject({ code: "VERSION_NOT_FOUND" });

      // An unfinished upload rolls back; a finished one cannot be cancelled.
      const v3 = await documents.createVersionUpload(documentId, {
        filename: "setup-v3.pdf",
        contentType: "application/pdf",
        size: 10,
      });
      if ("error" in v3) throw new Error(v3.error);
      expect(v3.data.version.version).toBe(3);
      const pendingCurrent = await documents.setCurrentVersion(documentId, v3.data.version.id);
      expect(pendingCurrent).toMatchObject({ code: "VERSION_NOT_FOUND" });
      const cancelled = await documents.cancelVersionUpload(documentId, v3.data.version.id);
      expect(cancelled).toEqual({ success: true });
      expect(storageMock.deleteObjects).toHaveBeenLastCalledWith([expect.stringContaining("setup-v3.pdf")]);
      const cancelReady = await documents.cancelVersionUpload(documentId, v1Id);
      expect(cancelReady).toMatchObject({ code: "VERSION_READY" });

      // Another document's version id is not reachable through this one.
      const otherVersion = await documents.getVersionOpenUrl(randomUUID(), v1Id);
      expect(otherVersion).toMatchObject({ code: "DOCUMENT_NOT_FOUND" });

      // Deleting the document removes every version's bytes.
      await documents.remove(documentId);
      const removedKeys = (storageMock.deleteObjects.mock.calls.at(-1) as unknown as [string[]])[0];
      expect(removedKeys).toHaveLength(2);
      expect(removedKeys).toContain(v1Key);
      expect(await prisma.documentFile.count({ where: { documentId } })).toBe(0);
    } finally {
      storageMock.generateDocumentKey.mockReset();
      storageMock.generateDocumentKey.mockImplementation(
        (documentId: string, filename: string) => `documents/${documentId}/mock-${filename}`,
      );
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("versions are only for ready files", async () => {
    const folder = await documents.createFolder({ name: "Binder", siteId, workspaceId });
    if ("error" in folder) throw new Error(folder.error);
    const onFolder = await documents.createVersionUpload(folder.data.id, {
      filename: "a.pdf",
      contentType: "application/pdf",
      size: 1,
    });
    expect(onFolder).toMatchObject({ code: "NOT_FILE" });

    const pending = await documents.createUpload({
      filename: "b.pdf",
      contentType: "application/pdf",
      size: 1,
      siteId,
      workspaceId,
    });
    if ("error" in pending) throw new Error(pending.error);
    const onPending = await documents.createVersionUpload(pending.data.document.id, {
      filename: "c.pdf",
      contentType: "application/pdf",
      size: 1,
    });
    expect(onPending).toMatchObject({ code: "DOCUMENT_PENDING" });
  });

  test("resolves a station's knowledge context through its job, most specific first", async () => {
    const ok = <T>(result: { data?: T; error?: string }): T => {
      if (result.error !== undefined || result.data === undefined) throw new Error(result.error ?? "no data");
      return result.data;
    };
    const suffix = randomUUID().slice(0, 8);
    // Its own site: jobs, tools, products and materials restrict site deletes,
    // so this test removes what it made itself (below) before the site goes.
    const siteId = (await prisma.site.create({ data: { name: `Context Site ${suffix}`, workspaceId } })).id;
    try {
      const workcenter = await prisma.workcenter.create({ data: { name: `WC ${suffix}`, siteId } });
      const station = await prisma.station.create({
        data: { name: `Press ${suffix}`, siteId, workcenterId: workcenter.id },
      });
      const tool = ok(await tools.create({ siteId, name: `Mold ${suffix}` }));
      const material = ok(await materials.create({ siteId, materialNumber: `PP-${suffix}`, name: "Polypropylene" }));
      const product = ok(await products.create({ siteId, sku: `CAP-${suffix}`, name: "Cap" }));
      ok(await products.addMaterial({ productId: product.id, materialId: material.id }));
      const job = ok(await jobs.create({ siteId, name: `Job ${suffix}` }));
      ok(await jobs.addTool({ jobId: job.id, toolId: tool.id }));
      ok(await jobs.addItem({ jobId: job.id, productId: product.id }));
      const otherJob = ok(await jobs.create({ siteId, name: `Other ${suffix}` }));

      const upload = async (name: string) => {
        const created = ok(
          await documents.createUpload({
            filename: `${name}.pdf`,
            contentType: "application/pdf",
            size: 1,
            siteId,
            workspaceId,
          }),
        );
        ok(await documents.completeUpload(created.document.id));
        return created.document.id;
      };
      const setupSheet = await upload("setup-sheet");
      const moldManual = await upload("mold-manual");
      const resinSds = await upload("resin-sds");
      const sitePolicy = await upload("site-policy");
      const otherJobSheet = await upload("other-job-sheet");
      const binder = ok(await documents.createFolder({ name: `Binder ${suffix}`, siteId, workspaceId }));
      const nested = ok(await documents.createFolder({ name: "Nested", siteId, workspaceId, parentId: binder.id }));
      const inBinder = ok(
        await documents.createUpload({
          filename: "binder-page.pdf",
          contentType: "application/pdf",
          size: 1,
          siteId,
          workspaceId,
          parentId: nested.id,
        }),
      );
      ok(await documents.completeUpload(inBinder.document.id));

      await documents.link(setupSheet, "JOB", job.id);
      await documents.link(setupSheet, "STATION", station.id);
      await documents.link(moldManual, "TOOL", tool.id);
      await documents.link(resinSds, "MATERIAL", material.id);
      await documents.link(sitePolicy, "SITE", siteId);
      await documents.link(otherJobSheet, "JOB", otherJob.id);
      await documents.link(binder.id, "WORKCENTER", workcenter.id);

      // Idle station: no job, so only the station, workcenter and site.
      const idle = await documents.resolveContext({ targetType: "STATION", targetId: station.id });
      if ("error" in idle) throw new Error(idle.error);
      expect(idle.targets.map((target) => target.targetType)).toEqual(["STATION", "WORKCENTER", "SITE"]);
      expect(idle.data.map((item) => item.document.id)).toEqual([setupSheet, inBinder.document.id, sitePolicy]);
      const fromBinder = idle.data[1]!;
      expect(fromBinder.folder).toEqual({ id: binder.id, name: `Binder ${suffix}` });
      expect(fromBinder.via.map((via) => via.name)).toEqual([`WC ${suffix}`]);

      // Running the job: its parts, tools and materials join, in that order.
      await prisma.station.update({ where: { id: station.id }, data: { currentJobId: job.id } });
      const running = await documents.resolveContext({ targetType: "STATION", targetId: station.id });
      if ("error" in running) throw new Error(running.error);
      expect(running.targets.map((target) => target.targetType)).toEqual([
        "STATION",
        "JOB",
        "PRODUCT",
        "TOOL",
        "MATERIAL",
        "WORKCENTER",
        "SITE",
      ]);
      expect(running.data.map((item) => item.document.id)).toEqual([
        setupSheet,
        moldManual,
        resinSds,
        inBinder.document.id,
        sitePolicy,
      ]);
      // One file, reached twice, says so; it carries its current version to pin.
      expect(running.data[0]!.via.map((via) => via.targetType)).toEqual(["STATION", "JOB"]);
      expect(running.data[0]!.currentFileId).toEqual(expect.any(String));
      expect(running.data[2]!.via).toEqual([{ targetType: "MATERIAL", targetId: material.id, name: "Polypropylene" }]);

      // A proposed job resolves in place of the current one (the future pre-change check).
      const proposed = await documents.resolveContext(
        { targetType: "STATION", targetId: station.id },
        { jobId: otherJob.id },
      );
      if ("error" in proposed) throw new Error(proposed.error);
      expect(proposed.data.map((item) => item.document.id)).toContain(otherJobSheet);
      expect(proposed.data.map((item) => item.document.id)).not.toContain(moldManual);

      // A job's own context, with no station around it.
      const jobContext = await documents.resolveContext({ targetType: "JOB", targetId: job.id });
      if ("error" in jobContext) throw new Error(jobContext.error);
      expect(jobContext.data.map((item) => item.document.id)).toEqual([setupSheet, moldManual, resinSds]);

      // Terminals read the same context.
      const display = await documents.listForDisplayContext({
        siteId,
        workcenterId: workcenter.id,
        stationId: station.id,
      });
      expect(display.data.map((document) => document.id)).toEqual(running.data.map((item) => item.document.id));

      // Link rows on a document name their targets.
      const detail = await documents.getById(setupSheet);
      if (!detail || "error" in detail) throw new Error("missing document");
      expect(detail.data.links.map((link) => link.targetName).sort()).toEqual([`Job ${suffix}`, `Press ${suffix}`]);

      const missing = await documents.resolveContext({ targetType: "TOOL", targetId: randomUUID() });
      expect(missing).toMatchObject({ code: "TARGET_NOT_FOUND" });
    } finally {
      await removeSiteRecords(siteId);
    }
  });
});
