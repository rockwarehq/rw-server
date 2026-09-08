// Phone-number handling shared by the Twilio adapter and by SMS consent, which is keyed by
// number and so must compare numbers in one canonical form.

/**
 * Twilio only accepts E.164. Employee phones are typed by hand, so accept the common US
 * spellings — "(555) 555-0123", "555-555-0123", "1 555 555 0123". Anything already starting
 * with "+" keeps its country code but still has separators stripped: E.164 has none, and
 * "+1 555-555-0126" must land on the same key as "(555) 555-0126" or the same person ends up
 * with two consent records and an opt-out can be missed.
 *
 * Non-US numbers must be stored with their "+" prefix.
 */
export function toE164(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("+")) return `+${trimmed.slice(1).replace(/\D/g, "")}`;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return trimmed;
}
