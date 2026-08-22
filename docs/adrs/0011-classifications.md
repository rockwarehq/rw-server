# ADR-0011: Classifications — labels that can also match jobs to machines

**Status.** Accepted, 2026-08-21.

**The problem.** People need to group things like jobs, tools, products, and
materials. For example: "these are the molding jobs" or "these products are
for the 1 tonne presses". Our first try gave each record one home workcenter
(a `workcenterId` column). That didn't fit real plants: one product can be
made in several workcenters, and a group like "all molding machines" can be
spread across many workcenters. Our old system had "process groups" for
this, but that name mixed two different ideas together. Funny enough, two
old tables in our database (`ToolClassification` and `StationClassification`)
were built for this years ago but never hooked up to anything.

**The decision.** One shared list of labels per site, called
`Classification`. A label has a name (unique per site:
`@@unique([siteId, name])`) and a `kind` that says whether the label just
groups things or also makes rules:

- **GROUP** — a plain label. Use it to organize and filter. It never blocks
  anything. Example: "Molding", "High Priority".
- **CAPABILITY** — a matching label. Machines say what they can do; jobs say
  what they need. When someone puts a job on a station
  (`station.changeJob`), we check that the station has **every** CAPABILITY
  label the job carries. If it's missing one, the change is refused with
  `CAPABILITY_MISMATCH` and the message names what's missing. Example: a job
  labeled "1 tonne press" and "robot arm" only runs on a machine that has
  both labels. GROUP labels are never part of this check.

A label can be attached to many records, and a record can carry many labels.
You can attach them to jobs, tools, products, materials, and stations. If a
plant starts with a plain GROUP label and later wants it to be a rule, an
admin can change its kind to CAPABILITY.

**Who can do what.** Creating, renaming, and deleting labels needs
`settings:write` (Factory Administrators keep the list tidy). Putting an
existing label ON a record only needs permission to edit that record
(`job:write` and so on). So office users can tag things, but they can't
invent new labels. Deleting a label removes it from every record at once and
removes any rule it was enforcing.

**What happened to the old tables.** We dropped `ToolClassification` and
`StationClassification`. Any rows they held were copied into
`Classification` first, keeping the same ids (so saved shift-view filters
still work). Their old `MACHINE_SPEC` type became `CAPABILITY`. Station data
now shows a `kind` field where it used to show `type`.

**Two things to know when reporting on labels.** Our reporting work groups
numbers by things like site and workcenter, and labels join that list:

1. **Groups can overlap.** A job can be in both "Molding" and
   "High Priority", so it counts in both groups. If you add up every group's
   total, you can get more than the real total. Filtering to one group is
   always correct; just don't present a per-group breakdown as if it adds up
   to 100%.
2. **Reports use today's labels.** If someone re-labels a job next month,
   reports about last month will group that job by its new labels, not the
   ones it had back then. That matches how we already report on the
   site → workcenter → station structure. If "what label did it have at the
   time" ever matters, that's a separate future decision.

**What this is not.** Labels organize and match — they don't hide anything.
Everyone who can see jobs sees all jobs, labeled or not. If plants later
want "molding operators only see molding jobs", that would be a permissions
feature built on top of this same label list, not a new system.
