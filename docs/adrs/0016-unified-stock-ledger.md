# 0016 – One Stock Book for Parts and Materials

- **Status:** Proposed
- **Date:** 2026-09-24
- **Deciders:** Michael Lindenau

## Context

The catalog says what the plant makes and what it makes it with: jobs, parts
(`Product` in code), tools, materials, and the bill of materials that links
parts to materials (`ProductMaterial`). The catalog is in good shape. Each
record has a stable row plus a list of saved versions (`ProductVersion`,
`JobVersion`, …), and everything recorded on the floor keeps the ids of the
versions in use at the time. That is how we can say later exactly which spec
a part was made to.

Stock is the weak spot. Parts and materials are both things we keep a count
of, but they were counted two different ways:

- **Parts** kept four running numbers on `ProductStock`: made, scrapped, taken
  by orders, and hand corrections. About ten places in the code nudged those
  numbers up and down. Changing a scrap entry edited the number in place,
  and job history amendments did too. Nothing recorded *which* record moved
  the count, *when*, or *who* did it. A cycle also locked the stock rows
  twice (once for scrap, once for made parts), which could make two saves
  wait on each other forever.
- **Materials** already had a proper book (`MaterialLedgerEntry`): one row per
  change, only ever added. It had its own rules, its own units, and its own
  shift staging table (`MaterialShiftUsage`).

We need two things from stock:

- **Traceability**, the history of production: for any part, what went into
  it, where and when it was made, and what happened to it after.
- **Trackability**, the live picture: how much is on hand now, and what is
  claimed by orders.

We will also need to follow single parts by serial number and groups of parts
by batch. That work comes later, but the stock model has to have room for it
now.

## Decision

### 1. Everything we count has a `StockItem`

`StockItem` is the one record the stock book is kept against. Each `Product`
and each `Material` gets exactly one StockItem. This is the Rails "delegated
type" idea: the StockItem says *this thing is stockable*, and
`stockableType` + `stockableId` say which product or material it is.

`stockableId` has **no database link**, on purpose. A new kind of stock can
then be added without a new column. To keep the two in step:

- products and materials are never really deleted, only marked deleted or
  archived (`product.remove`, `material.remove`);
- the StockItem is made in the same save as the product or material;
- posting stock makes a missing StockItem on the spot (seed and import
  scripts skip the services);
- the repair job reports any StockItem whose product or material is gone.

Settings about *how we count* live on the StockItem, not on the versioned
catalog rows: the unit (`baseUnit`), `trackingMode`, and `reorderPoint`.
Changing how we count stock is not a change to what the part is, so it should
not make a new version.

Tools are not stockable. A tool is a thing we own and wear out, not a thing
we use up.

### 2. One book of movements: `StockMovement`

Every time stock goes up or down, one row is added to `StockMovement`. Rows
are never changed or removed. Each row says:

- which StockItem, how much (plus or minus), and what kind:
  `OUTPUT` (made), `SCRAP`, `FULFILLMENT` (taken by an order), `ADJUSTMENT`
  (hand correction or shelf count), plus the material kinds for later
  (`RECEIPT`, `USAGE`, `WRITE_OFF`, `TRANSFER_IN`, `TRANSFER_OUT`,
  `OPENING_BALANCE`);
- which record caused it: `sourceType` + `sourceId` (a made part, a scrap
  entry, an order line, a count). Like `stockableId`, this has no database
  link, so one column can point at any kind of record;
- when it happened in the plant (`occurredAt`), taken from the source record
  so it lands in the same shift, and when it was written down (`createdAt`);
- the shift labels (`shiftInstanceId`, `businessDate`, `isScheduled`) and
  `stationId`, copied from the source. When shift times change (ADR-0015),
  these are updated together with the source record;
- who did it (`performedByUserId`) and an optional `note`;
- a `seq` number that counts up, so the book always reads in the order it
  was written.

**Fixing a mistake never edits a row.** To change what a record did to stock,
we add a row that cancels its movement (`reversesMovementId` points at the
row it cancels, with the same time and shift) and then add a new row with the
right amount. A row can only be cancelled once. Changing a scrap entry from 2
to 3 leaves four rows' worth of history, not one silently changed number.

**The same record is never counted twice.** Each row has an
`idempotencyKey`: the source type and id (`ITEM_DISPOSITION_LOG:<id>`), plus
`:r1`, `:r2` … once it has been cancelled and posted again. A save that is
retried, or a record posted twice, is simply skipped.

Every row is built straight from its source record, in SQL
(`packages/services/src/stock/sources.ts`). Live saves, the first fill in the
migration, and the repair job all use the same rules, so they cannot drift
apart.

### 3. Totals are saved, but can always be rebuilt: `StockBalance`

