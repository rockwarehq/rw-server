import sql from "mssql";
import { z } from "zod";
import type { ActionContext, ActionDefinition, IntegrationType } from "./types.js";

// Runs in rw-server: on-prem the whole stack sits on a machine that can already
// reach the plant's SQL Server. Callers hand over parameter values already bound.

const configSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(1433),
  database: z.string().min(1),
  username: z.string().min(1),
  encrypt: z.boolean().default(true),
  trustServerCertificate: z.boolean().default(false),
  connectTimeoutMs: z.number().int().min(1_000).max(120_000).default(15_000),
  poolMax: z.number().int().min(1).max(50).default(5),
  /** Close idle pooled connections after this long. */
  idleTimeoutMs: z.number().int().min(1_000).max(600_000).default(30_000),
});

const secretSchema = z.object({
  password: z.string().min(1),
});

export type SqlServerConfig = z.infer<typeof configSchema>;
export type SqlServerSecret = z.infer<typeof secretSchema>;

export const SQL_PARAMETER_TYPES = [
  "string",
  "int",
  "bigint",
  "decimal",
  "float",
  "bit",
  "datetime",
  "uniqueidentifier",
] as const;

export type SqlParameterType = (typeof SQL_PARAMETER_TYPES)[number];

const parameterSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Parameter name must be alphanumeric/underscore and start with a letter"),
  type: z.enum(SQL_PARAMETER_TYPES),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  /** OUTPUT parameter — the value is returned in the result rather than sent. */
  output: z.boolean().default(false),
});

export type SqlParameter = z.infer<typeof parameterSchema>;

const executeInputSchema = z.object({
  // Optional schema qualifier plus name, e.g. "dbo.RecordCycle". Restricted
  // rather than escaped — mssql sends this as the procedure to EXEC.
  procedure: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/, "Procedure must be a plain or schema-qualified name"),
  parameters: z.array(parameterSchema).max(64).default([]),
  timeoutMs: z.number().int().min(1_000).max(300_000).default(30_000),
});

export type SqlServerExecuteInput = z.infer<typeof executeInputSchema>;

export interface SqlServerExecuteResult {
  returnValue: number | null;
  rowsAffected: number[];
  output: Record<string, unknown>;
  /** First recordset only. This action is for procedure calls, not bulk reads. */
  recordset: unknown[];
}

// Keyed by integration id, rebuilt when connection details change.
interface PooledConnection {
  fingerprint: string;
  pool: sql.ConnectionPool;
}

const pools = new Map<string, PooledConnection>();

function fingerprint(config: SqlServerConfig, secret: SqlServerSecret): string {
  return JSON.stringify([
    config.host,
    config.port,
    config.database,
    config.username,
    config.encrypt,
    config.trustServerCertificate,
    config.poolMax,
    secret.password,
  ]);
}

async function getPool(
  integrationId: string,
  config: SqlServerConfig,
  secret: SqlServerSecret,
): Promise<sql.ConnectionPool> {
  const wanted = fingerprint(config, secret);
  const existing = pools.get(integrationId);

  if (existing) {
    if (existing.fingerprint === wanted && existing.pool.connected) return existing.pool;
    pools.delete(integrationId);
    await existing.pool.close().catch(() => undefined);
  }

  const pool = new sql.ConnectionPool({
    server: config.host,
    port: config.port,
    database: config.database,
    user: config.username,
    password: secret.password,
    connectionTimeout: config.connectTimeoutMs,
    pool: { max: config.poolMax, min: 0, idleTimeoutMillis: config.idleTimeoutMs },
    options: {
      encrypt: config.encrypt,
      trustServerCertificate: config.trustServerCertificate,
    },
  });

  // A dead pool must not stay cached, or later calls inherit the broken handle.
  pool.on("error", () => {
    if (pools.get(integrationId)?.pool === pool) pools.delete(integrationId);
  });

  await pool.connect();
  pools.set(integrationId, { fingerprint: wanted, pool });
  return pool;
}

