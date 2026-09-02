import { type ChannelAdapter, createNotifier } from "@rw/notifications";
import { isEmailEnabled } from "@rw/runtime/email";
import { sendAlertEmail } from "../email/send.js";

// This app's providers for the @rw/notifications core. Email rides the existing Resend path;
// SMS stays unconfigured (deliveries record SKIPPED) until a provider is chosen.

const email: ChannelAdapter = {
  async send(to, message) {
    if (!isEmailEnabled()) return { ok: false, skipped: true, error: "email disabled (RESEND_API_KEY unset)" };
    const result = await sendAlertEmail({ to, subject: message.subject, message: message.body });
    return result.success
      ? { ok: true, providerMessageId: result.messageId }
      : { ok: false, error: result.error ?? "send failed" };
  },
};

export const notifier = createNotifier({ EMAIL: email });

/** Swap a channel's provider (tests, or a future SMS provider). */
export const setChannelAdapter = notifier.setAdapter;
