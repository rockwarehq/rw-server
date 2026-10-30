/*
 * A form's field manifest: what the server knows about the fields in a form's
 * editor document (TipTap JSON). The editor owns layout; the manifest is the
 * contract every answer is checked against, so the server derives it — the
 * client never sends one. Pure: no database, unit-tested in manifest.test.ts.
 *
 * A field is a node whose `type` ends in "Field" (checklistField,
 * numberField…), with attrs `fieldId`, `label` and `required`. Everything else
 * (paragraphs, headings, images, lists) is layout and ignored; the walk goes
 * into their children, never into a field's.
 */

export type ChecklistItem = { id: string; label: string };

interface BaseField {
  id: string;
  label: string;
  required: boolean;
}

export type FormField =
  | (BaseField & { type: "checklist"; items: ChecklistItem[] })
  | (BaseField & { type: "checkbox"; hint: string | null })
  | (BaseField & { type: "shortText" })
  | (BaseField & { type: "longText" })
  | (BaseField & { type: "number"; min: number | null; max: number | null; step: number | null })
  | (BaseField & { type: "dropdown"; options: string[] })
  | (BaseField & { type: "multipleChoice"; options: string[]; allowMultiple: boolean })
  | (BaseField & { type: "date"; includeTime: boolean })
  | (BaseField & { type: "rating"; scale: number });

export type FormFieldType = FormField["type"];

export type ManifestError = { error: string; code: "INVALID_FORM" | "NO_FIELDS"; data?: undefined };
export type AnswersError = { error: string; code: "INVALID_ANSWERS"; data?: undefined };

/** Serialized content larger than this is refused (saveDraft and publish). */
export const MAX_CONTENT_BYTES = 512 * 1024;
export const MAX_SHORT_TEXT = 1000;
export const MAX_LONG_TEXT = 20000;

const NODE_TYPES: Record<string, FormFieldType> = {
  checklistField: "checklist",
  checkboxField: "checkbox",
  shortTextField: "shortText",
  longTextField: "longText",
  numberField: "number",
  dropdownField: "dropdown",
  multipleChoiceField: "multipleChoice",
  dateField: "date",
  ratingField: "rating",
};

type Attrs = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalNumber(value: unknown): number | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

/** The type-specific part of a field, or an error message naming what is wrong. */
function fieldExtras(type: FormFieldType, attrs: Attrs): Record<string, unknown> | string {
  switch (type) {
    case "checklist": {
      if (!Array.isArray(attrs.items)) return "needs at least one item";
      const items: ChecklistItem[] = [];
      const seen = new Set<string>();
      for (const item of attrs.items) {
        if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) return "has an item without an id";
        if (seen.has(item.id)) return "has two items with the same id";
        seen.add(item.id);
        items.push({ id: item.id, label: typeof item.label === "string" ? item.label : "" });
      }
      return items.length > 0 ? { items } : "needs at least one item";
    }
    case "checkbox":
      return { hint: typeof attrs.hint === "string" && attrs.hint.trim() ? attrs.hint : null };
    case "shortText":
    case "longText":
      return {};
    case "number": {
      const min = optionalNumber(attrs.min);
      const max = optionalNumber(attrs.max);
      const step = optionalNumber(attrs.step);
      if (min === undefined || max === undefined || step === undefined) return "has a limit that is not a number";
      if (min !== null && max !== null && min > max) return "has a minimum above its maximum";
      if (step !== null && step <= 0) return "needs a step above zero";
      return { min, max, step };
    }
    case "dropdown": {
      const options = stringList(attrs.options);
      return options && options.length > 0 ? { options } : "needs at least one option";
    }
    case "multipleChoice": {
      const options = stringList(attrs.options);
      if (!options || options.length === 0) return "needs at least one option";
      return { options, allowMultiple: attrs.allowMultiple === true };
    }
    case "date":
      return { includeTime: attrs.includeTime === true };
    case "rating": {
      const scale = attrs.scale;
      if (typeof scale !== "number" || !Number.isInteger(scale) || scale < 2 || scale > 10) {
        return "needs a scale from 2 to 10";
      }
      return { scale };
    }
  }
}

