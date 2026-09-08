import { type ChannelAdapter, createNotifier } from "@rw/notifications";
import { isEmailEnabled } from "@rw/runtime/email";
import { isHubEnabled, sendSms } from "@rw/runtime/hub";
import { sendAlertEmail } from "../email/send.js";

// This app's providers for the @rw/notifications core. Email rides the existing Resend path
// directly; SMS goes through rw-hub, which holds the Twilio credentials. Either channel
// unconfigured records SKIPPED, never FAILED.

const email: ChannelAdapter = {
  async send(to, message) {
    if (!isEmailEnabled()) return { ok: false, skipped: true, error: "email disabled (RESEND_API_KEY unset)" };
    const result = await sendAlertEmail({ to, subject: message.subject, message: message.body });
    return result.success
      ? { ok: true, providerMessageId: result.messageId }
      : { ok: false, error: result.error ?? "send failed" };
  },
};

// SMS has no subject line: lead with it, then the body. 1600 is Twilio's hard per-message cap.
const smsText = (subject: string, body: string) => `${subject}\n\n${body}`.trim().slice(0, 1600);

const sms: ChannelAdapter = {
  async send(to, message) {
    if (!isHubEnabled()) return { ok: false, skipped: true, error: "sms disabled (HUB_URL / HUB_API_KEY unset)" };
    const result = await sendSms({ to, body: smsText(message.subject, message.body) });
    return result.ok ? { ok: true, providerMessageId: result.sid } : { ok: false, error: result.error };
  },
};

export const notifier = createNotifier({ EMAIL: email, SMS: sms });

/** Swap a channel's provider (tests, or a different provider later). */
export const setChannelAdapter = notifier.setAdapter;
