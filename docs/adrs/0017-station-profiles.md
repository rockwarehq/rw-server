# 0017 – Station Profiles: How a Machine Counts, and Where a Job Can Run

- **Status:** Proposed
- **Date:** 2026-09-25
- **Deciders:** Michael Lindenau

## Context

Machines tell us they made something by sending a signal. Different machines
send different signals. We support three kinds:

| Name we use | Name in code (`CycleMode`) | Example |
|---|---|---|
| **Count by cycle** | `DISCRETE` | A molding press. One signal = one shot. How long a shot takes changes. |
| **Count by amount** | `QUANTITY_PER_CYCLE` | An extruder with an encoder. One signal = 100 ft. How long it takes changes. |
| **Count by time** | `QUANTITY_PER_INTERVAL` | A rivet header. One report every 60 s. How many parts are in it changes. |

Two more words:
- **Amount per signal** is how much one signal means, like 100 ft.
- **Report every** is how often a count-by-time machine reports, like 60 s.

(We no longer say "pulse".)

The math was already right. It lives in one place,
`packages/services/src/cycle/standards.ts`. Setting it up was the hard part:

- The station saved how it counts. The job page asked the same question again,
  but never saved the answer.
- One field meant two things. `standardCycle` was the cycle time on one
  machine and the report interval on another. `standardQuantity` was the amount
  per signal on one machine and the expected count per report on another.
- A job could change the amount per signal or the report interval. Those are
  set by the machine, not by the job.
- A job with blank speed fields borrowed the speed of whatever station ran it.
  Before any station picked it up, it had no target. Scheduling needs a
  target before that.
- The only thing that said where a job could run was the station's job label
  filter (ADR-0011). Its check was copied in two places, and no list used it.

## Decision

### 1. A profile is a named kind of machine

We add `StationProfile`, a list kept for each site. Examples are "Molding
press", "Extruder – every 100 ft" and "Rivet header – every minute". A profile
says:

- how the machine counts (`cycleMode`) and in what unit (`quantityUnit`);
- the **amount per signal** (`signalAmount`), for count by amount;
- **report every** (`signalInterval`, in seconds), for count by time;
- for count by time, what the number is (`countedAs`):
  - `OUTPUT`: the number is finished parts. The job sends it to **one** product
    at ×1, because one number can't be split.
  - `CYCLES`: the number is machine strokes. Each product's quantity is the
    parts per stroke.
  - Count by cycle is always `CYCLES`, and count by amount is always `OUTPUT`.
- the **usual speed**. For count by cycle this is seconds per cycle. For the
  other two it is a rate, like 45 ft/min.

Many stations use one profile, so a change is made in one place.

### 1a. The default profile: "Discrete"

Most plants do normal discrete work: one signal is one cycle, and each job has
a target cycle time in seconds. They should not have to set anything up. So:

- Every site has exactly one **default** profile, named **"Discrete"**. It
  always counts by cycle, and it can't be archived or switched to another kind.
  A partial unique index keeps one default per site. `ensureDefaultProfile`
  makes it the first time a site needs it.
- A new station with no profile gets the default. So does an older station
  when it is next edited, and it keeps its own cycle time.
- A new job with no profile gets the default, unless it arrives with a rate,
  which means another kind of machine.
- When checking where a job can run, a job with no profile counts as Discrete.
- The UI hides profiles until a plant adds a second one, for example for an
  extruder or a production-rate process. Until then, the job and station pages
  just show "Cycle time".

### 2. Three questions, three owners

| Question | Owner |
|---|---|
| What does one signal mean? | The profile. This is a fact about the machine. |
| How fast should this job go? | The job. A new job starts with the profile's usual speed. |
| What comes out of each count? | The job's products (`JobProduct.quantity`). |

### 3. Stations copy from their profile

A station that follows a profile gets the profile's values copied onto a new
`StationVersion`. This is the same thing that happens when anyone edits a
station.

- The cycle engine still reads only `StationVersion`, so its math did not
  change.
- Each field keeps the meaning the engine expects:
  - `standardQuantity` holds the amount per signal.
  - `standardCycle` holds the report interval when counting by time. Otherwise
    it holds the cycle time.
- A station can keep **its own speed**, for example a slower old press. Its
  version then has `speedFromProfile = false`. The other stations follow the
  profile's usual speed.
- When a profile changes, every station that follows it gets a new version
  right away.
- A profile that stations or jobs use can't change how it counts, or switch to
  a unit of a different kind (ft to lb). That would change what every recorded
  number means. Make a new profile instead.

### 4. The machine owns the amount per signal and the report interval

Jobs no longer change the amount per signal or the report interval.
`resolveStandards` reads both from the station only. `JobVersion.standardQuantity`
stays in the table, but the engine does not read it.

### 5. A job is its own document

