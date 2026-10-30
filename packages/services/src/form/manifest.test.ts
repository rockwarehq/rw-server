import { describe, expect, test } from "vitest";
import { answerProgress, buildManifest, readManifest, validateAnswers, type FormField } from "./manifest.js";

function field(type: string, attrs: Record<string, unknown>) {
  return { type, attrs };
}

const doc = (...content: unknown[]) => ({ type: "doc", content });

const checklist = field("checklistField", {
  fieldId: "checks",
  label: "Safety checks",
  required: true,
  items: [
    { id: "guard", label: "Guard closed" },
    { id: "estop", label: "E-stop tested" },
  ],
});

const fullForm = doc(
  { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Startup" }] },
  checklist,
  {
    type: "bulletList",
    content: [
      {
        type: "listItem",
        content: [field("checkboxField", { fieldId: "ok", label: "All good", required: false, hint: "Tick it" })],
      },
    ],
  },
  field("shortTextField", { fieldId: "lot", label: "Lot", required: true }),
  field("longTextField", { fieldId: "notes", label: "Notes", required: false }),
  field("numberField", { fieldId: "temp", label: "Temperature", required: false, min: 10, max: 90, step: null }),
  field("dropdownField", { fieldId: "shift", label: "Shift", required: false, options: ["A", "B"] }),
  field("multipleChoiceField", {
    fieldId: "defects",
    label: "Defects",
    required: false,
    options: ["Flash", "Short", "Burn"],
    allowMultiple: true,
  }),
  field("dateField", { fieldId: "when", label: "When", required: false, includeTime: false }),
  field("ratingField", { fieldId: "quality", label: "Quality", required: false, scale: 5 }),
);

describe("buildManifest", () => {
  test("walks nested content and keeps fields in document order with their extras", () => {
    const result = buildManifest(fullForm, "strict");
    expect(result.error).toBeUndefined();
    const fields = result.data as FormField[];
    expect(fields.map((f) => [f.id, f.type])).toEqual([
      ["checks", "checklist"],
      ["ok", "checkbox"],
      ["lot", "shortText"],
      ["notes", "longText"],
      ["temp", "number"],
      ["shift", "dropdown"],
      ["defects", "multipleChoice"],
      ["when", "date"],
      ["quality", "rating"],
    ]);
    expect(fields[0]).toEqual({
      id: "checks",
      type: "checklist",
      label: "Safety checks",
      required: true,
      items: [
        { id: "guard", label: "Guard closed" },
        { id: "estop", label: "E-stop tested" },
      ],
    });
    expect(fields[1]).toMatchObject({ hint: "Tick it", required: false });
    expect(fields[4]).toMatchObject({ min: 10, max: 90, step: null });
    expect(fields[6]).toMatchObject({ options: ["Flash", "Short", "Burn"], allowMultiple: true });
    expect(fields[8]).toMatchObject({ scale: 5 });
  });

  test("strict: no fields is NO_FIELDS", () => {
    expect(buildManifest(doc({ type: "paragraph" }), "strict")).toMatchObject({ code: "NO_FIELDS" });
    expect(buildManifest(doc(), "lenient")).toEqual({ data: [] });
  });

  test("strict: unknown field types are rejected by name", () => {
    const result = buildManifest(doc(field("signatureField", { fieldId: "sig", label: "Sign" })), "strict");
    expect(result).toEqual({ error: 'Unknown field type "signatureField"', code: "INVALID_FORM" });
  });

  test("strict: empty and duplicate field ids are rejected", () => {
    const empty = buildManifest(doc(field("shortTextField", { fieldId: " ", label: "Lot" })), "strict");
    expect(empty).toMatchObject({ code: "INVALID_FORM" });
    expect(empty.error).toContain('"Lot"');

    const dup = buildManifest(
      doc(
        field("shortTextField", { fieldId: "a", label: "One" }),
        field("longTextField", { fieldId: "a", label: "Two" }),
      ),
      "strict",
    );
    expect(dup).toMatchObject({ code: "INVALID_FORM" });
    expect(dup.error).toContain('reuses field id "a"');
  });

  test("strict: malformed fields are rejected", () => {
    const cases = [
      field("checklistField", { fieldId: "c", label: "C", items: [] }),
      field("dropdownField", { fieldId: "d", label: "D", options: [] }),
      field("numberField", { fieldId: "n", label: "N", min: 5, max: 1 }),
      field("numberField", { fieldId: "n", label: "N", min: "x" }),
      field("ratingField", { fieldId: "r", label: "R", scale: 11 }),
      field("ratingField", { fieldId: "r", label: "R" }),
    ];
    for (const node of cases) {
      expect(buildManifest(doc(node), "strict")).toMatchObject({ code: "INVALID_FORM" });
    }
  });

  test("lenient: skips what strict rejects and keeps the rest", () => {
    const result = buildManifest(
      doc(
        field("signatureField", { fieldId: "sig" }),
        field("shortTextField", { fieldId: "", label: "No id" }),
        field("shortTextField", { fieldId: "a", label: "First" }),
        field("shortTextField", { fieldId: "a", label: "Dup" }),
        field("ratingField", { fieldId: "r", label: "R", scale: 1 }),
      ),
      "lenient",
    );
    expect(result.data?.map((f) => f.label)).toEqual(["First"]);
  });

  test("readManifest drops junk", () => {
    expect(readManifest(null)).toEqual([]);
    expect(readManifest([{ id: "a", type: "shortText", label: "A", required: false }, 3, {}])).toHaveLength(1);
  });
});

describe("validateAnswers", () => {
  const fields = buildManifest(fullForm, "strict").data as FormField[];
  const minimal = { checks: { guard: true, estop: true }, lot: "L-1" };

  test("accepts a complete submission and drops unknown keys and empty answers", () => {
    const result = validateAnswers(fields, { ...minimal, notes: "", extra: 1, temp: null, shift: "A" });
    expect(result).toEqual({ data: { checks: { guard: true, estop: true }, lot: "L-1", shift: "A" } });
  });

  test("lists missing required fields by label", () => {
    const result = validateAnswers(fields, { checks: { guard: true }, lot: "  " });
    expect(result).toEqual({ error: "Please complete Safety checks and Lot.", code: "INVALID_ANSWERS" });
  });

  test("a required checkbox must be ticked", () => {
    const box = buildManifest(doc(field("checkboxField", { fieldId: "x", label: "Agree", required: true })), "strict")
      .data as FormField[];
    expect(validateAnswers(box, { x: false })).toMatchObject({ code: "INVALID_ANSWERS" });
    expect(validateAnswers(box, { x: true })).toEqual({ data: { x: true } });
  });

  test("type-checks each answer", () => {
    const bad: Record<string, unknown>[] = [
      { temp: "40" },
      { temp: 5 },
      { temp: 91 },
      { shift: "C" },
      { defects: ["Flash", "Nope"] },
      { when: "yesterday" },
      { when: "2026-10-30T10:00" },
      { quality: 6 },
      { quality: 2.5 },
      { ok: "yes" },
      { lot: 7 },
      { checks: { guard: "yes", estop: true } },
    ];
    for (const extra of bad) {
      const result = validateAnswers(fields, { ...minimal, ...extra });
      expect(result, JSON.stringify(extra)).toMatchObject({ code: "INVALID_ANSWERS" });
    }
  });

  test("accepts well-typed answers", () => {
    const result = validateAnswers(fields, {
      ...minimal,
      temp: 10,
      defects: ["Flash", "Flash", "Burn"],
      when: "2026-10-30",
      quality: 5,
      ok: true,
    });
    expect(result.data).toMatchObject({ temp: 10, defects: ["Flash", "Burn"], when: "2026-10-30", quality: 5 });
  });

  test("single multiple choice takes one option; date with time takes ISO date-times", () => {
    const own = buildManifest(
      doc(
        field("multipleChoiceField", { fieldId: "m", label: "M", options: ["x", "y"], allowMultiple: false }),
        field("dateField", { fieldId: "d", label: "D", includeTime: true }),
      ),
      "strict",
    ).data as FormField[];
    expect(validateAnswers(own, { m: "x", d: "2026-10-30T10:15:00.000Z" })).toEqual({
      data: { m: "x", d: "2026-10-30T10:15:00.000Z" },
    });
    expect(validateAnswers(own, { m: ["x"] })).toMatchObject({ code: "INVALID_ANSWERS" });
  });
});

describe("answerProgress", () => {
  test("checklist items count on their own, other fields once when provided", () => {
    const fields = buildManifest(fullForm, "strict").data as FormField[];
    expect(answerProgress(fields, {})).toEqual({ answered: 0, total: 10 });
    expect(answerProgress(fields, { checks: { guard: true, estop: false }, lot: "L", ok: false, temp: 0 })).toEqual({
      answered: 3,
      total: 10,
    });
  });
});
