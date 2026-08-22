# ADR-0011: Classifications — shared labels with optional capability matching

**Status.** Accepted, 2026-08-21.

**Context.** Master data (Job, Tool, Product, Material) needed grouping beyond
the site: "molding jobs", "products for the 1-tonne presses". A first attempt
modeled this as single-workcenter ownership (`workcenterId` on each head
table) and was rejected in review: a product can belong to several
workcenters, and groups like "all molding machines" cut across workcenters.
The legacy system's "process groups" solved this but conflated two ideas.
Two dead tables (`ToolClassification`, `StationClassification`, enum
`MACHINE_SPEC | GROUP`) anticipated the decomposition but were never wired.

**Decision.** One site-scoped `Classification` vocabulary
(`@@unique([siteId, name])`), applied many-to-many to Job, Tool, Product,
Material, and Station, with a `kind` that determines whether anything
enforces it:

- **GROUP** — a plain label. Organize, filter lists (`classificationIds`,
  ANY semantics), slice metrics. No rules.
- **CAPABILITY** — a matching vocabulary. Stations declare capabilities;
  jobs require them; `station.changeJob` enforces **subset semantics**:
  every CAPABILITY classification on the job must be present on the station
  (`CAPABILITY_MISMATCH`), so a job needing "1 tonne press" and "robot arm"
  only dispatches to machines with both. GROUP never enforces. A label can
  be promoted to a capability by changing its kind.

Vocabulary CRUD requires `settings:write` (curated by Factory
Administrators); *assigning* existing classifications rides each record's
own write permission, so office users tag without minting. Classifications
are hard-deleted: the m2m join rows cascade, detaching the label everywhere
and dropping any requirement it expressed.

The superseded tables were dropped, carrying rows over id-preserved
(`MACHINE_SPEC → CAPABILITY`) so saved shift-view `classificationIds` keep
resolving. Station reads now expose `kind` where they exposed `type`.

**Dimensional modeling.** `Classification` doubles as a conformed dimension
for the star-schema work; the implicit m2m join tables are the bridge tables
(the standard multivalued-dimension answer). Two semantics are deliberate:

1. **Overlap** — membership is not a partition. A job in both "Molding" and
   "High-Priority" contributes facts to both groups; sums across
   classifications can exceed the grand total. Ratio-of-sums metrics filtered
   to one classification are always consistent; "group by classification"
   reports are overlapping segments, not a 100% breakdown.
2. **As-is** — the live bridge is joined at query time (current labels),
   matching how metrics already treat the Station→Workcenter hierarchy. If
   "label at time of production" ever matters, that is a fact-side snapshot
   decision, not a change to this model.

**Consequences.** No visibility/authorization semantics are attached to
classifications today — they organize and match, they do not hide. If plants
later want "molding operators only see molding jobs", that becomes an IAM
concern layered on the same vocabulary, not a new mechanism.