function describe(nodeType: string, attrs: Attrs): string {
  const label = typeof attrs.label === "string" && attrs.label.trim() ? attrs.label.trim() : null;
  return label ? `"${label}"` : `A ${nodeType}`;
}

/**
 * The manifest of a form's content, in document order.
 *
 * strict (publish): any unknown `*Field` node, missing or duplicate fieldId,
 * or malformed field is an INVALID_FORM error naming it, and a form with no
 * fields is NO_FIELDS. lenient (saveDraft): those nodes are skipped instead,
 * so a half-built draft still shows the fields that are ready.
 */
export function buildManifest(
  content: unknown,
  mode: "strict" | "lenient",
): { data: FormField[]; error?: undefined } | ManifestError {
  const fields: FormField[] = [];
  const ids = new Set<string>();
  let failure: string | null = null;

  const visit = (node: unknown): void => {
    if (failure || !isRecord(node)) return;
    const nodeType = typeof node.type === "string" ? node.type : "";

    if (nodeType.endsWith("Field")) {
      const attrs = isRecord(node.attrs) ? node.attrs : {};
      const type = NODE_TYPES[nodeType];
      if (!type) {
        if (mode === "strict") failure = `Unknown field type "${nodeType}"`;
        return;
      }
      const id = typeof attrs.fieldId === "string" ? attrs.fieldId.trim() : "";
      if (!id) {
        if (mode === "strict") failure = `${describe(nodeType, attrs)} has no field id`;
        return;
      }
      if (ids.has(id)) {
        if (mode === "strict") failure = `${describe(nodeType, attrs)} reuses field id "${id}"`;
        return;
      }
      const extras = fieldExtras(type, attrs);
      if (typeof extras === "string") {
        if (mode === "strict") failure = `${describe(nodeType, attrs)} ${extras}`;
        return;
      }
      ids.add(id);
      fields.push({
        id,
        type,
        label: typeof attrs.label === "string" ? attrs.label : "",
        required: attrs.required === true,
        ...extras,
      } as FormField);
      return;
    }

    if (Array.isArray(node.content)) {
      for (const child of node.content) visit(child);
    }
  };

  visit(content);

  if (failure) return { error: failure, code: "INVALID_FORM" };
  if (mode === "strict" && fields.length === 0) {
    return { error: "Add at least one field before publishing", code: "NO_FIELDS" };
  }
  return { data: fields };
}

/** A stored manifest (Json column) read back; entries that do not parse are dropped. */
export function readManifest(value: unknown): FormField[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (field): field is FormField => isRecord(field) && typeof field.id === "string" && typeof field.type === "string",
  );
}

function fieldName(field: FormField): string {
  return field.label.trim() || field.id;
}

