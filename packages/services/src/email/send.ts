import { getAppBaseUrl, getDefaultFromAddress } from "@rw/runtime/email";
import { getEmailClient, isEmailEnabled } from "@rw/runtime/email";
import {
  createAlertEmailHtml,
  createAlertEmailText,
  createInviteEmailHtml,
  createInviteEmailText,
  createResetEmailHtml,
  createResetEmailText,
} from "./templates.js";

interface SendInviteParams {
  to: string;
  temporaryPassword: string;
  /** Validated http(s) origin the email should link to, if known. */
  appUrl?: string;
  inviterName?: string;
  workspaceName?: string;
  expiresInDays: number;
}

/** Return the origin of a well-formed http(s) URL, else undefined. */
export function validHttpOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

interface SendResetParams {
  to: string;
  resetCode: string;
  expiresInMinutes: number;
}

interface SendAlertParams {
  to: string | string[];
  subject: string;
  message: string;
}

interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export async function sendInviteEmail(params: SendInviteParams): Promise<SendResult> {
  const { to, temporaryPassword, inviterName, workspaceName, expiresInDays } = params;
  // Request-derived origin wins; fall back to the deployment's base URL.
  const appUrl = params.appUrl ?? validHttpOrigin(getAppBaseUrl());

  if (!isEmailEnabled()) {
    // Never log the temporary password - it is a long-lived credential and
    // the inviting admin already receives it in the API response.
    console.log(`[EMAIL DISABLED] Would send invite to ${to} (temporary password withheld from logs)`);
    return { success: true, messageId: "disabled" };
  }

  const client = getEmailClient();
  if (!client) {
    return { success: false, error: "Email client not configured" };
  }

  try {
    const { data, error } = await client.emails.send({
      from: getDefaultFromAddress(),
      to,
      subject: inviterName ? `${inviterName} invited you to Rockware` : "You're invited to Rockware",
      html: createInviteEmailHtml({
        recipientEmail: to,
        temporaryPassword,
        appUrl,
        inviterName,
        workspaceName,
        expiresInDays,
      }),
      text: createInviteEmailText({
        recipientEmail: to,
        temporaryPassword,
        appUrl,
        inviterName,
        workspaceName,
        expiresInDays,
      }),
    });

    if (error) {
      console.error("[EMAIL] Failed to send invite:", error);
      return { success: false, error: error.message };
    }

    return { success: true, messageId: data?.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[EMAIL] Exception sending invite:", message);
    return { success: false, error: message };
  }
}

/**
 * Send an automation alert. Subject + message are supplied by the firing automation (the message is
 * already interpolated by the engine). Recipients are pre-resolved email addresses.
 */
export async function sendAlertEmail(params: SendAlertParams): Promise<SendResult> {
  const { to, subject, message } = params;
  const recipients = Array.isArray(to) ? to : [to];

  if (recipients.length === 0) {
    return { success: false, error: "No recipients" };
  }

  if (!isEmailEnabled()) {
    console.log(`[EMAIL DISABLED] Would send alert "${subject}" to ${recipients.join(", ")}`);
    return { success: true, messageId: "disabled" };
  }

  const client = getEmailClient();
  if (!client) {
    return { success: false, error: "Email client not configured" };
  }

  try {
    const { data, error } = await client.emails.send({
      from: getDefaultFromAddress(),
      to: recipients,
      subject,
      html: createAlertEmailHtml({ subject, message }),
      text: createAlertEmailText({ subject, message }),
    });

    if (error) {
      console.error("[EMAIL] Failed to send alert:", error);
      return { success: false, error: error.message };
    }

    return { success: true, messageId: data?.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[EMAIL] Exception sending alert:", message);
    return { success: false, error: message };
  }
}

export async function sendPasswordResetEmail(params: SendResetParams): Promise<SendResult> {
  const { to, resetCode, expiresInMinutes } = params;

  if (!isEmailEnabled()) {
    console.log(`[EMAIL DISABLED] Would send password reset to ${to} with code: ${resetCode}`);
    return { success: true, messageId: "disabled" };
  }

  const client = getEmailClient();
  if (!client) {
    return { success: false, error: "Email client not configured" };
  }

  try {
    const { data, error } = await client.emails.send({
      from: getDefaultFromAddress(),
      to,
      subject: "Reset your Rockware password",
      html: createResetEmailHtml({
        recipientEmail: to,
        resetCode,
        expiresInMinutes,
      }),
      text: createResetEmailText({
        recipientEmail: to,
        resetCode,
        expiresInMinutes,
      }),
    });

    if (error) {
      console.error("[EMAIL] Failed to send password reset:", error);
      return { success: false, error: error.message };
    }

    return { success: true, messageId: data?.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[EMAIL] Exception sending password reset:", message);
    return { success: false, error: message };
  }
}
