import { randomBytes } from "node:crypto";

import { hashToken } from "@rw/auth/secrets";
import prisma from "@rw/db";

import { type CsvTable, parseCsv } from "./csv.js";

// Files for setup imports. Creating an upload returns a one-time token; the
// file is sent with it (PUT /setup/uploads/:id, header x-upload-token), so an
// agent can send a 20,000-row export from the person's machine with curl and
// never copy the rows through its model. An agent can't use its own OAuth
// token there: MCP clients keep it to themselves.

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const UPLOAD_TOKEN_TTL_MS = 30 * 60 * 1000;
/** How long a received file can be proposed from. */
export const UPLOAD_KEEP_MS = 24 * 60 * 60 * 1000;
/** Received files are dropped after this. */
const UPLOAD_PURGE_MS = 7 * 24 * 60 * 60 * 1000;

export async function createUpload(input: {
  siteId: string;
  filename: string;
  createdById: string;
  grantId: string | null;
}) {
  // Housekeeping on the way in: nothing schedules it otherwise.
  await prisma.setupUpload.deleteMany({
    where: { siteId: input.siteId, createdAt: { lt: new Date(Date.now() - UPLOAD_PURGE_MS) } },
  });
  const token = `rw_upl_${randomBytes(24).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + UPLOAD_TOKEN_TTL_MS);
  const row = await prisma.setupUpload.create({
    data: { ...input, tokenHash: hashToken(token), expiresAt },
    select: { id: true },
  });
  return { id: row.id, token, expiresAt };
}

export type ReceiveResult = { ok: true; size: number } | { ok: false; status: 401 | 404 | 409 | 413; message: string };

export async function receiveUpload(id: string, token: string, data: Buffer): Promise<ReceiveResult> {
  if (data.byteLength > MAX_UPLOAD_BYTES) {
    return { ok: false, status: 413, message: `The file is over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.` };
  }
  const upload = await prisma.setupUpload.findUnique({
    where: { id },
    select: { tokenHash: true, expiresAt: true, receivedAt: true },
  });
  if (!upload) return { ok: false, status: 404, message: "No such upload." };
  if (upload.tokenHash !== hashToken(token)) return { ok: false, status: 401, message: "Wrong upload token." };
  if (upload.receivedAt)
    return { ok: false, status: 409, message: "This upload already has its file. Start a new one." };
  if (upload.expiresAt < new Date()) {
    return { ok: false, status: 401, message: "This upload's token expired. Start a new one." };
  }
  // Single use: only the first request to claim it stores its file.
  const claimed = await prisma.setupUpload.updateMany({
    where: { id, receivedAt: null },
    data: { receivedAt: new Date(), size: data.byteLength, data: new Uint8Array(data) },
  });
  if (claimed.count === 0) return { ok: false, status: 409, message: "This upload already has its file." };
  return { ok: true, size: data.byteLength };
}

/** Text from a file: UTF-8, or Windows-1252 for older spreadsheet exports. */
function decode(data: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return new TextDecoder("windows-1252").decode(data);
  }
}

/** The person's received files, by upload id, read as tables. Missing ones are left out. */
export async function readUploads(siteId: string, userId: string, ids: string[]) {
  const rows = await prisma.setupUpload.findMany({
    where: {
      id: { in: ids },
      siteId,
      createdById: userId,
      receivedAt: { gt: new Date(Date.now() - UPLOAD_KEEP_MS) },
    },
    select: { id: true, filename: true, data: true },
  });
  const files = new Map<string, { filename: string; table: CsvTable }>();
  for (const row of rows) {
    if (row.data) files.set(row.id, { filename: row.filename, table: parseCsv(decode(row.data)) });
  }
  return files;
}