A job is written before any station runs it. It points to the profile it is
made for (`JobVersion.profileId`), and it carries its own speed in that
profile's shape.

- `job.planning` gives the job's target with no station at all: its speed, or
  its profile's, turned into output per hour. Scheduling runs on this.
  Run time = target quantity ÷ output per hour.
- A job can move to another profile only if that profile counts the same way.
  If it doesn't, make a new job.

### 6. Where a job can run: one check with two gates

`canRunJob` (`facility/station/eligibility.ts`) is the only place this is
decided:

1. **Kind.** The job's profile and the station must count the same way, and in
   units of the same kind. They don't need to be the same profile. An ft/min
   job runs on a 100 ft extruder and on a 50 ft extruder alike.
   Reason code: `PROFILE_MISMATCH`.
2. **Labels.** The station's job label filter, unchanged from ADR-0011.
   Reason code: `LABEL_FILTER_MISMATCH`.

These use it:
- `changeJob` and history amendments. They used to have their own copies of the label check.
- `job.eligibleStations`, which lists every station with its reasons.
- `station.eligibleJobs`, for the operator's job picker.

Kind is not a label. Labels are free text, anyone can remove one, and any
matching label lets a job through. Kind changes the math, so it has to be a
fixed rule. Labels stay for business rules like tonnage, cell, customer or
certification.

### 7. Moving existing data

Migration `20261004100000_station_profiles` does these steps:

1. It makes one profile for each different counting setup on live stations,
   named like "Count by amount – 100 ft". The plain count-by-cycle setup
   becomes the site's "Discrete" default. Every site without one gets it.
2. It points each station at its profile. A station keeps its own speed. It
   follows the profile only if its speed already equals the profile's usual
   speed, which is the speed most of its stations use.
3. It gives each job the profile of the station it ran on last. Jobs that
   never ran get the Discrete default, unless they carry a rate; those stay
   without a profile until someone picks one.
4. It turns a count-by-time station's "expected per report" into a rate per
   minute. The number of units per report stays the same.

Count-by-time profiles start as `CYCLES`, because that keeps every job's
products as they are. Switch a profile to finished parts once its jobs each
have one product.

Run `packages/db/scripts/preflight-station-profiles.sql` on a copy of
production first. It lists the stations and jobs a person should look at,
including the jobs this change affects (point 4).

## What this sets up for later

The boxscore, the timeline and reports should show speed the way each machine
thinks about it. An extruder crew cares about ft/min, not cycle time. We are
not building that now, but here is where it starts:

- **The profile says how to show speed.** `speedDisplay(profile)` returns cycle
  time (count by cycle), or a rate in the machine's unit per the profile's
  period. For count by time it is parts or strokes.
- **The numbers are already recorded.** Every `Cycle` stamps `quantity`,
  `quantityUnit` and the earned `standardCycle`.
  - The real rate is Σ quantity ÷ Σ run seconds, a ratio of sums.
  - OEE performance (`idealCycleSeconds / runSeconds`) is already right for all
    three kinds, because the earned time is quantity × time per unit. So the
    score is right today. Only how it is shown will change.
- **Gaps to close then:**
  - Check whether `MetricBucket` keeps a sum of quantity in the station's unit,
    not just `totalItems`. If it doesn't, add one, so a rate can be rolled up
    per hour or per shift.
  - Reports can't add feet to pieces. They must group by kind of unit, and the
    profile gives them that key.
  - On the timeline, count-by-time bars are all the same length. The useful
    view is the amount in each bar compared with the expected amount.

## Consequences

- Setup gets simpler. A machine's counting is set once, on a profile. A job
  only answers "how fast?" and "what comes out?".
- Every job can have a target before it runs, so scheduling can use it.
- One check decides where a job can run, and the lists and the picker use it too.
- A job can no longer change a machine's amount per signal or report interval.
  Jobs that did so are listed by the preflight.
- The station's counting fields are now copies of its profile. They are kept
  in step by the service, not by the database. Hand edits to `StationVersion`
  can make a station disagree with its profile, until the next profile edit
  copies the profile's values back.
- Still to do:
  - Make `JobVersion.profileId` required once every job has one.
  - Drop `JobVersion.standardQuantity` and `productsPerCycle`.
  - Enforce TOOL label filters on the server. That has never been done
    (ADR-0011).

## Alternatives Considered

- **Profiles as presets that copy once and stay unlinked.** This is lighter,
  but stations drift apart and a fix has to be made again on every station.
- **The engine reads the profile directly.** This is cleaner on paper. But it
  changes the cycle engine and how history is replayed. Copying onto
  `StationVersion` gives the same result with no engine change.
- **Speed standards stored per job and per profile.** Only needed if one job
  runs on machines that count different ways. That is rare, and a second job
  handles it.
- **Kind as a label.** Rejected, as explained in section 6.
