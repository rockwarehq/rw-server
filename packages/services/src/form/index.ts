import prisma, { Prisma } from "@rw/db";
import { auditRecord } from "../audit/index.js";
import { normalizeLabels } from "../document/shared.js";
import { MAX_CONTENT_BYTES, answerProgress, buildManifest, readManifest, validateAnswers } from "./manifest.js";

export * from "./manifest.js";

/*
 * Forms are documents (kind FORM) that delegate their content to DocumentForm
 * versions, the way a FILE delegates its bytes to DocumentFile. A form has at
 * most one DRAFT (being edited) and any number of PUBLISHED versions, which
 * never change; Document.currentFormId points at the latest published one, the
 * version people fill. A FormSubmission pins that version and records where the
 * work happened (station, its workcenter, the job it ran).
 *
 * Name, description, labels and deletion stay on the document service.
 *
 * Later slices add computed fields, blocks that write to records on submit
 * (in the submit transaction, each write linked to the submission) and
 * requested forms; the manifest and pinned versions are what they build on.
 */

const EMPTY_CONTENT = { type: "doc", content: [] };

const userSelect = { select: { id: true, firstName: true, lastName: true, email: true } } as const;

const versionSelect = {
  id: true,
  version: true,
  status: true,
  content: true,
  fields: true,
  note: true,
  publishedAt: true,
  createdAt: true,
  updatedAt: true,
  createdBy: userSelect,
  publishedBy: userSelect,
} satisfies Prisma.DocumentFormSelect;

type VersionRecord = Prisma.DocumentFormGetPayload<{ select: typeof versionSelect }>;

const formInclude = {
  currentForm: { select: versionSelect },
  forms: { where: { status: "DRAFT" }, select: versionSelect },
  _count: { select: { submissions: true } },
  submissions: { orderBy: { submittedAt: "desc" }, take: 1, select: { submittedAt: true } },
} satisfies Prisma.DocumentInclude;

type FormRecord = Prisma.DocumentGetPayload<{ include: typeof formInclude }>;

type UserRef = { id: string; firstName: string | null; lastName: string | null; email: string } | null;

function toUser(user: UserRef) {
  if (!user) return null;
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ");
  return { id: user.id, name: name || user.email };
}

function toVersion({ createdBy, publishedBy, fields, ...version }: VersionRecord) {
  return {
    ...version,
    fields: readManifest(fields),
    createdBy: toUser(createdBy),
    publishedBy: toUser(publishedBy),
  };
}

export type FormVersion = ReturnType<typeof toVersion>;

