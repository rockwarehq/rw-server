import { S3Client, DeleteObjectCommand, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { storageConfig } from "../../config.js";

// ============================================================================
// S3 Client Singleton
// ============================================================================

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

// ============================================================================
// Key Generation
// ============================================================================

/**
 * Generate a unique S3 object key for a file
 * Format: {prefix}/{uuid}.{extension}
 */
export function generateKey(prefix: string, filename: string): string {
  const ext = extname(filename).slice(1).toLowerCase() || "bin";
  const uuid = randomUUID();
  return `${prefix}/${uuid}.${ext}`;
}

/**
 * Generate a key specifically for product pictures
 * Format: products/{productId}/{uuid}.{extension}
 */
export function generateProductPictureKey(productId: string, filename: string): string {
  return generateKey(`products/${productId}`, filename);
}

// ============================================================================
// Presigned URLs
// ============================================================================

/**
 * Generate a presigned URL for uploading a file directly to S3
 */
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

/**
 * Generate a presigned URL for downloading/viewing a file from S3
 */
export async function getPresignedDownloadUrl(
  key: string,
  expiresIn: number = storageConfig.presignedUrlExpirySeconds,
): Promise<string> {
  const client = getClient();

  const command = new GetObjectCommand({
    Bucket: storageConfig.bucketName,
    Key: key,
  });

  return getSignedUrl(client, command, { expiresIn });
}

// ============================================================================
// Delete Operations
// ============================================================================

/**
 * Delete a single object from S3
 */
export async function deleteObject(key: string): Promise<void> {
  const client = getClient();

  const command = new DeleteObjectCommand({
    Bucket: storageConfig.bucketName,
    Key: key,
  });

  await client.send(command);
}

/**
 * Delete multiple objects from S3 (batch delete)
 */
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

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Check if a content type is allowed for upload
 */
export function isAllowedContentType(contentType: string): boolean {
  return storageConfig.allowedContentTypes.includes(contentType);
}

/**
 * Check if a file size is within limits
 */
export function isAllowedFileSize(size: number): boolean {
  return size > 0 && size <= storageConfig.maxFileSizeBytes;
}

/**
 * Validate upload parameters and return error message if invalid
 */
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
