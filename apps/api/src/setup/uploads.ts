import { randomBytes } from "node:crypto";

import { hashToken } from "@rw/auth/secrets";
import prisma from "@rw/db";

import { mcpConfig } from "../config.js";

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

export class AttachError extends Error {}

const ATTACH_TIMEOUT_MS = 60_000;

/** Is this host one attachments may come from? "*.example.com" matches its subdomains. */
export function fileHostAllowed(host: string, allowed: readonly string[] = mcpConfig.fileHosts): boolean {
  const name = host.toLowerCase();
  return allowed.some((rule) => (rule.startsWith("*.") ? name.endsWith(rule.slice(1)) : name === rule));
}

/**
 * A file a connected agent can only pass as a link (ChatGPT's attachments):
 * downloaded here, from an allowed https host only, into an upload like one
 * sent with curl. The link is used once and never stored.
 */
export async function attachRemoteFile(input: {
  siteId: string;
  createdById: string;
  grantId: string | null;
  url: string;
  filename: string;
}) {
  const url = new URL(input.url);
  if (url.protocol !== "https:" || !fileHostAllowed(url.hostname)) {
    throw new AttachError(`Files can't be downloaded from ${url.hostname}.`);
  }
  const upload = await createUpload({
    siteId: input.siteId,
    filename: input.filename,
    createdById: input.createdById,
    grantId: input.grantId,
  });
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(ATTACH_TIMEOUT_MS) });
  const landed = new URL(response.url || url.toString());
  if (landed.protocol !== "https:" || !fileHostAllowed(landed.hostname)) {
    throw new AttachError(`The file link went on to ${landed.hostname}, which isn't allowed.`);
  }
  if (!response.ok || !response.body) throw new AttachError(`Downloading the file failed (${response.status}).`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_UPLOAD_BYTES) throw new AttachError(`The file is over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
  // Read at most the limit, whatever the server claims.
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > MAX_UPLOAD_BYTES) throw new AttachError(`The file is over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
    chunks.push(chunk);
  }
  const received = await receiveUpload(upload.id, upload.token, Buffer.concat(chunks));
  if (!received.ok) throw new AttachError(received.message);
  return { id: upload.id, filename: input.filename, size: received.size };
}
