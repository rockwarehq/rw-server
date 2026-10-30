import prisma from "@rw/db";
import type { ObjectFieldType } from "@rw/db";
import * as instances from "../entity/instances.js";
import type { EntityScope } from "../entity/types.js";
import { validateInstanceValues } from "../entity/validation.js";
import { resolveShiftContext } from "../facility/work-context.js";
import * as shiftComments from "../facility/shift/shift-comment.js";
import * as dispositionLogs from "../inventory/disposition-log.js";
import type { WriteOptions } from "../write.js";
import type { FormField, ScrapRow } from "./manifest.js";

/*
 * What a submission writes to IMM, configured on its fields (see manifest.ts):
 * scrap through the disposition log, shift notes as shift comments, and
 * `saveTo` values as one entity instance per model. Everything is resolved
 * and checked here BEFORE anything is created (planWrites), so the usual
 * failures come back as plain errors with nothing written; index.ts then
 * performs the plan inside the submission's transaction.
 */

type Failure = { error: string; code: string; data?: undefined };

export type FormWriteKind = "SCRAP" | "SHIFT_NOTE" | "ENTITY";

export type PlannedWrite =
  | { kind: "SCRAP"; fieldId: string; label: string; input: dispositionLogs.RecordDispositionLogInput }
  | { kind: "SHIFT_NOTE"; fieldId: string; label: string; input: shiftComments.CreateShiftCommentInput }
  | {
      kind: "ENTITY";
      fieldId: string;
      label: string;
      schemaId: string;
      values: Record<string, unknown>;
      scope: EntityScope;
    };

export interface SubmitStation {
  id: string;
  name: string;
  siteId: string;
  workcenterId: string | null;
  workcenterName: string | null;
  currentJobId: string | null;
}

function fieldName(field: FormField): string {
  return field.label.trim() || field.id;
}

// ── Scrap reasons and job context ───────────────────────────────────────────