function toSummary(record: FormRecord) {
  const published = record.currentForm;
  const draft = record.forms[0] ?? null;
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    siteId: record.siteId,
    labels: record.labels,
    status: published ? ("PUBLISHED" as const) : ("DRAFT" as const),
    publishedVersion: published?.version ?? null,
    hasDraft: draft !== null,
    fieldCount: readManifest((published ?? draft)?.fields).length,
    submissionCount: record._count.submissions,
    lastSubmittedAt: record.submissions[0]?.submittedAt ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toForm(record: FormRecord) {
  const draft = record.forms[0] ?? null;
  return {
    ...toSummary(record),
    published: record.currentForm ? toVersion(record.currentForm) : null,
    draft: draft ? toVersion(draft) : null,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function contentTooLarge(content: unknown) {
  const size = Buffer.byteLength(JSON.stringify(content ?? null), "utf8");
  return size > MAX_CONTENT_BYTES
    ? {
        error: `Form content is too large (${Math.ceil(size / 1024)}KB; the limit is 512KB)`,
        code: "CONTENT_TOO_LARGE",
      }
    : null;
}

/** A live FORM document, or FORM_NOT_FOUND for anything else. */
async function findForm(documentId: string) {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: { id: true, kind: true, name: true, siteId: true, currentFormId: true, deletedAt: true },
  });
  if (!document || document.deletedAt || document.kind !== "FORM")
    return { error: "Form not found", code: "FORM_NOT_FOUND" };
  return { data: document };
}

async function loadForm(documentId: string) {
  const record = await prisma.document.findUnique({ where: { id: documentId }, include: formInclude });
  if (!record || record.deletedAt || record.kind !== "FORM") return { error: "Form not found", code: "FORM_NOT_FOUND" };
  return { data: toForm(record) };
}

export interface ListFormsInput {
  siteId?: string | null;
  q?: string;
  limit?: number;
  offset?: number;
}

export async function list(input: ListFormsInput = {}) {
  const { siteId, q, limit = 50, offset = 0 } = input;
  const where: Prisma.DocumentWhereInput = { kind: "FORM", deletedAt: null };
  if (siteId !== undefined) where.siteId = siteId;
  if (q) {
    where.OR = [{ name: { contains: q, mode: "insensitive" } }, { description: { contains: q, mode: "insensitive" } }];
  }

  const [records, total] = await Promise.all([
    prisma.document.findMany({
      where,
      include: formInclude,
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    }),
    prisma.document.count({ where }),
  ]);

  return { data: { items: records.map(toSummary), total } };
}

export interface CreateFormInput {
  name: string;
  description?: string | null;
  siteId?: string | null;
  labels?: string[];
  workspaceId?: string;
  createdById?: string | null;
}

/** A new FORM document with its first version as an empty DRAFT. */
export async function create(input: CreateFormInput) {
  const siteId = input.siteId ?? null;
  if (siteId) {
    const site = await prisma.site.findUnique({ where: { id: siteId }, select: { workspaceId: true } });
    if (!site) return { error: "Site not found", code: "SITE_NOT_FOUND" };
    if (input.workspaceId && site.workspaceId !== input.workspaceId) {
      return { error: "Site does not belong to this workspace", code: "SITE_NOT_IN_WORKSPACE" };
    }
  }

  const documentId = await prisma.$transaction(async (tx) => {
    const created = await tx.document.create({
      data: {
        kind: "FORM",
        status: "READY",
        name: input.name,
        description: input.description ?? null,
        labels: normalizeLabels(input.labels),
        siteId,
        forms: {
          create: { version: 1, status: "DRAFT", content: EMPTY_CONTENT, createdById: input.createdById ?? null },
        },
      },
    });
    await auditRecord(tx, {
      change: "created",
      entityType: "document",
      entityId: created.id,
      siteId: created.siteId,
      workspaceId: input.workspaceId,
      label: created.name,
      after: created,
      fields: ["name", "description", "labels", "siteId"],
      metadata: { kind: "FORM" },
    });
    return created.id;
  });

  return loadForm(documentId);
}

export async function get(documentId: string) {
  return loadForm(documentId);
}

/**
 * Save the draft's content, creating the draft (numbered after the latest
 * version) when there is none. The manifest is recomputed leniently so the
 * editor can show the fields that are ready; publish is the strict check.
 */
export async function saveDraft(documentId: string, content: unknown, userId?: string | null) {
  const found = await findForm(documentId);
  if (found.error !== undefined) return found;

  const tooLarge = contentTooLarge(content);
  if (tooLarge) return tooLarge;

  const manifest = buildManifest(content, "lenient");
  const fields = manifest.error === undefined ? manifest.data : [];
  const json = content as Prisma.InputJsonValue;

  try {
    const version = await prisma.$transaction(async (tx) => {
      const draft = await tx.documentForm.findFirst({ where: { documentId, status: "DRAFT" }, select: { id: true } });
      const saved = draft
        ? await tx.documentForm.update({
            where: { id: draft.id },
            data: { content: json, fields: fields as unknown as Prisma.InputJsonValue },
            select: versionSelect,
          })
        : await tx.documentForm.create({
            data: {
              documentId,
              version:
                ((await tx.documentForm.aggregate({ where: { documentId }, _max: { version: true } }))._max.version ??
                  0) + 1,
              status: "DRAFT",
              content: json,
              fields: fields as unknown as Prisma.InputJsonValue,
              createdById: userId ?? null,
            },
            select: versionSelect,
          });
      await tx.document.update({ where: { id: documentId }, data: { updatedAt: new Date() } });
      return saved;
    });
    return { data: toVersion(version) };
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { error: "The form was saved somewhere else at the same time; try again", code: "VERSION_CONFLICT" };
    }
    throw error;
  }
}

