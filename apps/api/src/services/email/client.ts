import { Resend } from "resend";
import { emailConfig } from "../../config.js";

let resendClient: Resend | null = null;

export function getEmailClient(): Resend | null {
  if (!emailConfig.enabled) {
    return null;
  }

  if (!resendClient) {
    resendClient = new Resend(emailConfig.apiKey);
  }

  return resendClient;
}

export function isEmailEnabled(): boolean {
  return emailConfig.enabled;
}