`StockBalance` holds one row per StockItem: `onHand`, plus how that splits
into made, scrapped, taken by orders, and adjusted. The database checks that
the parts add up to `onHand`. The row is updated in the same save as each new
movement, so it is always current. It can be rebuilt from the book at any
time (`rebuildProductBalances`), and the book can be checked against its
source records (`reconcileProductStock`, run by
`apps/api/scripts/rederive-product-stock.ts`).

`onHand` can go below zero (for example, more scrapped than made). Screens
and orders see at least zero.

**One locking order.** Every save that changes a balance locks the rows in
`stockItemId` order, and a save posts everything it changes in one call:
`postSources`, or `repostSources` when the same save also cancels something
(an edited scrap entry, a job history amendment, a repair). So two saves can
never end up waiting on each other in a circle. A cycle now posts its made
parts and its auto-scrap together.

**Rebuilding while servers are running.** The rebuild works in small steps.
Each step locks its balance rows first and only then adds up the book. A
save that has written its movements but not yet updated its balance waits
for the step to finish, then adds its change on top, so nothing is lost. The
check (`--check`) also compares every balance with its book, not just every
record with its movements.

### 4. What stays the same

- The records on the floor stay as they are: `InventoryItem` (a made part,
  despite the name), `ItemDispositionLog` (scrap), `OrderConsumption` (what
  an order took), `ProductStockAdjustment` (a correction or count, with its
  reason and note). They are the evidence; the book is what they did to
  stock.
- The API does not change. `inventory.productStock`, `inventory.adjustStock`,
  order completion and coverage return the same shapes and error codes.
- Orders still take stock first come, first served, with nothing held back
  in advance.

### 5. Units

A movement keeps the unit its source used, so the book is a faithful copy.
The totals in `StockBalance` are kept in the StockItem's `baseUnit`: each
movement is converted when it is added up (the `stock_convert` database
function, rounded to 4 places one movement at a time, so totals kept up as we
go and totals rebuilt from scratch always agree). Parts have a blank unit and
are never converted.

**Materials (phase 2): weights now, room for more later.**

- A material's **stock unit** is its catalog `weightUnits`, mirrored onto
  `StockItem.baseUnit`. The two are kept equal: changing the catalog unit
  changes the stock unit in the same save, and the repair job puts them back
  in step if a script edits one behind the other's back.
- **No unit means "not tracked".** That covers both "we choose not to count
  this" (glue, shop supplies) and "not set up yet". The material still works
  everywhere in the catalog (bills of materials, documents, jobs), but stock
  actions are refused with `NO_CANONICAL_UNIT`, and its production use is
  skipped. It is never silently lost: the worker logs it once, and the repair
  report counts not-tracked materials on a live part's bill of materials
  (`untrackedMaterialsInUse`).
- **Any weight can be used anywhere** for a tracked material: bill-of-materials
  lines, receipts, write-offs, transfers. It is converted to the stock unit.
  (Before phase 2, hand entries had to match the unit exactly; now they
  convert. Counts are given in the stock unit.)
- **Changing the unit.** Weight to weight: the totals are rebuilt in the new
  unit; history keeps its own units. Weight to none: only when nothing is on
  hand or in use this shift (`STOCK_ON_HAND` otherwise), so stock never
  disappears. None to a weight: tracking starts.
- **Later, a units phase:** custom units ("bag", "spool", "drum"), count,
  length and volume units, and per-material factors ("1 bag = 25 kg",
  "1 each = 0.25 kg") so a material can be bought in one unit and used in
  another. That changes the `WeightUnit` enum columns to text, so it is its
  own step.

### 6. Serials, batches, and the birth certificate (later)

Not every part is followed the same way. `StockItem.trackingMode` says how:

- `NONE`: count only.
- `BATCH`: parts are grouped into batches. This is for parts made too fast
  to label one by one, like rivets at about 20 a second.
- `SERIAL`: every piece has its own label or barcode.

The plan for when we build it:

- **One `Lot` table for both batches and serials.** A serial is a batch of
  one. Each lot has its StockItem, its kind, its label or barcode (unique per
  StockItem), its status, and where and when it was made (cycle, job,
  station, shift). `StockMovement.lotId` is already there, empty for now, so
  the book, the totals, and the genealogy need no second path. Totals per
  lot go in a `StockLotBalance` next to `StockBalance`.
- **Genealogy.** `LotComponent` records which material batch or part serial
  went into which made batch or serial. It is written from `USAGE`
  movements tied to a cycle.
- **Birth certificate.** A part's life story, in the Basecamp style of
  "events on a recording": a `LotEvent` book, only ever added to, with one
  row for each thing that happened to the lot. That could be a scan at a
  station by a person (`ActionSource` MANUAL) or an automated event (SYSTEM),
  with station, job, cycle, who, and details. The birth certificate reads
  those events together with the lot's stock movements (made, scrapped,
  shipped, counted), the catalog versions it was made to, and its genealogy.

Because every stock change is already one movement with a source, a time, a
shift, and a person, adding serials and batches means adding a label to
movements and an event book beside them. Nothing already built changes shape.

### 7. Phases