/**
 * Publish the draft: its manifest is checked strictly, it becomes PUBLISHED
 * (never to change again) and the document's current version. Submissions
 * from then on pin it; earlier ones keep the version they were filled on.
 */
export async function publish(documentId: string, input: { note?: string | null; userId?: string | null } = {}) {
  const found = await findForm(documentId);
  if (found.error !== undefined) return found;

  const draft = await prisma.documentForm.findFirst({
    where: { documentId, status: "DRAFT" },
    select: { id: true, version: true, content: true, updatedAt: true },
  });
  if (!draft) return { error: "There are no changes to publish", code: "NO_DRAFT" };

  const manifest = buildManifest(draft.content, "strict");
  if (manifest.error !== undefined) return manifest;

  const previousFormId = found.data.currentFormId;
  const previous = previousFormId
    ? await prisma.documentForm.findUnique({ where: { id: previousFormId }, select: { version: true } })
    : null;

  const published = await prisma.$transaction(async (tx) => {
    // Only a draft untouched since its content was checked gets published.
    const { count } = await tx.documentForm.updateMany({
      where: { id: draft.id, status: "DRAFT", updatedAt: draft.updatedAt },
      data: {
        status: "PUBLISHED",
        fields: manifest.data as unknown as Prisma.InputJsonValue,
        note: input.note?.trim() || null,
        publishedAt: new Date(),
        publishedById: input.userId ?? null,
      },
    });
    if (count === 0) return false;
    await tx.document.update({ where: { id: documentId }, data: { currentFormId: draft.id } });
    await auditRecord(tx, {
      change: "updated",
      entityType: "document",
      entityId: documentId,
      siteId: found.data.siteId,
      label: found.data.name,
      before: { version: previous?.version ?? null },
      after: { version: draft.version },
      fields: ["version"],
      versionId: draft.id,
      previousVersionId: previousFormId,
      metadata: { kind: "FORM", published: draft.version },
    });
    return true;
  });

  if (!published) {
    return { error: "The draft changed while publishing; try again", code: "VERSION_CONFLICT" };
  }
  return loadForm(documentId);
}

/** Throw the draft away. A form that was never published keeps its only draft. */
export async function discardDraft(documentId: string) {
  const found = await findForm(documentId);
  if (found.error !== undefined) return found;

  const draft = await prisma.documentForm.findFirst({ where: { documentId, status: "DRAFT" }, select: { id: true } });
  if (draft) {
    if (!found.data.currentFormId) {
      return { error: "A form needs a version: publish it, or delete the form instead", code: "ONLY_VERSION" };
    }
    await prisma.documentForm.delete({ where: { id: draft.id } });
  }
  return loadForm(documentId);
}

/** Every published version, newest first. */
export async function listVersions(documentId: string) {
  const found = await findForm(documentId);
  if (found.error !== undefined) return found;

  const versions = await prisma.documentForm.findMany({
    where: { documentId, status: "PUBLISHED" },
    select: versionSelect,
    orderBy: { version: "desc" },
  });
  return { data: versions.map(toVersion) };
}

const submissionInclude = {
  form: { select: versionSelect },
  document: { select: { name: true } },
  submittedBy: userSelect,
  station: { select: { id: true, name: true } },
  workcenter: { select: { id: true, name: true } },
  job: { select: { id: true, currentVersion: { select: { name: true } } } },
} satisfies Prisma.FormSubmissionInclude;

type SubmissionRecord = Prisma.FormSubmissionGetPayload<{ include: typeof submissionInclude }>;

function answersOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toSubmissionSummary(record: SubmissionRecord) {
  return {
    id: record.id,
    number: record.number,
    documentId: record.documentId,
    formId: record.formId,
    version: record.form.version,
    submittedAt: record.submittedAt,
    submittedBy: toUser(record.submittedBy),
    station: record.station,
    workcenter: record.workcenter,
    job: record.job ? { id: record.job.id, name: record.job.currentVersion?.name ?? "" } : null,
    progress: answerProgress(readManifest(record.form.fields), answersOf(record.answers)),
  };
}

function toSubmission(record: SubmissionRecord) {
  return {
    ...toSubmissionSummary(record),
    answers: answersOf(record.answers),
    form: toVersion(record.form),
    formName: record.document.name,
  };
}

