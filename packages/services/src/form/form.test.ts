import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import prisma, { ensureAccountWorkspace } from "@rw/db";
import * as forms from "./index.js";
import * as documents from "../document/index.js";
import * as jobs from "../job/job.js";
import * as products from "../inventory/product.js";

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
  test("works out computed fields on submit, ignoring what the client sent for them", async () => {
    const number = (fieldId: string, key: string, label: string) => ({
      type: "numberField",
      attrs: { fieldId, key, label, required: true },
    });
    const computedNode = (fieldId: string, key: string, label: string, formula: string) => ({
      type: "computedField",
      attrs: { fieldId, key, label, formula, decimals: 1, percent: true, required: true },
    });

    const form = ok(await forms.create({ name: "Scrap check", siteId, workspaceId }));
    // A broken formula can be drafted but not published.
    ok(
      await forms.saveDraft(
        form.id,
        content(number("n1", "inspected", "Inspected"), computedNode("c1", "rate", "Rate", "bad / 2")),
      ),
    );
    expect(await forms.publish(form.id)).toMatchObject({
      code: "INVALID_FORM",
      error: 'Rate: No field is named "bad"',
    });

    ok(
      await forms.saveDraft(
        form.id,
        content(
          number("n1", "inspected", "Inspected"),
          number("n2", "good", "Good"),
          computedNode("c2", "rate", "Scrap rate", "scrap / inspected"),
          computedNode("c1", "scrap", "Scrap", "inspected - good"),
        ),
      ),
    );
    const published = ok(await forms.publish(form.id));
    const formId = published.published!.id;
    expect(published.published?.fields.find((f) => f.id === "c1")).toMatchObject({ type: "computed", required: false });

    const submitted = ok(
      await forms.submit({ documentId: form.id, formId, answers: { n1: 40, n2: 38, c1: 999, c2: "junk" } }),
    );
    expect(submitted.answers).toEqual({ n1: 40, n2: 38, c1: 2, c2: 0.05 });
    expect(submitted.progress).toEqual({ answered: 2, total: 2 });

    const stored = await prisma.formSubmission.findUnique({ where: { id: submitted.id }, select: { answers: true } });
    expect(stored?.answers).toEqual({ n1: 40, n2: 38, c1: 2, c2: 0.05 });

    // Division by zero leaves the result out rather than storing a non-number.
    const zero = ok(await forms.submit({ documentId: form.id, formId, answers: { n1: 0, n2: 0 } }));
    expect(zero.answers).toEqual({ n1: 0, n2: 0, c1: 0 });
  });

  describe("fields that write to IMM", () => {
    // Its own site: shift assignments can't be deleted with a site, so this
    // scratch-database fixture is left in place.
    let wsite: string;
    let userId: string;
    let workcenterId: string;
    let station: { id: string; name: string };
    let idleStation: string;
    let twoPartStation: string;
    let noShiftStation: string;
    let productId: string;
    let jobId: string;
    let shiftInstanceId: string;
    let dispositionId: string;
    let shortShot: string;
    let flash: string;
    let modelId: string;

    const at = (hours: number) => new Date(Date.now() + hours * 3_600_000);
    const node = (type: string, attrs: Record<string, unknown>) => ({ type, attrs });

    beforeAll(async () => {
      const s2 = randomUUID();
      wsite = (await prisma.site.create({ data: { name: `Form Writes Site ${s2}`, workspaceId } })).id;
      userId = (await prisma.user.create({ data: { email: `form-writes-${s2}@test.local`, passwordHash: "x" } })).id;
      const workcenter = await prisma.workcenter.create({ data: { name: `Molding ${s2}`, siteId: wsite } });
      workcenterId = workcenter.id;
      const otherWc = await prisma.workcenter.create({ data: { name: `Assembly ${s2}`, siteId: wsite } });

      const product = ok(await products.create({ siteId: wsite, sku: `SKU-${s2}`, name: "Housing" }));
      const product2 = ok(await products.create({ siteId: wsite, sku: `SKU2-${s2}`, name: "Lid" }));
      productId = product.id;
      const job = ok(await jobs.create({ siteId: wsite, name: `Housing run ${s2}` }));
      jobId = job.id;
      ok(await jobs.addItem({ jobId, productId }));
      const twoPartJob = ok(await jobs.create({ siteId: wsite, name: `Kit run ${s2}` }));
      ok(await jobs.addItem({ jobId: twoPartJob.id, productId }));
      ok(await jobs.addItem({ jobId: twoPartJob.id, productId: product2.id }));

      station = await prisma.station.create({
        data: { name: `Press 1 ${s2}`, siteId: wsite, workcenterId, currentJobId: jobId },
        select: { id: true, name: true },
      });
      idleStation = (await prisma.station.create({ data: { name: `Press 2 ${s2}`, siteId: wsite, workcenterId } })).id;
      twoPartStation = (
        await prisma.station.create({
          data: { name: `Press 3 ${s2}`, siteId: wsite, workcenterId, currentJobId: twoPartJob.id },
        })
      ).id;
      noShiftStation = (
        await prisma.station.create({
          data: { name: `Bench ${s2}`, siteId: wsite, workcenterId: otherWc.id, currentJobId: jobId },
        })
      ).id;

      const pattern = await prisma.shiftPattern.create({ data: { siteId: wsite, name: "P" } });
      const definition = await prisma.shiftDefinition.create({
        data: {
          patternId: pattern.id,
          dayOfRotation: 1,
          sortOrder: 1,
          startTime: "06:00",
          durationHrs: 8,
          shiftName: "Day",
        },
      });
      const assignment = await prisma.shiftAssignment.create({
        data: { patternId: pattern.id, siteId: wsite, rotationStartDate: at(-48) },
      });
      shiftInstanceId = (
        await prisma.shiftInstance.create({
          data: {
            assignmentId: assignment.id,
            definitionId: definition.id,
            siteId: wsite,
            workCenterId: workcenterId,
            shiftName: "Day",
            businessDate: at(-4),
            startTime: at(-4),
            endTime: at(4),
          },
        })
      ).id;

      dispositionId = (await prisma.itemDisposition.create({ data: { siteId: wsite, name: "Scrap", isSystem: true } }))
        .id;
      const reason = (name: string) =>
        prisma.itemDispositionReason.create({
          data: { siteId: wsite, name, itemDispositions: { connect: { id: dispositionId } } },
        });
      shortShot = (await reason("Short shot")).id;
      flash = (await reason("Flash")).id;
      // Archived reasons aren't offered.
      await prisma.itemDispositionReason.create({
        data: {
          siteId: wsite,
          name: "Old",
          archivedAt: new Date(),
          itemDispositions: { connect: { id: dispositionId } },
        },
      });

      modelId = (
        await prisma.objectSchema.create({
          data: {
            key: `inspection_${s2.slice(0, 8)}`,
            label: "Inspection record",
            name: `Inspection ${s2}`,
            source: "DOCUMENT",
            workspaceId,
            siteId: wsite,
            fields: {
              create: [
                { name: "temp", key: "temp", label: "Temperature", type: "NUMBER", required: true, sortOrder: 1 },
                { name: "lot", key: "lot", label: "Lot", type: "TEXT", sortOrder: 2 },
                { name: "ok", key: "ok", label: "OK", type: "BOOLEAN", sortOrder: 3 },
              ],
            },
          },
        })
      ).id;
    });

    const fullForm = () =>
      content(
        node("numberField", { fieldId: "qty", key: "qty", label: "Inspected", required: true }),
        node("numberField", { fieldId: "good", key: "good", label: "Good", required: true }),
        node("computedField", { fieldId: "bad", key: "bad", label: "Bad", formula: "qty - good - scrapped" }),
        node("scrapField", { fieldId: "rows", key: "scrapped", label: "Scrap", required: false }),
        node("scrapField", {
          fieldId: "auto",
          label: "Auto scrap",
          source: "formula",
          quantityKey: "bad",
          reasonId: flash,
        }),
        node("shiftNoteField", { fieldId: "note", label: "Note", required: false }),
        node("numberField", { fieldId: "temp", label: "Temp", required: true, saveTo: { modelId, field: "temp" } }),
        node("shortTextField", { fieldId: "lot", label: "Lot", required: false, saveTo: { modelId, field: "lot" } }),
        node("checkboxField", {
          fieldId: "ok",
          label: "Looks right",
          required: false,
          saveTo: { modelId, field: "ok" },
        }),
      );

    async function publishForm(doc: unknown) {
      const form = ok(await forms.create({ name: `Writes ${randomUUID()}`, siteId: wsite, workspaceId }));
      ok(await forms.saveDraft(form.id, doc));
      const published = ok(await forms.publish(form.id));
      return { documentId: form.id, formId: published.published!.id, published };
    }

    const counts = async () => ({
      submissions: await prisma.formSubmission.count({ where: { siteId: wsite } }),
      scrap: await prisma.itemDispositionLog.count({ where: { siteId: wsite } }),
      comments: await prisma.shiftComment.count({ where: { siteId: wsite } }),
      records: await prisma.objectInstance.count({ where: { schemaId: modelId } }),
    });

    test("fill context: station, job, parts, shift and the active scrap reasons", async () => {
      expect(ok(await forms.fillContext(station.id))).toEqual({
        station,
        workcenter: { id: workcenterId, name: expect.stringContaining("Molding") },
        job: { id: jobId, name: expect.stringContaining("Housing run") },
        products: [{ id: productId, name: "Housing" }],
        shift: { id: shiftInstanceId, label: "Day" },
        scrapReasons: [
          { id: flash, name: "Flash" },
          { id: shortShot, name: "Short shot" },
        ],
      });
      expect(ok(await forms.fillContext(idleStation))).toMatchObject({ job: null, products: [] });
      expect(ok(await forms.scrapReasons(wsite)).map((r) => r.name)).toEqual(["Flash", "Short shot"]);
    });

    test("publish checks where values save to", async () => {
      const bad = (attrs: Record<string, unknown>) =>
        content(
          node("shortTextField", { fieldId: "t", label: "Reading", saveTo: { modelId, field: "temp" }, ...attrs }),
        );
      const form = ok(await forms.create({ name: `Bad saves ${randomUUID()}`, siteId: wsite, workspaceId }));
      ok(await forms.saveDraft(form.id, bad({})));
      expect(await forms.publish(form.id)).toEqual({
        error: "Reading: Inspection record.Temperature can't hold a text",
        code: "INVALID_FORM",
      });
      ok(
        await forms.saveDraft(
          form.id,
          content(node("shortTextField", { fieldId: "t", label: "Reading", saveTo: { modelId, field: "lot" } })),
        ),
      );
      expect(await forms.publish(form.id)).toEqual({
        error: "Inspection record.Temperature is required, so a field on this form must save to it",
        code: "INVALID_FORM",
      });
      ok(
        await forms.saveDraft(
          form.id,
          content(
            node("numberField", { fieldId: "t", label: "Reading", saveTo: { modelId: randomUUID(), field: "x" } }),
          ),
        ),
      );
      expect(await forms.publish(form.id)).toEqual({
        error: "Reading: The record type it saves to isn't available",
        code: "INVALID_FORM",
      });
    });

    test("records scrap (rows and formula), a shift note and one record, linked to the submission", async () => {
      const { documentId, formId, published } = await publishForm(fullForm());
      expect(published.published?.needsStation).toBe(true);

      const answers = {
        qty: 20,
        good: 15,
        rows: [{ id: "r1", reasonId: shortShot, quantity: 2 }],
        auto: [{ id: "x", reasonId: shortShot, quantity: 99 }],
        note: "Hopper ran low",
        temp: 212.5,
        lot: "L-42",
        ok: true,
      };
      expect(await forms.submit({ documentId, formId, answers, submittedById: userId })).toEqual({
        error: "Choose the station this was filled in at",
        code: "NEEDS_STATION",
      });

      const before = await counts();
      const submitted = ok(
        await forms.submit({ documentId, formId, answers, stationId: station.id, submittedById: userId }),
      );
      // bad = 20 - 15 - 2 = 3; the answer sent for the formula scrap was dropped.
      expect(submitted.answers).toEqual({
        qty: 20,
        good: 15,
        bad: 3,
        rows: [{ id: "r1", reasonId: shortShot, quantity: 2 }],
        note: "Hopper ran low",
        temp: 212.5,
        lot: "L-42",
        ok: true,
      });
      expect(submitted.writes.map(({ kind, fieldId, label }) => ({ kind, fieldId, label }))).toEqual([
        { kind: "SCRAP", fieldId: "rows", label: "Scrap · 2 · Short shot" },
        { kind: "SCRAP", fieldId: "auto", label: "Scrap · 3 · Flash" },
        { kind: "SHIFT_NOTE", fieldId: "note", label: "Shift note" },
        { kind: "ENTITY", fieldId: "temp", label: "Inspection record" },
      ]);
      expect(await counts()).toEqual({
        submissions: before.submissions + 1,
        scrap: before.scrap + 2,
        comments: before.comments + 1,
        records: before.records + 1,
      });

      const [rowsWrite, autoWrite, noteWrite, recordWrite] = submitted.writes;
      const logs = await prisma.itemDispositionLog.findMany({
        where: { id: { in: [rowsWrite!.targetId, autoWrite!.targetId] } },
        orderBy: { quantity: "asc" },
      });
      expect(logs.map((log) => [Number(log.quantity), log.dispositionReasonId])).toEqual([
        [2, shortShot],
        [3, flash],
      ]);
      for (const log of logs) {
        expect(log).toMatchObject({
          stationId: station.id,
          workcenterId,
          jobId,
          productId,
          shiftInstanceId,
          itemDispositionId: dispositionId,
        });
      }
      expect(await prisma.shiftComment.findUnique({ where: { id: noteWrite!.targetId } })).toMatchObject({
        text: "Hopper ran low",
        shiftInstanceId,
        workcenterId,
        stationId: station.id,
        createdById: userId,
      });
      expect(await prisma.objectInstance.findUnique({ where: { id: recordWrite!.targetId } })).toMatchObject({
        schemaId: modelId,
        siteId: wsite,
        values: { temp: 212.5, lot: "L-42", ok: true },
      });

      // The read paths carry the writes too.
      expect(ok(await forms.getSubmission(submitted.id)).writes).toEqual(submitted.writes);
      const listed = ok(await forms.listSubmissions({ documentId }));
      expect(listed.items[0]?.writes).toHaveLength(4);
    });

    test("nothing is written when any write fails its checks", async () => {
      const { documentId, formId } = await publishForm(fullForm());
      const answers = {
        qty: 10,
        good: 9,
        rows: [{ id: "r1", reasonId: shortShot, quantity: 1 }],
        note: "Hello",
        temp: 200,
      };
      const before = await counts();
      const submit = (stationId: string, extra: Record<string, unknown> = {}) =>
        forms.submit({ documentId, formId, answers: { ...answers, ...extra }, stationId, submittedById: userId });

      // Two parts on the job and none chosen.
      expect(await submit(twoPartStation)).toEqual({
        error: "Choose the part for each scrap row",
        code: "PRODUCT_REQUIRED",
      });
      // No job running.
      expect(await submit(idleStation)).toEqual({
        error: expect.stringMatching(/^Press 2 .* isn't running a job, so scrap can't be recorded$/),
        code: "NO_JOB",
      });
      // No shift in that workcenter (scrap itself would be fine).
      expect(await submit(noShiftStation)).toEqual({
        error: expect.stringMatching(/^Assembly .* has no shift running, so the note can't be added$/),
        code: "NO_SHIFT",
      });
      // An archived (or foreign) reason.
      expect(await submit(station.id, { rows: [{ id: "r1", reasonId: randomUUID(), quantity: 1 }] })).toMatchObject({
        code: "INVALID_SCRAP_REASON",
      });
      // A part that isn't on the job.
      expect(
        await submit(station.id, { rows: [{ id: "r1", reasonId: shortShot, quantity: 1, productId: randomUUID() }] }),
      ).toMatchObject({ code: "PRODUCT_NOT_IN_JOB" });

      expect(await counts()).toEqual(before);

      // With no scrap to record, an idle station is fine.
      const quiet = ok(await submit(idleStation, { rows: [], qty: 10, good: 10 }));
      expect(quiet.writes.map((w) => w.kind)).toEqual(["SHIFT_NOTE", "ENTITY"]);
    });
  });
});
