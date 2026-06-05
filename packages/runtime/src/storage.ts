// Infrastructure adapter for object storage (S3-compatible).
// Knows about the S3 SDK + env vars. Knows NOTHING about business concepts
// like "product picture" or "user avatar" — callers in @rw/services build
// those on top of these primitives.

import { S3Client, DeleteObjectCommand, DeleteObjectsCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";

// ── Config read from process.env ─────────────────────────────────────────

const defaultDocumentContentTypes = [
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/svg+xml",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
];

function parseIntEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseContentTypesEnv(name: string, fallback: string[]): string[] {
  return process.env[name]
    ? process.env[name]
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : fallback;
}

const storageConfig = {
  bucketName: process.env.BUCKET_NAME || "",
  region: process.env.AWS_REGION || "auto",
  endpoint: process.env.AWS_ENDPOINT_URL_S3 || "https://fly.storage.tigris.dev",
  accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  enabled: !!process.env.BUCKET_NAME,

  // Limits
  maxFileSizeBytes: 5 * 1024 * 1024, // 5MB
  maxPicturesPerProduct: 10,
  allowedContentTypes: ["image/jpeg", "image/png", "image/webp", "image/gif", "image/svg+xml"],
  maxDocumentFileSizeBytes: parseIntEnv("DOCUMENT_MAX_FILE_SIZE_BYTES", 50 * 1024 * 1024),
  allowedDocumentContentTypes: parseContentTypesEnv("DOCUMENT_ALLOWED_CONTENT_TYPES", defaultDocumentContentTypes),

  // URL expiry
  presignedUrlExpirySeconds: 3600, // 1 hour
};

export interface PresignedDownloadUrlOptions {
  disposition?: "inline" | "attachment";
  filename?: string;
  contentType?: string;
  expiresIn?: number;
}

function sanitizeContentDispositionFilename(filename: string): string {
  return filename
    .replace(/[\r\n]/g, " ")
    .replace(/["\\]/g, "_")
    .trim();
}

function getContentDisposition(options: PresignedDownloadUrlOptions): string | undefined {
  if (!options.disposition) return undefined;

  const filename = options.filename ? sanitizeContentDispositionFilename(options.filename) : "";
  return filename ? `${options.disposition}; filename="${filename}"` : options.disposition;
}

export function isStorageEnabled(): boolean {
  return storageConfig.enabled;
}

export function getMaxPicturesPerProduct(): number {
  return storageConfig.maxPicturesPerProduct;
}

export function getMaxDocumentFileSizeBytes(): number {
  return storageConfig.maxDocumentFileSizeBytes;
}

// ── S3 client singleton ──────────────────────────────────────────────────

let s3Client: S3Client | null = null;

export function getClient(): S3Client {
  if (!s3Client) {
    if (!storageConfig.enabled) {
      throw new Error("Storage is not configured. Set BUCKET_NAME environment variable.");
    }

    s3Client = new S3Client({
      region: storageConfig.region,
      endpoint: storageConfig.endpoint,
      credentials: {
        accessKeyId: storageConfig.accessKeyId,
        secretAccessKey: storageConfig.secretAccessKey,
      },
    });
  }
  return s3Client;
}

// ── Key generation ───────────────────────────────────────────────────────

/** Generate a unique S3 object key: {prefix}/{uuid}.{extension} */
export function generateKey(prefix: string, filename: string): string {
  const ext = extname(filename).slice(1).toLowerCase() || "bin";
  const uuid = randomUUID();
  return `${prefix}/${uuid}.${ext}`;
}

/** Generate a key for product pictures: products/{productId}/{uuid}.{extension} */
export function generateProductPictureKey(productId: string, filename: string): string {
  return generateKey(`products/${productId}`, filename);
}

/** Generate a key for documents: documents/{documentId}/{uuid}.{extension} */
export function generateDocumentKey(documentId: string, filename: string): string {
  return generateKey(`documents/${documentId}`, filename);
}

// ── Presigned URLs ───────────────────────────────────────────────────────

export async function getPresignedUploadUrl(
  key: string,
  contentType: string,
  contentLength: number,
  expiresIn: number = storageConfig.presignedUrlExpirySeconds,
): Promise<string> {
  const client = getClient();
  const command = new PutObjectCommand({
    Bucket: storageConfig.bucketName,
    Key: key,
    ContentType: contentType,
    ContentLength: contentLength,
  });
  return getSignedUrl(client, command, { expiresIn });
}

export async function getPresignedDownloadUrl(key: string, options: PresignedDownloadUrlOptions = {}): Promise<string> {
  const client = getClient();
  const command = new GetObjectCommand({
    Bucket: storageConfig.bucketName,
    Key: key,
    ResponseContentDisposition: getContentDisposition(options),
    ResponseContentType: options.contentType,
  });
  return getSignedUrl(client, command, { expiresIn: options.expiresIn ?? storageConfig.presignedUrlExpirySeconds });
}

export async function objectExists(key: string): Promise<boolean> {
  const client = getClient();
  const command = new HeadObjectCommand({
    Bucket: storageConfig.bucketName,
    Key: key,
  });

  try {
    await client.send(command);
    return true;
  } catch (err) {
    const statusCode = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    const name = (err as { name?: string }).name;
    if (statusCode === 404 || name === "NotFound" || name === "NoSuchKey") {
      return false;
    }
    throw err;
  }
}

// ── Delete ──────────────────────────────────────────────────────────────

export async function deleteObject(key: string): Promise<void> {
  const client = getClient();
  const command = new DeleteObjectCommand({
    Bucket: storageConfig.bucketName,
    Key: key,
  });
  await client.send(command);
}

export async function deleteObjects(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const client = getClient();
  const command = new DeleteObjectsCommand({
    Bucket: storageConfig.bucketName,
    Delete: {
      Objects: keys.map((key) => ({ Key: key })),
    },
  });
  await client.send(command);
}

// ── Validation helpers ──────────────────────────────────────────────────

export function isAllowedContentType(contentType: string): boolean {
  return storageConfig.allowedContentTypes.includes(contentType);
}

export function isAllowedFileSize(size: number): boolean {
  return size > 0 && size <= storageConfig.maxFileSizeBytes;
}

export function isAllowedDocumentContentType(contentType: string): boolean {
  return storageConfig.allowedDocumentContentTypes.includes(contentType);
}

export function isAllowedDocumentFileSize(size: number): boolean {
  return size > 0 && size <= storageConfig.maxDocumentFileSizeBytes;
}

export function validateUpload(contentType: string, size: number): string | null {
  if (!isAllowedContentType(contentType)) {
    return `Content type '${contentType}' is not allowed. Allowed types: ${storageConfig.allowedContentTypes.join(", ")}`;
  }
  if (!isAllowedFileSize(size)) {
    const maxMB = storageConfig.maxFileSizeBytes / (1024 * 1024);
    return `File size must be between 1 byte and ${maxMB}MB`;
  }
  return null;
}

export function validateDocumentUpload(contentType: string, size: number): string | null {
  if (!isAllowedDocumentContentType(contentType)) {
    return `Content type '${contentType}' is not allowed. Allowed types: ${storageConfig.allowedDocumentContentTypes.join(", ")}`;
  }
  if (!isAllowedDocumentFileSize(size)) {
    const maxMB = storageConfig.maxDocumentFileSizeBytes / (1024 * 1024);
    return `File size must be between 1 byte and ${maxMB}MB`;
  }
  return null;
}