/** True when an answer counts as given (empty text, empty lists and false checkboxes do not). */
function isProvided(field: FormField, value: unknown): boolean {
  if (value === undefined || value === null) return false;
  switch (field.type) {
    case "checklist":
      return isRecord(value) && Object.values(value).some((checked) => checked === true);
    case "checkbox":
      return value === true;
    case "shortText":
    case "longText":
    case "dropdown":
    case "date":
      return typeof value === "string" && value.trim() !== "";
    case "multipleChoice":
      return Array.isArray(value) ? value.length > 0 : typeof value === "string" && value.trim() !== "";
    case "number":
    case "rating":
      return true;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** The answer as stored, or an error message ending a sentence that starts with the field's name. */
function checkAnswer(field: FormField, value: unknown): { value: unknown } | string {
  switch (field.type) {
    case "checklist": {
      if (!isRecord(value)) return "must be a checklist";
      const checked: Record<string, boolean> = {};
      for (const item of field.items) {
        const answer = value[item.id];
        if (answer === undefined || answer === null) continue;
        if (typeof answer !== "boolean") return "must be ticked or unticked";
        checked[item.id] = answer;
      }
      return { value: checked };
    }
    case "checkbox":
      return typeof value === "boolean" ? { value } : "must be ticked or unticked";
    case "shortText":
    case "longText": {
      if (typeof value !== "string") return "must be text";
      const limit = field.type === "shortText" ? MAX_SHORT_TEXT : MAX_LONG_TEXT;
      return value.length > limit ? `must be at most ${limit} characters` : { value };
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "must be a number";
      if (field.min !== null && value < field.min) return `must be at least ${field.min}`;
      if (field.max !== null && value > field.max) return `must be at most ${field.max}`;
      return { value };
    }
    case "dropdown":
      return typeof value === "string" && field.options.includes(value) ? { value } : "must be one of its options";
    case "multipleChoice": {
      if (field.allowMultiple) {
        const picked = Array.isArray(value) ? value : typeof value === "string" ? [value] : null;
        if (!picked?.every((item) => typeof item === "string" && field.options.includes(item))) {
          return "must be among its options";
        }
        return { value: [...new Set(picked as string[])] };
      }
      return typeof value === "string" && field.options.includes(value) ? { value } : "must be one of its options";
    }
    case "date": {
      if (typeof value !== "string") return "must be a date";
      const shape = field.includeTime ? ISO_DATE_TIME.test(value) || ISO_DATE.test(value) : ISO_DATE.test(value);
      if (!shape || Number.isNaN(Date.parse(value))) {
        return field.includeTime ? "must be a date and time" : "must be a date (YYYY-MM-DD)";
      }
      return { value };
    }
    case "rating":
      return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= field.scale
        ? { value }
        : `must be a rating from 1 to ${field.scale}`;
  }
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Check a submission's answers against a published manifest. Keys that are
 * not fields are dropped, as are answers that are not provided (null, empty
 * text, empty lists). Every provided answer must fit its field, and every
 * required field must be provided — a required checklist has every item
 * ticked, a required checkbox is ticked. Errors are user-ready sentences.
 */
export function validateAnswers(
  fields: FormField[],
  answers: Record<string, unknown>,
): { data: Record<string, unknown>; error?: undefined } | AnswersError {
  const clean: Record<string, unknown> = {};
  const invalid: string[] = [];
  const missing: string[] = [];

  for (const field of fields) {
    const raw = answers[field.id];
    if (raw !== undefined && raw !== null) {
      const checked = checkAnswer(field, raw);
      if (typeof checked === "string") {
        invalid.push(`${fieldName(field)} ${checked}.`);
        continue;
      }
      if (isProvided(field, checked.value)) clean[field.id] = checked.value;
    }

    if (!field.required) continue;
    const value = clean[field.id];
    const complete =
      field.type === "checklist"
        ? value !== undefined && field.items.every((item) => (value as Record<string, boolean>)[item.id] === true)
        : value !== undefined;
    if (!complete) missing.push(fieldName(field));
  }

  if (invalid.length > 0) return { error: invalid.join(" "), code: "INVALID_ANSWERS" };
  if (missing.length > 0) {
    return { error: `Please complete ${joinNames(missing)}.`, code: "INVALID_ANSWERS" };
  }
  return { data: clean };
}

/**
 * How much of a submission is filled: each checklist item counts on its own
 * (ticked = answered), every other field counts once when provided.
 */
export function answerProgress(
  fields: FormField[],
  answers: Record<string, unknown>,
): { answered: number; total: number } {
  let answered = 0;
  let total = 0;
  for (const field of fields) {
    const value = answers[field.id];
    if (field.type === "checklist") {
      total += field.items.length;
      if (isRecord(value)) answered += field.items.filter((item) => value[item.id] === true).length;
      continue;
    }
    total += 1;
    if (isProvided(field, value)) answered += 1;
  }
  return { answered, total };
}
