# @rw/notifications

A small, storage-agnostic notification delivery core. Give it recipients (an id plus the addresses
you could resolve, per channel), the channels to use, and a message; it returns one `Delivery`
outcome per recipient per channel — `SENT`, `FAILED`, or `SKIPPED` (no address, or no provider).

```ts
import { createNotifier, summarize } from "@rw/notifications";

const notifier = createNotifier({ EMAIL: myResendAdapter }); // an omitted channel → SKIPPED
const deliveries = await notifier.deliver(recipients, ["EMAIL"], { subject, body });
const { sent, failed, skipped } = summarize(deliveries);
```

The consuming app owns everything around it: groups, recipient lookup, persisting deliveries, events,
permissions. In rw-server that wrapper is `packages/services/src/notification/`. Channel providers
are `ChannelAdapter`s; `notifier.setAdapter(channel, adapter)` swaps one in (tests, a different
provider later). In rw-server EMAIL is Resend directly; SMS goes through rw-hub, the
shared cloud service that holds the Twilio credentials.