1. **Parts on the book** (built). StockItem, StockMovement and
   StockBalance; every part stock save posts to the book; `ProductStock` is
   retired and dropped by a later migration.
2. **Materials on the book** (built). Every `MaterialLedgerEntry` posts a
   movement and is its source record: receipts, write-offs, transfers, counts,
   and the end-of-shift PRODUCTION row, which becomes `USAGE`. `USAGE` is
   placed at its shift's start, so it stays in the shift it was for. Totals
   gain `received` and `issued`. `MaterialShiftUsage` stays outside the book
   as "used so far this shift", and the material balance subtracts it. Units
   follow section 5. A shift amendment no longer moves end-of-shift rows (the
   ledger's PRODUCTION rows or the book's USAGE rows) to whichever shift was
   running when they were written.
   - Known edge: a job history amendment's material ADJUSTMENT is stamped
     with the flushed shift but carries the amendment's time, so a later
     shift amendment covering that time can move it.
   - Later: trim the statements a cycle close runs (check StockItems once for
     all sources, skip counting past cancellations for a first post, merge
     "make the balance row" with "lock it").
3. **Counts and claims.** Shelf count sessions whose lines post
   `ADJUSTMENT`; order claims and reservations that hold stock for an order.
4. **Serials and batches.** `Lot`, `StockLotBalance`, `LotComponent`,
   `LotEvent`, and the birth certificate.

### 8. Catalog findings to follow up

Found while reviewing the catalog. None of them block the stock book.

- Only Product can be archived. `Job`, `Tool` and `Material` have an
  `archivedAt` column but nothing sets it.
- Version history (`getVersionHistory`) exists for products and materials
  but is not in the API, and jobs and tools have none.
- New version numbers are picked outside the save that writes them, so two
  edits at once can clash. Documents already handle this
  (`VERSION_CONFLICT` in `document/index.ts`); catalog records should do the
  same.
- Versions do not record who made them. A `createdById` on each `*Version`
  would show who changed a spec.
- The bill of materials only knows weight. It should become quantity + unit,
  so parts can use materials counted in pieces, length or volume.
- `ProductMaterial` rows are really deleted, unlike every other catalog row.
- Delete checks count children that are already marked deleted
  (`docs/notes/soft-delete-audit.md`, B2).

## Consequences

- Every stock change can be traced to the record that caused it, when, in
  which shift, and by whom. Corrections show up as corrections.
- Stock can be checked against its records and repaired at any time, without
  guessing.
- The book grows by about one row per made-part row, plus scrap, orders and
  counts. The table is indexed for "one item over time" and "one site over a
  date range".
- A cycle save runs a few more small statements than before (make sure the
  StockItem exists, add the movements, lock and update the totals). They are
  all short and keyed, and the double lock is gone.
- A made part whose station is really deleted keeps its stock. The parts
  still exist. The repair job reports these movements but does not undo
  them. The old rebuild would have quietly dropped that stock.
- Corrections made before this change are not rebuilt as history. The book
  starts with one movement per record that counted on the day of the move.
- Rollout: the migration fills the book but keeps `ProductStock`, so servers
  still on the old code keep working during the deploy. Anything those
  servers save during the rollout reaches the book by itself: the `rollups`
  worker runs a catch-up every five minutes from startup
  (`catchUpAfterStockMigration`). Old code updates `ProductStock` in the same
  save as every stock record and new code never does, so a `ProductStock` row
  changed after the migration names a product to check. Only those products'
  recent records are checked, and the catch-up stops a day after the
  migration. Nobody has to run a script. A later migration drops
  `ProductStock`.
- Rollout of phase 2 works the same way: old servers write material ledger
  rows without posting them, and the worker's `catchUpMaterialLedger` posts
  any recent ledger row that has no movement, for a day after it starts.
- Material balances can change at the phase 2 cutover where a material's
  ledger mixed units: the old balance added them as plain numbers, the book
  converts them. `packages/db/scripts/preflight-material-stock.sql` lists
  these, and the materials that get a unit from their history.

## Alternatives Considered

- **A real database link per kind** (`productId` / `materialId` columns on
  StockItem, exactly one set). Safer against orphans, but every new stockable
  kind needs a new column. We chose the Rails-style `stockableType` +
  `stockableId` and the guards in section 1.
- **Keep `ProductStock` and add a book next to it.** Two sets of numbers
  that both change would drift apart again.
- **A separate book for parts, mirroring `MaterialLedgerEntry`.** Two books
  mean two sets of rules, two locking orders, and two places for serials and
  batches to plug in.
- **One totals row per kind** (made, scrapped, …) instead of one row per
  item. More rows to lock per save for no gain.
- **Separate `Serial` and `Batch` tables.** This doubles the book, the totals
  and the genealogy paths. A serial is a batch of one.
- **Move materials in the same change.** Material stock includes shift usage
  that is not flushed yet and needs unit conversion. It is safer as its own
  step.