export interface SubmitFormInput {
  documentId: string;
  /** The published version the person filled; must still be current. */
  formId: string;
  answers: Record<string, unknown>;
  stationId?: string | null;
  submittedById?: string | null;
}

/**
 * File a filled form against its current published version. With a station,
 * the submission also records the station's workcenter and the job it runs
 * right now.
 */
export async function submit(input: SubmitFormInput) {
  const found = await findForm(input.documentId);
  if (found.error !== undefined) return found;
  const document = found.data;

  if (!document.currentFormId) {
    return { error: "This form isn't published yet", code: "NO_CURRENT_VERSION" };
  }
  if (input.formId !== document.currentFormId) {
    return { error: "This form was updated. Reload to fill the latest version.", code: "FORM_OUTDATED" };
  }

  const form = await prisma.documentForm.findUnique({
    where: { id: document.currentFormId },
    select: { fields: true },
  });
  const checked = validateAnswers(readManifest(form?.fields), input.answers);
  if (checked.error !== undefined) return checked;

  let siteId = document.siteId;
  let workcenterId: string | null = null;
  let jobId: string | null = null;
  if (input.stationId) {
    const station = await prisma.station.findUnique({
      where: { id: input.stationId },
      select: { siteId: true, workcenterId: true, currentJobId: true, deletedAt: true },
    });
    if (!station || station.deletedAt) return { error: "Station not found", code: "STATION_NOT_FOUND" };
    if (document.siteId && document.siteId !== station.siteId) {
      return { error: "This form belongs to another site", code: "SITE_MISMATCH" };
    }
    siteId = station.siteId;
    workcenterId = station.workcenterId;
    jobId = station.currentJobId;
  }

  // TODO(forms): publish a `form.submitted` domain event (runtime *-events.ts
  // subject + stream) once something consumes it.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const created = await prisma.$transaction(async (tx) => {
        const latest = await tx.formSubmission.aggregate({
          where: { documentId: input.documentId },
          _max: { number: true },
        });
        return tx.formSubmission.create({
          data: {
            number: (latest._max.number ?? 0) + 1,
            documentId: input.documentId,
            formId: input.formId,
            answers: checked.data as Prisma.InputJsonValue,
            siteId,
            workcenterId,
            stationId: input.stationId ?? null,
            jobId,
            submittedById: input.submittedById ?? null,
          },
          include: submissionInclude,
        });
      });
      return { data: toSubmission(created) };
    } catch (error) {
      // Two submissions took the same number; the next attempt reads the new max.
      if (!isUniqueViolation(error)) throw error;
    }
  }
  return { error: "Too many submissions at once; try again", code: "VERSION_CONFLICT" };
}

export interface ListSubmissionsInput {
  documentId: string;
  stationId?: string | null;
  limit?: number;
  offset?: number;
}

/** A form's submissions, newest first. */
export async function listSubmissions(input: ListSubmissionsInput) {
  const found = await findForm(input.documentId);
  if (found.error !== undefined) return found;

  const { limit = 50, offset = 0 } = input;
  const where: Prisma.FormSubmissionWhereInput = {
    documentId: input.documentId,
    ...(input.stationId ? { stationId: input.stationId } : {}),
  };
  const [records, total] = await Promise.all([
    prisma.formSubmission.findMany({
      where,
      include: submissionInclude,
      orderBy: [{ submittedAt: "desc" }, { number: "desc" }],
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
    }),
    prisma.formSubmission.count({ where }),
  ]);

  return { data: { items: records.map(toSubmissionSummary), total } };
}

/** One submission with its answers and the version it was filled on. */
export async function getSubmission(submissionId: string) {
  const record = await prisma.formSubmission.findUnique({ where: { id: submissionId }, include: submissionInclude });
  if (!record) return { error: "Submission not found", code: "SUBMISSION_NOT_FOUND" };
  return { data: toSubmission(record) };
}

/** Which document a submission belongs to, for the access check before reading it. */
export async function submissionDocumentId(submissionId: string): Promise<string | null> {
  const record = await prisma.formSubmission.findUnique({ where: { id: submissionId }, select: { documentId: true } });
  return record?.documentId ?? null;
}