async function systemScrapDisposition(siteId: string) {
  return prisma.itemDisposition.findFirst({
    where: { siteId, isSystem: true, deletedAt: null },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * The reasons scrap can be recorded with at a site: the active reasons of its
 * system Scrap disposition, narrowed by the station's scrap-code filter when
 * there is a station (the disposition log refuses the others).
 */
export async function listScrapReasons(siteId: string, stationId?: string | null) {
  const disposition = await systemScrapDisposition(siteId);
  if (!disposition) return { dispositionId: null, reasons: [] as { id: string; name: string }[] };
  let allowed: string[] | null = null;
  if (stationId) {
    const filter = await prisma.labelFilter.findUnique({
      where: { stationId_target: { stationId, target: "DISPOSITION_REASON" } },
      select: { labels: { select: { id: true } } },
    });
    if (filter && filter.labels.length > 0) allowed = filter.labels.map((label) => label.id);
  }
  const reasons = await prisma.itemDispositionReason.findMany({
    where: {
      siteId,
      deletedAt: null,
      archivedAt: null,
      itemDispositions: { some: { id: disposition.id } },
      ...(allowed ? { labels: { some: { id: { in: allowed } } } } : {}),
    },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  return { dispositionId: disposition.id, reasons };
}

async function jobContext(jobId: string | null) {
  if (!jobId) return null;
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      currentVersion: { select: { name: true } },
      jobProducts: {
        where: { deletedAt: null, currentVersion: { isActive: true }, product: { deletedAt: null } },
        select: { product: { select: { id: true, currentVersion: { select: { name: true, sku: true } } } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!job) return null;
  return {
    id: job.id,
    name: job.currentVersion?.name ?? "",
    products: job.jobProducts.map(({ product }) => ({
      id: product.id,
      name: product.currentVersion?.name || product.currentVersion?.sku || "",
    })),
  };
}

/** What someone filling a form at a station needs to answer its scrap and shift-note fields. */
export async function fillContext(stationId: string) {
  const station = await prisma.station.findUnique({
    where: { id: stationId },
    select: {
      id: true,
      name: true,
      siteId: true,
      deletedAt: true,
      currentJobId: true,
      workcenter: { select: { id: true, name: true } },
    },
  });
  if (!station || station.deletedAt) return { error: "Station not found", code: "STATION_NOT_FOUND" };

  const [job, shift, scrap] = await Promise.all([
    jobContext(station.currentJobId),
    resolveShiftContext(station.siteId, station.workcenter?.id ?? null, new Date()),
    listScrapReasons(station.siteId, station.id),
  ]);
  return {
    data: {
      station: { id: station.id, name: station.name },
      workcenter: station.workcenter,
      job: job ? { id: job.id, name: job.name } : null,
      products: job?.products ?? [],
      shift: shift ? { id: shift.id, label: shift.name } : null,
      scrapReasons: scrap.reasons,
    },
  };
}

// ── Publish checks ──────────────────────────────────────────────────────────

const SAVE_TO_KIND: Record<string, string> = {
  number: "number",
  rating: "rating",
  computed: "calculation",
  checkbox: "checkbox",
  shortText: "text",
  longText: "text",
  dropdown: "choice",
  multipleChoice: "choice",
};

function saveToKind(field: FormField): string {
  if (field.type === "date") return field.includeTime ? "date and time" : "date";
  return SAVE_TO_KIND[field.type] ?? field.type;
}

/** Whether a form field's answers fit an entity model field. */
function canHold(field: FormField, target: { type: ObjectFieldType; isList: boolean }): boolean {
  if (target.isList) return false;
  switch (field.type) {
    case "number":
    case "rating":
      return target.type === "NUMBER";
    case "computed":
      return target.type === "NUMBER" || target.type === "BOOLEAN";
    case "checkbox":
      return target.type === "BOOLEAN";
    case "shortText":
    case "longText":
    case "dropdown":
    case "multipleChoice":
      return target.type === "TEXT" || target.type === "SELECT";
    case "date":
      return target.type === (field.includeTime ? "TIMESTAMP" : "DATE");
    default:
      return false;
  }
}

async function loadModels(modelIds: string[]) {
  const models = await prisma.objectSchema.findMany({
    where: { id: { in: modelIds } },
    select: {
      id: true,
      label: true,
      siteId: true,
      workspaceId: true,
      source: true,
      isDeleted: true,
      fields: { where: { isDeleted: false }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] },
    },
  });
  return new Map(models.map((model) => [model.id, model]));
}

/**
 * What a strict manifest's writes need from the database before it can be
 * published: formula-fed scrap has a reason of a system Scrap disposition
 * (in the form's site), and every `saveTo` names a user-made, live model (in
 * the form's site) and a field of it that can hold the answer, no two form
 * fields fill the same model field, and every required model field is filled.
 * Returns an INVALID_FORM message, or null.
 */
export async function publishProblem(fields: FormField[], siteId: string | null): Promise<string | null> {
  for (const field of fields) {
    if (field.type !== "scrap" || field.source !== "formula" || !field.reasonId) continue;
    const reason = await prisma.itemDispositionReason.findFirst({
      where: {
        id: field.reasonId,
        deletedAt: null,
        archivedAt: null,
        ...(siteId ? { siteId } : {}),
        itemDispositions: { some: { isSystem: true, deletedAt: null } },
      },
      select: { id: true },
    });
    if (!reason) return `${fieldName(field)}: Its scrap reason isn't available`;
  }

  const saving = fields.filter((field) => field.saveTo);
  if (saving.length === 0) return null;
  const models = await loadModels([...new Set(saving.map((field) => field.saveTo?.modelId as string))]);
  const filled = new Map<string, FormField>();
  for (const field of saving) {
    const target = field.saveTo as { modelId: string; field: string };
    const model = models.get(target.modelId);
    if (!model || model.isDeleted || model.source !== "DOCUMENT" || (siteId && model.siteId !== siteId)) {
      return `${fieldName(field)}: The record type it saves to isn't available`;
    }
    const modelField = model.fields.find((candidate) => (candidate.key ?? candidate.name) === target.field);
    if (!modelField) return `${fieldName(field)}: ${model.label} has no field "${target.field}"`;
    if (!canHold(field, modelField)) {
      return `${fieldName(field)}: ${model.label}.${modelField.label || target.field} can't hold a ${saveToKind(field)}`;
    }
    const slot = `${model.id}:${target.field}`;
    const other = filled.get(slot);
    if (other) {
      return `${fieldName(other)} and ${fieldName(field)} both save to ${model.label}.${modelField.label || target.field}`;
    }
    filled.set(slot, field);
  }
  for (const model of models.values()) {
    for (const modelField of model.fields) {
      if (modelField.required && !filled.has(`${model.id}:${modelField.key ?? modelField.name}`)) {
        return `${model.label}.${modelField.label || modelField.key} is required, so a field on this form must save to it`;
      }
    }
  }
  return null;
}

// ── Submit: plan, then perform ──────────────────────────────────────────────

export interface PlanInput {
  fields: FormField[];
  /** Checked answers plus computed results, by field id. */
  answers: Record<string, unknown>;
  station: SubmitStation | null;
  /** The submission's site (the station's, else the form's). */
  siteId: string | null;
  submittedById: string | null;
}

/**
 * Resolve every write a submission makes, checking all of it before anything
 * is created. A failure is the error the person sees; nothing was written.
 */
export async function planWrites(input: PlanInput): Promise<{ data: PlannedWrite[]; error?: undefined } | Failure> {
  const { fields, answers, station, siteId, submittedById } = input;
  const writes: PlannedWrite[] = [];

  // Scrap: rows people entered, or one quantity a calculation worked out.
  const scrap: { field: FormField; row: Omit<ScrapRow, "id"> }[] = [];
  for (const field of fields) {
    if (field.type !== "scrap") continue;
    if (field.source === "formula") {
      const source = fields.find((other) => other.key === field.quantityKey && other.type === "computed");
      const value = source ? answers[source.id] : undefined;
      const quantity = typeof value === "number" ? Math.round(value) : 0;
      if (quantity > 0 && field.reasonId) scrap.push({ field, row: { reasonId: field.reasonId, quantity } });
      continue;
    }
    const rows = answers[field.id];
    if (Array.isArray(rows)) for (const row of rows as ScrapRow[]) scrap.push({ field, row });
  }

  if (scrap.length > 0) {
    if (!station) return { error: "Choose the station this was filled in at", code: "NEEDS_STATION" };
    const job = await jobContext(station.currentJobId);
    if (!job) {
      return { error: `${station.name} isn't running a job, so scrap can't be recorded`, code: "NO_JOB" };
    }
    const { dispositionId, reasons } = await listScrapReasons(station.siteId, station.id);
    if (!dispositionId) {
      return { error: "This site has no Scrap disposition, so scrap can't be recorded", code: "NO_SCRAP_DISPOSITION" };
    }
    const reasonNames = new Map(reasons.map((reason) => [reason.id, reason.name]));
    const productIds = new Set(job.products.map((product) => product.id));
    const shift = await resolveShiftContext(station.siteId, station.workcenterId, new Date());

    for (const { field, row } of scrap) {
      const reasonName = reasonNames.get(row.reasonId);
      if (reasonName === undefined) {
        return {
          error: `${fieldName(field)}: A scrap reason isn't available at ${station.name}; choose another`,
          code: "INVALID_SCRAP_REASON",
        };
      }
      let productId = row.productId ?? null;
      if (productId && !productIds.has(productId)) {
        return { error: "Choose one of the job's parts for each scrap row", code: "PRODUCT_NOT_IN_JOB" };
      }
      if (!productId) {
        if (job.products.length !== 1) {
          return { error: "Choose the part for each scrap row", code: "PRODUCT_REQUIRED" };
        }
        productId = job.products[0]?.id ?? null;
      }
      writes.push({
        kind: "SCRAP",
        fieldId: field.id,
        label: `Scrap · ${row.quantity} · ${reasonName}`,
        input: {
          siteId: station.siteId,
          stationId: station.id,
          ...(station.workcenterId ? { workcenterId: station.workcenterId } : {}),
          productId: productId as string,
          jobId: job.id,
          quantity: row.quantity,
          itemDispositionId: dispositionId,
          dispositionReasonId: row.reasonId,
          ...(shift ? { shiftInstanceId: shift.id } : {}),
        },
      });
    }
  }

  // Shift notes: a comment on the running shift of the station's workcenter.
  for (const field of fields) {
    if (field.type !== "shiftNote") continue;
    const text = answers[field.id];
    if (typeof text !== "string" || !text.trim()) continue;
    if (!station) return { error: "Choose the station this was filled in at", code: "NEEDS_STATION" };
    if (!station.workcenterId) {
      return { error: `${station.name} isn't in a workcenter, so the note can't be added`, code: "NO_WORKCENTER" };
    }
    const shift = await resolveShiftContext(station.siteId, station.workcenterId, new Date());
    if (!shift) {
      return {
        error: `${station.workcenterName ?? "The workcenter"} has no shift running, so the note can't be added`,
        code: "NO_SHIFT",
      };
    }
    if (!submittedById) return { error: "Choose who is writing this note", code: "EMPLOYEE_REQUIRED" };
    writes.push({
      kind: "SHIFT_NOTE",
      fieldId: field.id,
      label: "Shift note",
      input: {
        siteId: station.siteId,
        shiftInstanceId: shift.id,
        workcenterId: station.workcenterId,
        stationId: station.id,
        text,
        createdById: submittedById,
      },
    });
  }

  // Saves to: one record per model, from the non-empty answers saving to it.
  const saving = fields.filter((field) => field.saveTo);
  if (saving.length > 0) {
    const models = await loadModels([...new Set(saving.map((field) => field.saveTo?.modelId as string))]);
    const byModel = new Map<string, { fieldId: string; values: Record<string, unknown> }>();
    for (const field of saving) {
      const target = field.saveTo as { modelId: string; field: string };
      const entry = byModel.get(target.modelId) ?? { fieldId: field.id, values: {} };
      byModel.set(target.modelId, entry);
      const value = answers[field.id];
      if (value !== undefined && value !== null && value !== "") entry.values[target.field] = value;
    }
    const site = siteId
      ? await prisma.site.findUnique({ where: { id: siteId }, select: { id: true, workspaceId: true } })
      : null;
    for (const [modelId, { fieldId, values }] of byModel) {
      const model = models.get(modelId);
      if (!model || model.isDeleted || model.source !== "DOCUMENT") {
        return { error: "A record type this form saves to isn't available any more", code: "SAVE_TO_UNAVAILABLE" };
      }
      if (Object.keys(values).length === 0) continue;
      if (!site) return { error: "Choose the station this was filled in at", code: "NEEDS_STATION" };
      if (model.siteId !== site.id || model.workspaceId !== site.workspaceId) {
        return { error: `${model.label} belongs to another site`, code: "SAVE_TO_SITE_MISMATCH" };
      }
      const checked = validateInstanceValues(model.fields, values);
      if (checked.errors.length > 0) {
        return { error: `${model.label}: ${checked.errors.join("; ")}`, code: "SAVE_TO_INVALID" };
      }
      writes.push({
        kind: "ENTITY",
        fieldId,
        label: model.label,
        schemaId: model.id,
        values,
        scope: { workspaceId: site.workspaceId, siteId: site.id },
      });
    }
  }

  return { data: writes };
}

/** Create one planned write through its service, sharing the caller's transaction. */
export async function performWrite(write: PlannedWrite, options: WriteOptions): Promise<{ id: string } | Failure> {
  switch (write.kind) {
    case "SCRAP": {
      const result = await dispositionLogs.record(write.input, options);
      return "error" in result ? result : { id: result.data.id };
    }
    case "SHIFT_NOTE": {
      const result = await shiftComments.create(write.input, options);
      return "error" in result ? result : { id: result.data.id };
    }
    case "ENTITY": {
      const result = await instances.create({ schemaId: write.schemaId, values: write.values }, write.scope, options);
      return "error" in result ? result : { id: (result.data as { id: string }).id };
    }
  }
}
