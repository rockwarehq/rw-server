import Ajv from "ajv";
import type { ErrorObject } from "ajv";
import { driverRegistry } from "./device/driver/index.js";

const ajv = new Ajv.default({ allErrors: true, strict: false, coerceTypes: true });

export interface ValidationResult {
  valid: boolean;
  errors?: ValidationError[];
}

export interface ValidationError {
  [x: string]: unknown;
  path: string;
  message: string;
  keyword: string;
}

/**
 * Format AJV errors into a cleaner structure
 */
function formatErrors(errors: ErrorObject[] | null | undefined): ValidationError[] {
  if (!errors) return [];

  return errors.map((err) => ({
    path: err.instancePath || "/",
    message: err.message || "Validation error",
    keyword: err.keyword,
  }));
}

/**
 * Validate data against a JSON Schema
 */
function validateSchema(schema: Record<string, unknown>, data: unknown): ValidationResult {
  const validate = ajv.compile(schema);
  const valid = validate(data);

  return {
    valid,
    errors: valid ? undefined : formatErrors(validate.errors),
  };
}

/**
 * Validate datasource connection against driver's connectionSchema
 */
export function validateConnection(
  driverName: string,
  connection: Record<string, unknown>,
  driverVersion?: string,
): ValidationResult {
  const schema = driverRegistry.getConnectionSchema(driverName, driverVersion);

  if (!schema) {
    return {
      valid: false,
      errors: [
        {
          path: "/",
          message: `Driver "${driverName}" not found or has no connectionSchema`,
          keyword: "driver",
        },
      ],
    };
  }

  return validateSchema(schema, connection);
}

/**
 * Validate point config against driver's pointSchema
 * If driver has no pointSchema, any config is valid (empty schema)
 */
export function validatePointConfig(
  driverName: string,
  config: Record<string, unknown>,
  driverVersion?: string,
): ValidationResult {
  const schema = driverRegistry.getPointSchema(driverName, driverVersion);

  // If no schema defined, config is optional - anything goes
  if (!schema) {
    return { valid: true };
  }

  return validateSchema(schema, config);
}

/**
 * Validate point group config against driver's pointGroupSchema
 * If driver has no pointGroupSchema, any config is valid (empty schema)
 */
export function validatePointGroupConfig(
  driverName: string,
  config: Record<string, unknown>,
  driverVersion?: string,
): ValidationResult {
  const schema = driverRegistry.getPointGroupSchema(driverName, driverVersion);

  // If no schema defined, config is optional - anything goes
  if (!schema) {
    return { valid: true };
  }

  return validateSchema(schema, config);
}

/**
 * Check if a driver exists in the registry
 */
export function driverExists(driverName: string, driverVersion?: string): boolean {
  return driverRegistry.has(driverName, driverVersion);
}

/**
 * Get driver info for creating datasource (returns latest version if not specified)
 */
export function getDriverInfo(driverName: string, driverVersion?: string) {
  return driverRegistry.get(driverName, driverVersion);
}

// ============================================================================
// Password Validation
// ============================================================================

export interface PasswordValidationResult {
  valid: boolean;
  errors: string[];
}

const PASSWORD_MIN_LENGTH = 12;

/**
 * Validate password strength according to security policy:
 * - Minimum 12 characters
 * - At least one uppercase letter
 * - At least one lowercase letter
 * - At least one number
 * - At least one special character
 */
export function validatePasswordStrength(password: string): PasswordValidationResult {
  const errors: string[] = [];

  if (password.length < PASSWORD_MIN_LENGTH) {
    errors.push(`Password must be at least ${PASSWORD_MIN_LENGTH} characters long`);
  }

  if (!/[A-Z]/.test(password)) {
    errors.push("Password must contain at least one uppercase letter");
  }

  if (!/[a-z]/.test(password)) {
    errors.push("Password must contain at least one lowercase letter");
  }

  if (!/[0-9]/.test(password)) {
    errors.push("Password must contain at least one number");
  }

  if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?~`]/.test(password)) {
    errors.push("Password must contain at least one special character");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
