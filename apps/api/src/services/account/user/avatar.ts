import prisma from "@rw/db";
import * as storage from "@rw/runtime/storage";

export interface CreateAvatarUploadInput {
  filename: string;
  contentType: string;
  size: number;
}

async function deleteObjectBestEffort(key: string) {
  if (!storage.isStorageEnabled()) return;
  try {
    await storage.deleteObject(key);
  } catch {
    // Best-effort: the avatarKey already points at the new state.
  }
}

/**
 * Start an avatar upload: validates, writes User.avatarKey, and returns a
 * presigned PUT URL. Replaces any existing avatar (old S3 object deleted
 * best-effort). If the client's PUT fails it should call removeAvatar to
 * roll back.
 */
export async function createAvatarUpload(userId: string, input: CreateAvatarUploadInput) {
  const { filename, contentType, size } = input;

  if (!storage.isStorageEnabled()) {
    return { error: "Storage is not configured", code: "STORAGE_NOT_CONFIGURED" };
  }

  const validationError = storage.validateUpload(contentType, size);
  if (validationError) {
    return { error: validationError, code: "INVALID_UPLOAD" };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, avatarKey: true },
  });
  if (!user) {
    return { error: "User not found", code: "USER_NOT_FOUND" };
  }

  const key = storage.generateKey(`user-avatar/${userId}`, filename);
  await prisma.user.update({
    where: { id: userId },
    data: { avatarKey: key },
  });

  if (user.avatarKey) {
    await deleteObjectBestEffort(user.avatarKey);
  }

  const uploadUrl = await storage.getPresignedUploadUrl(key, contentType, size);
  return { data: { uploadUrl, key } };
}

/**
 * Remove the avatar (idempotent): clears User.avatarKey and deletes the S3
 * object best-effort.
 */
export async function removeAvatar(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, avatarKey: true },
  });
  if (!user) {
    return { error: "User not found", code: "USER_NOT_FOUND" };
  }

  if (!user.avatarKey) {
    return { data: { success: true } };
  }

  await prisma.user.update({
    where: { id: userId },
    data: { avatarKey: null },
  });
  await deleteObjectBestEffort(user.avatarKey);

  return { data: { success: true } };
}

/**
 * Resolve a presigned GET URL for an avatar key, or null when no avatar is
 * set (or storage is disabled).
 */
export async function resolveAvatarUrl(avatarKey: string | null): Promise<string | null> {
  if (!avatarKey || !storage.isStorageEnabled()) return null;
  return storage.getPresignedDownloadUrl(avatarKey, { disposition: "inline" });
}
