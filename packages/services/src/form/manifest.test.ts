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

describe("computed fields and names", () => {
  const inspected = field("numberField", { fieldId: "f1", key: "inspected", label: "Inspected" });
  const good = field("numberField", { fieldId: "f2", key: "good", label: "Good" });
  const computed = (attrs: Record<string, unknown>) =>
    field("computedField", { fieldId: "rate", key: "rate", label: "Scrap rate", ...attrs });

  test("parses a computed field with its display settings, never required", () => {
    const result = buildManifest(
      doc(
        inspected,
        good,
        computed({ formula: "(inspected - good) / inspected", required: true, decimals: 1, percent: true }),
      ),
      "strict",
    );
    expect(result.error).toBeUndefined();
    expect(result.data?.[0]).toEqual({
      id: "f1",
      type: "number",
      label: "Inspected",
      required: false,
      key: "inspected",
      min: null,
      max: null,
      step: null,
    });
    expect(result.data?.[2]).toEqual({
      id: "rate",
      type: "computed",
      label: "Scrap rate",
      required: false,
      key: "rate",
      formula: "(inspected - good) / inspected",
      decimals: 1,
      unit: "",
      percent: true,
    });
  });

  test("defaults decimals to 2, keeps null, refuses out of range", () => {
    const parsed = (attrs: Record<string, unknown>) =>
      buildManifest(doc(inspected, computed({ formula: "inspected", ...attrs })), "strict");
    expect(parsed({}).data?.[1]).toMatchObject({ decimals: 2, unit: "", percent: false });
    expect(parsed({ decimals: null, unit: " pcs " }).data?.[1]).toMatchObject({ decimals: null, unit: "pcs" });
    expect(parsed({ decimals: 5 })).toMatchObject({ code: "INVALID_FORM" });
    expect(parsed({ unit: "x".repeat(21) })).toMatchObject({ code: "INVALID_FORM" });
  });

  test("fields without a key are fine and an empty key is no key", () => {
    const result = buildManifest(doc(field("shortTextField", { fieldId: "lot", label: "Lot", key: "" })), "strict");
    expect(result.data?.[0]).not.toHaveProperty("key");
  });

  test("lenient keeps keys and formulas as they are", () => {
    const result = buildManifest(
      doc(
        field("numberField", { fieldId: "a", key: "Bad Key", label: "A" }),
        field("numberField", { fieldId: "b", key: "Bad Key", label: "B" }),
        computed({ formula: "nope +" }),
      ),
      "lenient",
    );
    expect(result.data?.map((f) => f.key)).toEqual(["Bad Key", "Bad Key", "rate"]);
    expect(result.data?.[2]).toMatchObject({ formula: "nope +" });
  });

  test("strict refuses unusable, reserved and duplicate keys by field label", () => {
    const bad = buildManifest(doc(field("numberField", { fieldId: "a", key: "Bad Key", label: "Count" })), "strict");
    expect(bad).toMatchObject({ code: "INVALID_FORM" });
    expect(bad.error).toContain('"Count"');
    const reserved = buildManifest(doc(field("numberField", { fieldId: "a", key: "max", label: "Max" })), "strict");
    expect(reserved).toMatchObject({ code: "INVALID_FORM" });
    const dup = buildManifest(
      doc(
        field("numberField", { fieldId: "a", key: "count", label: "First" }),
        field("numberField", { fieldId: "b", key: "count", label: "Second" }),
      ),
      "strict",
    );
    expect(dup).toEqual({ error: '"First" and "Second" have the same name "count"', code: "INVALID_FORM" });
  });

  test("strict refuses bad formulas, unknown names and loops", () => {
    const publish = (...nodes: unknown[]) => buildManifest(doc(inspected, good, ...nodes), "strict");
    expect(publish(computed({ formula: "" }))).toEqual({ error: "Scrap rate: Write a formula", code: "INVALID_FORM" });
    expect(publish(computed({ formula: "inspected -" }))).toEqual({
      error: "Scrap rate: The formula isn't complete",
      code: "INVALID_FORM",
    });
    expect(publish(computed({ formula: "inspected - bad", label: "" }))).toEqual({
      error: 'Calculation: No field is named "bad"',
      code: "INVALID_FORM",
    });
    expect(publish(computed({ formula: "rate + 1" }))).toEqual({
      error: "Scrap rate: A formula can't use its own result",
      code: "INVALID_FORM",
    });
    expect(
      publish(
        field("computedField", { fieldId: "x", key: "x", label: "X", formula: "y + 1" }),
        field("computedField", { fieldId: "y", key: "y", label: "Y", formula: "x + 1" }),
      ),
    ).toEqual({ error: "X: These formulas use each other's results", code: "INVALID_FORM" });
  });

  test("computed answers are never taken from the client and don't count toward progress", () => {
    const fields = buildManifest(doc(inspected, good, computed({ formula: "inspected - good" })), "strict")
      .data as FormField[];
    expect(validateAnswers(fields, { f1: 5, f2: 4, rate: "junk" })).toEqual({ data: { f1: 5, f2: 4 } });
    expect(answerProgress(fields, { f1: 5, rate: 1 })).toEqual({ answered: 1, total: 2 });
  });
});
