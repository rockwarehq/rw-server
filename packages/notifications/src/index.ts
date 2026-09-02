// @rw/notifications — a small, storage-agnostic delivery core: recipients × channels → one
// delivery outcome each, through swappable channel adapters. The consuming app owns groups,
// recipient lookup, persistence, and transport; this package knows none of that.

export type Channel = "EMAIL" | "SMS";
export type DeliveryStatus = "SENT" | "FAILED" | "SKIPPED";

export interface Message {
  subject: string;
  body: string;
}

export type ChannelResult = { ok: true; providerMessageId?: string } | { ok: false; error: string; skipped?: boolean };

/** One provider for one channel. Knows nothing about recipients beyond the address it is handed. */
export interface ChannelAdapter {
  send(to: string, message: Message): Promise<ChannelResult>;
}

/** Someone to notify: an opaque id plus whatever addresses the app could resolve, per channel. */
export interface Recipient {
  id: string;
  addresses: Partial<Record<Channel, string | null | undefined>>;
}

export interface Delivery {
  recipientId: string;
  channel: Channel;
  /** Address used; null when the recipient had none for the channel (status SKIPPED). */
  address: string | null;
  status: DeliveryStatus;
  error: string | null;
  providerMessageId: string | null;
}

export interface DeliverySummary {
  sent: number;
  failed: number;
  skipped: number;
}

export interface Notifier {
  /** Attempt every (recipient, channel) pair and report each outcome. Never throws for a provider failure. */
  deliver(recipients: Recipient[], channels: Channel[], message: Message): Promise<Delivery[]>;
  adapter(channel: Channel): ChannelAdapter;
  /** Swap a channel's provider (tests, or plugging in a real provider later). */
  setAdapter(channel: Channel, adapter: ChannelAdapter): void;
}

/** Placeholder for a channel with no provider yet: every send is SKIPPED, never FAILED. */
export function unconfiguredAdapter(channel: Channel): ChannelAdapter {
  return {
    async send() {
      return { ok: false, skipped: true, error: `${channel} provider not configured` };
    },
  };
}

export function createNotifier(adapters: Partial<Record<Channel, ChannelAdapter>> = {}): Notifier {
  const registry: Record<Channel, ChannelAdapter> = {
    EMAIL: adapters.EMAIL ?? unconfiguredAdapter("EMAIL"),
    SMS: adapters.SMS ?? unconfiguredAdapter("SMS"),
  };
  return {
    async deliver(recipients, channels, message) {
      const out: Delivery[] = [];
      for (const channel of channels) {
        for (const recipient of recipients) {
          const address = recipient.addresses[channel];
          if (!address) {
            out.push({
              recipientId: recipient.id,
              channel,
              address: null,
              status: "SKIPPED",
              error: `recipient has no ${channel.toLowerCase()} address`,
              providerMessageId: null,
            });
            continue;
          }
          const result = await registry[channel]
            .send(address, message)
            .catch((err): ChannelResult => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
          out.push({
            recipientId: recipient.id,
            channel,
            address,
            status: result.ok ? "SENT" : result.skipped ? "SKIPPED" : "FAILED",
            error: result.ok ? null : result.error,
            providerMessageId: result.ok ? (result.providerMessageId ?? null) : null,
          });
        }
      }
      return out;
    },
    adapter: (channel) => registry[channel],
    setAdapter(channel, adapter) {
      registry[channel] = adapter;
    },
  };
}

export function summarize(deliveries: Delivery[]): DeliverySummary {
  const count = (status: DeliveryStatus) => deliveries.filter((d) => d.status === status).length;
  return { sent: count("SENT"), failed: count("FAILED"), skipped: count("SKIPPED") };
}
