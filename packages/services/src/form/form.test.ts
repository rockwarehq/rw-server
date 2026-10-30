import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import prisma, { ensureAccountWorkspace } from "@rw/db";
import * as forms from "./index.js";
import * as documents from "../document/index.js";
import * as jobs from "../job/job.js";

// Needs a migrated database (DATABASE_URL); run with `pnpm test:form`
// against a scratch database, never a shared one.

function ok<T>(result: { data: T; error?: undefined } | { error: string; code: string; data?: undefined }): T {
  if (result.error !== undefined) throw new Error(`${result.code}: ${result.error}`);
  return result.data as T;
}

const content = (...fields: unknown[]) => ({
  type: "doc",
  content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Startup" }] }, ...fields],
});

const checklist = {
  type: "checklistField",
  attrs: {
    fieldId: "checks",
    label: "Safety checks",
    required: true,
    items: [
      { id: "guard", label: "Guard closed" },
      { id: "estop", label: "E-stop tested" },
    ],
  },
};
const lot = { type: "shortTextField", attrs: { fieldId: "lot", label: "Lot", required: false } };

describe("form service", () => {
  let workspaceId: string;
  let siteId: string;
  let suffix: string;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is required to run form service tests");
    }
    suffix = randomUUID();
    const workspace = await ensureAccountWorkspace({ name: "Test Account", slug: "test-account" });
    const site = await prisma.site.create({ data: { name: `Form Test Site ${suffix}`, workspaceId: workspace.id } });
    workspaceId = workspace.id;
    siteId = site.id;
  });

  afterAll(async () => {
    if (siteId) {
      await prisma.document.deleteMany({ where: { siteId } });
      await prisma.station.deleteMany({ where: { siteId } });
      await prisma.workcenter.deleteMany({ where: { siteId } });
      await prisma.job.updateMany({ where: { siteId }, data: { currentVersionId: null } });
      await prisma.jobVersion.deleteMany({ where: { job: { siteId } } });
      await prisma.job.deleteMany({ where: { siteId } });
      await prisma.site.deleteMany({ where: { id: siteId } });
    }
    await prisma.$disconnect();
  });

  test("drafts, publishes, versions and discards", async () => {
    const created = ok(await forms.create({ name: "Startup checklist", siteId, workspaceId, labels: ["Safety"] }));
    expect(created).toMatchObject({
      status: "DRAFT",
      publishedVersion: null,
      hasDraft: true,
      fieldCount: 0,
      labels: ["safety"],
      published: null,
    });
    expect(created.draft).toMatchObject({ version: 1, status: "DRAFT", content: { type: "doc", content: [] } });

    // Not publishable yet, and the only draft cannot be discarded.
    expect(await forms.publish(created.id)).toMatchObject({ code: "NO_FIELDS" });
    expect(await forms.discardDraft(created.id)).toMatchObject({ code: "ONLY_VERSION" });

    // Drafts keep what is ready and skip what is not.
    const draft = ok(
      await forms.saveDraft(created.id, content(checklist, { type: "mysteryField", attrs: { fieldId: "m" } })),
    );
    expect(draft.fields.map((f) => f.id)).toEqual(["checks"]);
    expect(await forms.publish(created.id)).toMatchObject({ code: "INVALID_FORM" });

    ok(await forms.saveDraft(created.id, content(checklist, lot)));
    const v1 = ok(await forms.publish(created.id, { note: "First" }));
    expect(v1).toMatchObject({ status: "PUBLISHED", publishedVersion: 1, hasDraft: false, fieldCount: 2, draft: null });
    expect(v1.published).toMatchObject({ version: 1, status: "PUBLISHED", note: "First" });
    expect(v1.published?.publishedAt).toBeInstanceOf(Date);
    expect(await forms.publish(created.id)).toMatchObject({ code: "NO_DRAFT" });

    // A new draft is numbered after the latest version; discarding it keeps v1.
    const v2draft = ok(await forms.saveDraft(created.id, content(lot)));
    expect(v2draft.version).toBe(2);
    const discarded = ok(await forms.discardDraft(created.id));
    expect(discarded).toMatchObject({ publishedVersion: 1, hasDraft: false });

    ok(await forms.saveDraft(created.id, content(lot, checklist)));
    const v3 = ok(await forms.publish(created.id));
    expect(v3.publishedVersion).toBe(2);
    expect(ok(await forms.listVersions(created.id)).map((v) => v.version)).toEqual([2, 1]);

    // The Library's document list leaves forms out unless asked for.
    const docs = await documents.list({ siteId });
    expect(docs.data.some((d) => d.id === created.id)).toBe(false);
    const formDocs = await documents.list({ siteId, kind: "FORM" });
    expect(formDocs.data.map((d) => d.id)).toContain(created.id);

    const listed = ok(await forms.list({ siteId }));
    expect(listed.items.find((f) => f.id === created.id)).toMatchObject({ publishedVersion: 2, submissionCount: 0 });

    // Files are not forms.
    expect(await forms.get(randomUUID())).toMatchObject({ code: "FORM_NOT_FOUND" });
  });

  test("submits against the current version with station context", async () => {
    const workcenter = await prisma.workcenter.create({ data: { name: `WC ${suffix}`, siteId } });
    const job = ok(await jobs.create({ siteId, name: `Job ${suffix}` }));
    const station = await prisma.station.create({
      data: { name: `Press ${suffix}`, siteId, workcenterId: workcenter.id, currentJobId: job.id },
    });

    const form = ok(await forms.create({ name: "Hourly check", siteId, workspaceId }));
    expect(await forms.submit({ documentId: form.id, formId: form.draft!.id, answers: {} })).toMatchObject({
      code: "NO_CURRENT_VERSION",
    });

    ok(await forms.saveDraft(form.id, content(checklist, lot)));
    const published = ok(await forms.publish(form.id));
    const formId = published.published!.id;

    expect(await forms.submit({ documentId: form.id, formId, answers: { checks: { guard: true } } })).toMatchObject({
      code: "INVALID_ANSWERS",
      error: "Please complete Safety checks.",
    });

    const first = ok(
      await forms.submit({
        documentId: form.id,
        formId,
        answers: { checks: { guard: true, estop: true }, lot: "L-7", junk: 1 },
        stationId: station.id,
      }),
    );
    expect(first).toMatchObject({
      number: 1,
      version: 1,
      formName: "Hourly check",
      answers: { checks: { guard: true, estop: true }, lot: "L-7" },
      station: { id: station.id },
      workcenter: { id: workcenter.id },
      job: { id: job.id, name: `Job ${suffix}` },
      progress: { answered: 3, total: 3 },
    });

    const second = ok(
      await forms.submit({ documentId: form.id, formId, answers: { checks: { guard: true, estop: true } } }),
    );
    expect(second).toMatchObject({ number: 2, station: null, job: null, progress: { answered: 2, total: 3 } });

    // A newer version makes the old one stale for fillers.
    ok(await forms.saveDraft(form.id, content(lot, checklist)));
    ok(await forms.publish(form.id));
    expect(
      await forms.submit({ documentId: form.id, formId, answers: { checks: { guard: true, estop: true } } }),
    ).toMatchObject({ code: "FORM_OUTDATED", error: "This form was updated. Reload to fill the latest version." });

    const all = ok(await forms.listSubmissions({ documentId: form.id }));
    expect(all.total).toBe(2);
    expect(all.items.map((s) => s.number)).toEqual([2, 1]);
    const atStation = ok(await forms.listSubmissions({ documentId: form.id, stationId: station.id }));
    expect(atStation.items.map((s) => s.id)).toEqual([first.id]);

    // The submission keeps the version it was filled on.
    const read = ok(await forms.getSubmission(first.id));
    expect(read.form.version).toBe(1);
    expect(await forms.submissionDocumentId(first.id)).toBe(form.id);

    const summary = ok(await forms.get(form.id));
    expect(summary).toMatchObject({ submissionCount: 2, publishedVersion: 2 });
    expect(summary.lastSubmittedAt).toBeInstanceOf(Date);

    // Deleting the form takes its versions and submissions with it.
    expect(await documents.remove(form.id)).toEqual({ success: true });
    expect(await prisma.formSubmission.count({ where: { documentId: form.id } })).toBe(0);
    expect(await prisma.documentForm.count({ where: { documentId: form.id } })).toBe(0);
  });
});
