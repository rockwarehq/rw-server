import type { ObjectFieldType } from "@rw/db";

export interface FieldDefinition {
  id: string;
  name: string;
  type: ObjectFieldType;
  refSchemaId: string | null;
  isList: boolean;
  required: boolean;
  config: unknown;
  isDeleted?: boolean;
}

export interface FieldConfigInput {
  type: ObjectFieldType;
  refSchemaId?: string | null;
  config?: Record<string, unknown> | null;
}

export interface NormalizedFieldConfig {
  config: Record<string, unknown> | null;
  refSchemaId: string | null;
}

export interface InstanceValueValidationResult {
  values: Record<string, unknown>;
  objectInstanceRefs: string[];
  errors: string[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonCompatible(value: unknown): boolean {
  if (value === null) return true;
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean")
    return Number.isFinite(value as number) || type !== "number";
  if (Array.isArray(value)) return value.every(isJsonCompatible);
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => entry !== undefined && isJsonCompatible(entry));
}

function normalizeSelectOptions(config: Record<string, unknown> | null | undefined): {
  options: Array<{ value: string; label?: string }>;
  errors: string[];
} {
  const rawOptions = Array.isArray(config)
    ? config
    : isRecord(config) && Array.isArray(config.options)
      ? config.options
      : null;
  if (!rawOptions) return { options: [], errors: ["SELECT fields require config.options"] };

  const values = new Set<string>();
  const options: Array<{ value: string; label?: string }> = [];
  const errors: string[] = [];

  for (const [index, option] of rawOptions.entries()) {
    if (typeof option === "string") {
      if (!option.trim()) errors.push(`config.options[${index}] must not be empty`);
      if (values.has(option)) errors.push(`config.options[${index}] duplicates value "${option}"`);
      values.add(option);
      options.push({ value: option, label: option });
      continue;
    }

    if (!isRecord(option) || typeof option.value !== "string" || !option.value.trim()) {
      errors.push(`config.options[${index}] must be a string or an object with a string value`);
      continue;
    }

    const label = typeof option.label === "string" ? option.label : undefined;
    if (values.has(option.value)) errors.push(`config.options[${index}] duplicates value "${option.value}"`);
    values.add(option.value);
    options.push(label === undefined ? { value: option.value } : { value: option.value, label });
  }

  if (options.length === 0) errors.push("SELECT fields require at least one option");
  return { options, errors };
}

export function validateAndNormalizeFieldConfig(input: FieldConfigInput): {
  normalized: NormalizedFieldConfig | null;
  errors: string[];
} {
  const errors: string[] = [];
  const refSchemaId = input.refSchemaId ?? null;
  let config = input.config ?? null;

  if (input.type === "SELECT") {
    const normalized = normalizeSelectOptions(config);
    errors.push(...normalized.errors);
    config = { options: normalized.options };
  } else if (input.type === "OBJECT") {
    if (!refSchemaId) errors.push("OBJECT fields require refSchemaId");
    if (config !== null && !isJsonCompatible(config)) errors.push("config must be JSON-compatible");
  } else {
    if (refSchemaId) errors.push("refSchemaId is only valid for OBJECT fields");
    if (config !== null && !isJsonCompatible(config)) errors.push("config must be JSON-compatible");
  }

  if (errors.length > 0) return { normalized: null, errors };
  return { normalized: { config, refSchemaId }, errors };
}

function selectValues(field: FieldDefinition): Set<string> {
  const config = isRecord(field.config) ? field.config : null;
  const options = Array.isArray(config?.options) ? config.options : [];
  return new Set(
    options
      .map((option) => (isRecord(option) && typeof option.value === "string" ? option.value : null))
      .filter((value): value is string => Boolean(value)),
  );
}

function validateScalarValue(field: FieldDefinition, value: unknown): { value: unknown; ref?: string; error?: string } {
  switch (field.type) {
    case "TEXT":
      return typeof value === "string" ? { value } : { value, error: "must be a string" };
    case "NUMBER":
      return typeof value === "number" && Number.isFinite(value)
        ? { value }
        : { value, error: "must be a finite number" };
    case "BOOLEAN":
      return typeof value === "boolean" ? { value } : { value, error: "must be a boolean" };
    case "DATE":
    case "TIMESTAMP":
      return typeof value === "string" && Number.isFinite(Date.parse(value))
        ? { value }
        : { value, error: "must be an ISO date/time string" };
    case "SELECT": {
      if (typeof value !== "string") return { value, error: "must be a string option value" };
      const values = selectValues(field);
      return values.has(value) ? { value } : { value, error: `must be one of: ${[...values].join(", ")}` };
    }
    case "JSON":
      return isJsonCompatible(value) ? { value } : { value, error: "must be JSON-compatible" };
    case "OBJECT":
      return typeof value === "string" && UUID_PATTERN.test(value)
        ? { value, ref: value }
        : { value, error: "must be an object instance id" };
    default:
      return { value, error: `unsupported field type ${(field as { type: string }).type}` };
  }
}

export function validateInstanceValues(
  fields: readonly FieldDefinition[],
  values: Record<string, unknown>,
): InstanceValueValidationResult {
  const activeFields = fields.filter((field) => !field.isDeleted);
  const fieldByName = new Map(activeFields.map((field) => [field.name, field]));
  const errors: string[] = [];
  const normalized: Record<string, unknown> = {};
  const objectInstanceRefs: string[] = [];

  for (const key of Object.keys(values)) {
    if (!fieldByName.has(key)) errors.push(`unknown field "${key}"`);
  }

  for (const field of activeFields) {
    const hasValue =
      Object.hasOwn(values, field.name) && values[field.name] !== undefined && values[field.name] !== null;
    if (!hasValue) {
      if (field.required) errors.push(`field "${field.name}" is required`);
      continue;
    }

    const raw = values[field.name];
    if (field.isList) {
      if (!Array.isArray(raw)) {
        errors.push(`field "${field.name}" must be an array`);
        continue;
      }
      if (field.required && raw.length === 0) errors.push(`field "${field.name}" requires at least one value`);
      const next: unknown[] = [];
      for (const [index, entry] of raw.entries()) {
        const result = validateScalarValue(field, entry);
        if (result.error) errors.push(`field "${field.name}" item ${index} ${result.error}`);
        else {
          next.push(result.value);
          if (result.ref) objectInstanceRefs.push(result.ref);
        }
      }
      normalized[field.name] = next;
      continue;
    }

    const result = validateScalarValue(field, raw);
    if (result.error) errors.push(`field "${field.name}" ${result.error}`);
    else {
      normalized[field.name] = result.value;
      if (result.ref) objectInstanceRefs.push(result.ref);
    }
  }

  return { values: normalized, objectInstanceRefs: [...new Set(objectInstanceRefs)], errors };
}

export function asValueRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
