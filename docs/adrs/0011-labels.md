# ADR-0011: Labels and station filters

**Status.** Accepted, 2026-08-21. Reworked 2026-08-24 (labels + filters
replaced the earlier classification design; ProcessType absorbed).

**The problem.** People need to group things like jobs, tools, products,
materials, and the codes operators pick (status/downtime codes, scrap
codes) — and then use those groups two ways: to find things ("show me the
molding jobs", "parts made for label X in reports") and to limit things ("this
station only runs molding jobs", "this station's operator screen only shows
press downtime codes"). Two earlier attempts didn't fit: giving each record
one home workcenter was too rigid (a product can belong to several), and a
two-kind "classification" with capability matching put the rule on the wrong
side (jobs demanded, machines supplied). The old system's "process groups"
(our `ProcessType` model) were a version of this idea too — but they were
nearly unused in code: written only by the legacy importer, read by almost
nothing.

**The decision — two small pieces.**

1. **Labels.** Each site has one shared list of labels (`Label`, one name per
   site). Users put labels on jobs, tools, products, materials, stations,
   status/downtime codes, and scrap codes. A record can carry many labels; a
   label can be on many records. Labels organize, filter lists
   (`labelIds` on the list endpoints), and slice reports. Only admins manage
   the list itself (`settings:write` to create/rename/delete); putting an
   existing label ON a record just needs permission to edit that record
   (`job:write` and so on), so office users tag things but can't invent
   labels. Deleting a label removes it from every record and filter at once.

2. **Filters.** An item that offers or accepts other items can define filter
   criteria against them, per kind of item. In v1 only **stations** own
   filters (`LabelFilter`, one row per station + target): a station may
   filter JOB, TOOL, STATUS_REASON, or DISPOSITION_REASON. The rule is
   simple: an item passes when it carries **at least one** of the filter's
   labels; no filter row = everything is eligible. Filters do two jobs:
   - **Narrow pickers.** Pass a `stationId` to the job/tool/status-code/
     scrap-code list endpoints and only what the station's filter allows
     comes back — so operator screens stop showing the whole site's list.
   - **Enforce on assignment.** `station.changeJob` refuses a job outside
     the JOB filter; assigning a downtime reason checks the STATUS_REASON
     filter; recording scrap checks the DISPOSITION_REASON filter
     (`LABEL_FILTER_MISMATCH`). What you can't pick, you also can't submit.

   When something else needs to own filters later (a workcenter, a display),
   it gets its own owner column on the same table — no redesign.

**What happened to ProcessType ("process groups").** Absorbed and removed.
Each live process type became a label with the same name; jobs, stations
(via their current version), scrap codes, and status codes that pointed at a
process type now carry that label instead. The `processType.*` endpoints,
the service, and all four database columns are gone. The shift view's
`processTypeIds` filter chip is gone too — labels are the one grouping
mechanism (its `classificationIds` chip became `labelIds`). One honest gap:
`Workcenter.processTypeId` was dropped without conversion — it was only ever
written by the importer and read by nothing.

**Labels in reporting.** Labels are a reporting dimension: the log searches
accept `labelIds` (cycles by their job's labels; downtime and scrap by their
code's labels), resolved the same way existing filters resolve a workcenter
into its stations — turn the labels into a list of matching ids, then filter.
Full "group by label" arrives with the report engine on the star-schema
branch, where `Label` joins the dimension catalog. Two things to know:

1. **Groups can overlap.** A job can be in both "Molding" and
   "High Priority", so it counts in both groups; per-group totals can add up
   to more than the real total. Filtering to one group is always correct.
2. **Reports use today's labels.** Re-labeling a job changes how last
   month's numbers group. That matches how we already report on the
   site → workcenter → station structure; "label at the time" would be a
   separate future decision.

**What this is not.** Labels and filters shape what's *offered and
accepted*, not what's *visible*. Everyone who can read jobs still sees all
jobs. If plants later want label-based visibility, that becomes a
permissions feature on top of the same label list.
