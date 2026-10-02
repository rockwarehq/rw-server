# 0018 – Report Decks: Pages of Reports, Kept as Editions

- **Status:** Accepted
- **Date:** 2026-09-28
- **Deciders:** Michael St John

## Context

A report deck is a set of report pages that all cover the same days and the
same workcenter: "Yesterday at Molding", "Previous 7 days at Assembly". People
want the same deck made every morning, kept, and emailed, and they want the
email's link to open without signing in.

rw-ui prototyped all of it in the browser (`apps/rw-imm/src/decks`). The
prototype worked out the days, ran the queries and kept everything in the
browser. This ADR moves the parts that belong on the server.

## Decisions

### A deck owns when and where

A deck has a **range** (`yesterday`, `yesterday-7`) and exactly one
**workcenter**. Its pages never carry their own dates or workcenter.

The days come from the workcenter's shift calendar, as business dates:

- **Yesterday** is the latest business date whose scheduled shifts had all
  ended by the moment the edition is made. A day with no scheduled shift (a
  weekend) is never "yesterday": on Monday it is Friday.
- **Previous 7 days** is the seven business dates ending on that day,
  calendar-contiguous. Days without work are inside the span and add nothing.

### A page stores its queries, not its report

Pages come from the real report pages (catalog reports, Explore). When a page
is saved, the UI stores the report's own state for drawing it (`params`) and
the **queries** the page makes, keyed by slot (`log`, `chart:0`, `result`).
Each is a `report.query` or `report.rows` input without dates.

The server does not know what a catalog preset or a curated chart set is. It
fills in the dates, runs the queries and stores the results. The UI stays the
only place that turns a report into queries.

### An edition is a snapshot

Making an edition:

1. works out the days (above),
2. splits each page (one page for the whole span; a shift recap, a page per
   shift),
3. runs every query with scope `{ siteId, workcenterIds: [deck.workcenterId] }`
   (the compiler's own workcenter narrowing, so no page can show another
   workcenter), and narrows by `shiftName` when the page names shifts,
4. stores the deck as it was, each page's dates and results, and the report
   schema of every dataset used, so it draws the same even if the catalog
   changes.

Nothing about an edition changes afterwards. It can be deleted, not edited.

**Row caps.** Grouped queries keep the compiler's own limit. Row lists (a
catalog log, Explore's every-row) store at most 1,000 rows with the total, and
say "first 1,000 of N".

A preview is an edition that is not saved.

### Links open without signing in

A link points at one edition or several (a subscription's `links: "one"`).
Only a SHA-256 hash of its token is stored. It lasts until revoked or until
`expiresAt`: whoever makes it chooses (the app offers 7 days first), and it
may have none. `deckLink.view` is public and
returns only what the edition kept; it never runs a query. (Since 2026-10-02
that is the pages and their saved queries, read live; see below.)

Signed-in people see every edition of a deck they can see, links or not.

### Who can do what

A deck is workcenter data (checked on its workcenter): VIEW to see decks and
editions, MANAGE to change decks, make editions and create links. Decks are
per site now. `visibility` (`SITE`, `PRIVATE`) and `createdById` exist so
private decks come later without a migration; everything is `SITE` today.

### Schedules and subscriptions are automations

Both are `time.daily` automations (the clock trigger):

- `deck.makeEditions { deckIds }` makes an edition of each deck **as of the
  event's `scheduledAt`**, so a run that fires late still covers the right days.
- `deck.sendLatest { deckIds, groupIds, employeeIds, subject, body,
  linkExpiryHours?, links? }` always sends the latest edition of each deck
  (a deck with none is left out): a link per deck, or one for all with
  `links: "one"`. The message is followed by a `Deck name: link` line per link.
  Delivery is `notification.send`.

### A shift recap is a deck in disguise (2026-09-29)

A workcenter's shift recap is sent the way a deck is, and kept as one:
`ReportDeck.kind` is `DECK` or `SHIFT_RECAP`. A `SHIFT_RECAP` is one
`shift-recap` page naming one shift, over the range `"last-shift"`: the latest
shift with that name at the workcenter that had ended as of the edition's
moment. It has editions, links, expiry and revoke like any deck. It is listed
only when asked for (`deck.list { kind: "SHIFT_RECAP" }`), from the recap page,
never in the Decks list; a deck never uses `"last-shift"`.

Its schedules and subscriptions are a deck's: `deck.makeEditions` makes an
edition of the last shift as of the schedule's time, and `deck.sendLatest`
emails a link to the latest edition, so a subscription is set a little after
the schedule it follows. When the shift ends is not consulted: a schedule set
before that shift ends makes the one before.

A recap page stores no results. Its link reads the recap **live** through
`deck.linkRecap { token, editionId, pageKey }`, the one public read that runs
queries: the token must still open, the edition must be one the link names,
and the workcenter and shift come from the edition as kept, never from the
caller. It returns what the recap page draws, with people by name only (no
emails, user ids or employee numbers). The signed-in `shiftRecap.*`
procedures and the link share one set of reads
(`services/facility/shift/shift-recap.ts`).

### An edition keeps the question, not the answer (2026-10-02)

Editions no longer store results. Making one works out the days and the pages
and keeps the deck as it was — each page's dates, workcenter, shifts and saved
queries, and the schema of every dataset used — and runs nothing. A page's
`results` are always empty. (There is no storage suited to kept row results
yet; immutable editions are a later iteration.)

Every report page is read when it is opened, so it shows what its saved query
returns **today** for the edition's days: a downtime recoded after the edition
was made shows recoded. This replaces "An edition is a snapshot" above, its
row caps, and "nothing about an edition changes afterwards" as far as results
go. What an edition covers still never changes. Editions made earlier still
hold their stored results; nothing reads them.

Three reads share one function (`readPage`) and differ only in who may ask:

- `deck.linkPage { token, editionId, pageKey, slot, ... }`: public. The token
  must still open and the edition must be one the link names.
- `deck.editionPage { editionId, pageKey, slot, ... }`: VIEW on the edition.
- `deck.previewPage { deckId, pageKey, slot, ... }`: VIEW on the deck; the
  pages are worked out as of now and nothing is kept.

`slot` picks one of the page's saved queries (`log`, `chart:0`, `result`). The
query, page and workcenter come from the edition as kept (`savedPageQuery`),
never from the caller: **a token does what was saved and nothing else.** The
reader may choose only how the same rows are shown:

- `limit` (at most 1,000) and `offset`: which rows of a row list,
- `orderBy`: their order, over the saved columns,
- `summary`: figures over every row the list matches (`report.summary`'s
  items — sum, avg, min, max, or a row count), and only over **columns the
  page saved** (`COLUMN_NOT_SAVED` otherwise). They are aggregates of values
  the reader can already page through, so they are the reader's to ask for;
  the UI sends its report's current figures, which is why none are saved with
  a page.

`deck.viewLink` and `deck.getEdition` return the edition as kept and run
nothing; `deck.preview` works out the pages and runs nothing.

## Not yet

- Shift recap pages keep no figures: a link reads them live (above).
  (Production, formerly Daily production, is catalog queries since 2026-09-29, so it is kept like
  any other page.)
- The order of two automations due the same minute is not defined; making
  before sending on one tick needs both actions in one automation.
- A failed clock run is logged, not retried or shown in run history.
- Private and shared decks.