/** Close every pooled connection. Call on shutdown, or after deleting an integration. */
export async function closeSqlServerPools(integrationId?: string): Promise<void> {
  const entries = integrationId
    ? ([[integrationId, pools.get(integrationId)]] as const)
    : ([...pools.entries()] as const);

  for (const [id, entry] of entries) {
    if (!entry) continue;
    pools.delete(id);
    await entry.pool.close().catch(() => undefined);
  }
}

export function sqlTypeFor(type: SqlParameterType): sql.ISqlType {
  switch (type) {
    case "string":
      return sql.NVarChar(sql.MAX);
    case "int":
      return sql.Int();
    case "bigint":
      return sql.BigInt();
    case "decimal":
      return sql.Decimal(38, 10);
    case "float":
      return sql.Float();
    case "bit":
      return sql.Bit();
    case "datetime":
      return sql.DateTime2();
    case "uniqueidentifier":
      return sql.UniqueIdentifier();
  }
}

/** Coerce a JSON-transportable value into what tedious expects for the declared type. */
export function coerceParameterValue(parameter: SqlParameter): unknown {
  if (parameter.value === null) return null;

  switch (parameter.type) {
    case "datetime": {
      const date = typeof parameter.value === "number" ? new Date(parameter.value) : new Date(String(parameter.value));
      if (Number.isNaN(date.getTime())) {
        throw new Error(`Parameter ${parameter.name} is not a valid datetime: ${String(parameter.value)}`);
      }
      return date;
    }
    case "bit":
      return typeof parameter.value === "boolean" ? parameter.value : Boolean(parameter.value);
    case "int":
    case "bigint":
    case "decimal":
    case "float": {
      const numeric = typeof parameter.value === "number" ? parameter.value : Number(parameter.value);
      if (!Number.isFinite(numeric)) {
        throw new Error(`Parameter ${parameter.name} is not a valid number: ${String(parameter.value)}`);
      }
      return numeric;
    }
    default:
      return String(parameter.value);
  }
}

async function runProcedure(
  input: SqlServerExecuteInput,
  context: ActionContext<SqlServerConfig, SqlServerSecret>,
): Promise<SqlServerExecuteResult> {
  const pool = await getPool(context.integration.id, context.config, context.secret);
  const request = pool.request();

  for (const parameter of input.parameters) {
    const type = sqlTypeFor(parameter.type);
    if (parameter.output) request.output(parameter.name, type, coerceParameterValue(parameter));
    else request.input(parameter.name, type, coerceParameterValue(parameter));
  }

  // mssql's own timeout is pool-level, so bound the request here instead.
  const timeout = setTimeout(() => request.cancel(), input.timeoutMs);
  try {
    const result = await request.execute(input.procedure);
    return {
      returnValue: typeof result.returnValue === "number" ? result.returnValue : null,
      rowsAffected: result.rowsAffected,
      output: result.output ?? {},
      recordset: Array.isArray(result.recordset) ? [...result.recordset] : [],
    };
  } finally {
    clearTimeout(timeout);
  }
}

const executeProcedure: ActionDefinition<SqlServerConfig, SqlServerSecret> = {
  key: "procedure.execute",
  displayName: "Execute Stored Procedure",
  description: "Call a stored procedure with bound parameters.",
  latest: "1",
  versions: {
    "1": {
      inputSchema: executeInputSchema,
      run: (input, context) => runProcedure(input as SqlServerExecuteInput, context),
    },
  },
};

export const sqlServerIntegration: IntegrationType<SqlServerConfig, SqlServerSecret> = {
  type: "sqlserver",
  displayName: "Microsoft SQL Server",
  description: "Execute stored procedures against a SQL Server database.",
  execution: "server",
  configSchema,
  secretSchema,
  actions: [executeProcedure],
};
