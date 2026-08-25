interface InviteEmailParams {
  recipientEmail: string;
  temporaryPassword: string;
  /** Validated http(s) origin to link to; omit to send without a link. */
  appUrl?: string;
  inviterName?: string;
  workspaceName?: string;
  expiresInDays: number;
}

interface ResetEmailParams {
  recipientEmail: string;
  resetCode: string;
  expiresInMinutes: number;
}

interface AlertEmailParams {
  subject: string;
  message: string;
}

/** Escape HTML-significant characters so an interpolated automation message renders as plain text. */
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function baseTemplate(content: string): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Rockware</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  ${content}
  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
  <p style="font-size: 12px; color: #666;">
    This email was sent by Rockware. If you did not expect this email, you can safely ignore it.
  </p>
</body>
</html>
  `.trim();
}

export function createInviteEmailHtml(params: InviteEmailParams): string {
  const { recipientEmail, temporaryPassword, appUrl, inviterName, workspaceName, expiresInDays } = params;

  const inviterText = inviterName ? `${escapeHtml(inviterName)} has` : "You have been";
  const workspaceText = workspaceName ? ` to join <strong>${escapeHtml(workspaceName)}</strong>` : "";
  const loginUrl = appUrl ? `${appUrl}/login` : undefined;

  const loginSection = loginUrl
    ? `
    <p style="margin: 30px 0;">
      <a href="${loginUrl}" style="display: inline-block; background-color: #0066cc; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 500;">
        Sign In
      </a>
    </p>
    <p style="font-size: 14px; color: #666;">
      Or copy and paste this link into your browser:<br>
      <a href="${loginUrl}" style="color: #0066cc; word-break: break-all;">${loginUrl}</a>
    </p>`
    : "";

  return baseTemplate(`
    <h1 style="color: #1a1a1a; font-size: 24px; margin-bottom: 20px;">You're Invited to Rockware</h1>
    <p>${inviterText} invited you${workspaceText}.</p>
    <p>Sign in with your email address (<strong>${escapeHtml(recipientEmail)}</strong>) and this temporary password &mdash; you'll be asked to choose your own password on first login:</p>
    <p style="margin: 30px 0; text-align: center;">
      <span style="display: inline-block; font-family: 'SF Mono', 'Courier New', monospace; font-size: 24px; font-weight: 600; color: #1a1a1a; background-color: #f4f4f5; border-radius: 8px; padding: 16px 24px;">${escapeHtml(temporaryPassword)}</span>
    </p>
    ${loginSection}
    <p style="font-size: 14px; color: #666;">
      This temporary password expires in ${expiresInDays} days. If you did not expect this invitation, you can safely ignore this email.
    </p>
  `);
}

export function createInviteEmailText(params: InviteEmailParams): string {
  const { recipientEmail, temporaryPassword, appUrl, inviterName, workspaceName, expiresInDays } = params;

  const inviterText = inviterName ? `${inviterName} has` : "You have been";
  const workspaceText = workspaceName ? ` to join ${workspaceName}` : "";
  const loginLine = appUrl ? `\nSign in here: ${appUrl}/login\n` : "";

  return `
You're Invited to Rockware

${inviterText} invited you${workspaceText}.

Sign in with your email address (${recipientEmail}) and this temporary password - you'll be asked to choose your own password on first login:

${temporaryPassword}
${loginLine}
This temporary password expires in ${expiresInDays} days. If you did not expect this invitation, you can safely ignore this email.

---
This email was sent by Rockware.
  `.trim();
}

export function createResetEmailHtml(params: ResetEmailParams): string {
  const { resetCode, expiresInMinutes } = params;

  return baseTemplate(`
    <h1 style="color: #1a1a1a; font-size: 24px; margin-bottom: 20px;">Reset Your Password</h1>
    <p>We received a request to reset your Rockware password.</p>
    <p>Enter this code in the app to choose a new password:</p>
    <p style="margin: 30px 0; text-align: center;">
      <span style="display: inline-block; font-family: 'SF Mono', 'Courier New', monospace; font-size: 32px; font-weight: 600; letter-spacing: 8px; color: #1a1a1a; background-color: #f4f4f5; border-radius: 8px; padding: 16px 24px 16px 32px;">${resetCode}</span>
    </p>
    <p style="font-size: 14px; color: #666;">
      This code will expire in ${expiresInMinutes} minutes. If you did not request a password reset, you can safely ignore this email.
    </p>
  `);
}

export function createAlertEmailHtml(params: AlertEmailParams): string {
  const { subject, message } = params;
  const body = escapeHtml(message).replace(/\n/g, "<br>");

  return baseTemplate(`
    <h1 style="color: #1a1a1a; font-size: 24px; margin-bottom: 20px;">${escapeHtml(subject)}</h1>
    <p>${body}</p>
  `);
}

export function createAlertEmailText(params: AlertEmailParams): string {
  return params.message;
}

export function createResetEmailText(params: ResetEmailParams): string {
  const { resetCode, expiresInMinutes } = params;

  return `
Reset Your Password

We received a request to reset your Rockware password.

Enter this code in the app to choose a new password:

${resetCode}

This code will expire in ${expiresInMinutes} minutes. If you did not request a password reset, you can safely ignore this email.

---
This email was sent by Rockware.
  `.trim();
}
