# 0012 – SMS Consent: Keyed by Phone Number, Owned by rw-hub

- **Status:** Accepted
- **Date:** 2026-09-08
- **Deciders:** Michael St John

## Context

Automations can notify employees by text message. Before a text can be sent, the person has to
have agreed to receive it, and that agreement has to be provable afterwards: the phone carriers
require a record of how consent was captured (a form, a verbal yes, a keyword) for business
texting, and they enforce STOP replies independently of anything our software does.

Three forces shaped the design:

- **A STOP reply names a number, not a person.** Twilio and the carrier learn that a phone number
  stopped. They do not know which employee record it was typed into, and a number can be moved
  between records or outlive the record entirely.
- **Every tenant shares one RockWare texting number.** A STOP from a number therefore blocks that
  number for every tenant at once. A per-tenant answer sheet would happily claim "opted in" for a
  number the carrier refuses.
- **On-prem tenants cannot receive webhooks.** Twilio delivers STOP replies and delivery results
  to a public HTTPS address. A plant-floor rw-server has none, and asking a customer's IT to open
  one is not viable. This is one of the two reasons rw-hub exists (the other being that no tenant
  should hold the shared Twilio credential).

## Decision

**Consent is a property of a phone number.** We will store consent per `(workspace, phone)`, with
the number normalized to E.164 on every read and write so any spelling of one number resolves to
one row. A number with no row was never asked, which is a different state from opted out, and the
two must never collapse.

**rw-hub is the authority; each tenant keeps a replica.** The hub holds the single global consent
list that matches what the carriers actually enforce. A tenant's `SmsConsent` table is a copy for
that workspace's UI and send path, written in only two ways:

1. **A decision made in the app.** The hub is asked first; the local row is written only if the
   hub agrees. A carrier STOP outranks any admin opt-in, and the hub refuses to override it, so
   the admin is told their tick did not take and why. With no hub configured there is no SMS at
   all, so the local write proceeds unguarded; nothing can diverge.
2. **A change the hub reports.** The `hub-events` worker polls the hub every thirty seconds from a
   bookmark stored in `HubCursor`, applies each change to every workspace that already holds a row
   for that number, and only then advances the bookmark. A workspace with no row never asked, so
   there is nothing to update there.

**Current state and its proof are written together.** Every write updates the `SmsConsent` row and
appends one `SmsConsentEvent` line (status, method, who recorded it, when, and for hub-originated
changes the hub's event id) in one transaction. The current status is always just the newest
history line. The hub event id is unique per consent row, so a retried poll cannot record the same
STOP twice.

**The send path only uses an opted-in number.** A recipient whose number is not currently opted
in gets a `SKIPPED` delivery row saying either "has not opted in" or "has opted out", so an admin
reading the log sees which of the three states applied.

The path for a STOP reply is therefore: the person texts STOP → Twilio blocks the number at once
→ Twilio calls rw-hub, which verifies the signature, updates its global list, and logs an event
→ the tenant worker polls and finds the event → the worker flips the row and appends the history
line in every workspace that knows the number.

## Consequences

- A person's consent survives their employee record being edited, re-created, or deleted, and is
  shared across records that carry the same number.
- Tenants need no inbound port and hold no Twilio credential; they need only an outbound HTTPS
  connection and a hub key. A tenant without a key records every SMS as `SKIPPED`, never `FAILED`.
- A workspace that never asked a number learns nothing when that number texts STOP. That is
  acceptable: it could not have sent to the number anyway, and the hub refuses the send regardless.
- Consent replicas lag the hub by up to one poll interval. A send inside that window is still
  refused by the hub, so the lag affects what the UI shows, not what gets sent.
- The `hub-events` worker must run as exactly one machine: two would race on the same bookmark.
- The hub is a runtime dependency for recording consent once it is configured. If the hub is down,
  an admin cannot record a decision and is told to retry, rather than the app writing a local
  "opted in" the hub would later contradict.

## Alternatives Considered

- **Consent on the employee profile** — the carrier speaks in numbers, so a STOP could not be
  matched back to a person reliably, and a number moved to another record would carry no history.
- **Per-tenant consent with no shared authority** — a shared sending number makes carrier STOP
  global; a per-tenant table would show opted in for numbers that can no longer be texted.
- **Direct Twilio integration in each tenant** — requires a public webhook endpoint on every
  deployment and a copy of the Twilio credential in every environment. Neither is acceptable
  on-prem, and rotation would mean one deploy per tenant.
- **Push from hub to tenant (NATS leaf nodes, tunnels)** — the volume is a handful of events per
  day; a polled, cursor-paged log over plain HTTPS needs no long-lived connection and works through
  any outbound-only firewall.
- **Writing locally first, syncing to the hub later** — the UI would show a green opt-in beside
  an alert that silently never arrives whenever the hub disagrees.
