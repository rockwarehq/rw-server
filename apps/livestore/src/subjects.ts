function sanitizeSubjectToken(value: string): string {
  const token = value.trim().replaceAll("/", ".").replaceAll("\\", ".").replace(/\s+/g, "_");
  return token
    .split(".")
    .filter(Boolean)
    .map((part) => part.replace(/[*>]/g, "_"))
    .join(".");
}

export function deriveTagSubject(deviceId: string, tagPath: string): string {
  const deviceToken = sanitizeSubjectToken(deviceId);
  const pathToken = sanitizeSubjectToken(tagPath);
  if (!deviceToken) throw new Error("deviceId must produce a non-empty NATS subject token");
  if (!pathToken) throw new Error("tagPath must produce a non-empty NATS subject token");
  return `tags.${deviceToken}.${pathToken}`;
}
