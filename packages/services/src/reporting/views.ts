import type { CatalogText } from "./types.js";

// Views are the front doors to the catalog, like Cube views or Looker
// explores. Each one is a topic people ask about (OEE, downtime, scrap) and
// points at one fact, keeping only the measures and dimensions that make
// sense for that topic.
//
// A view adds no SQL. A query on a view is a query on its fact, so everything
// the compiler checks still applies. Views exist to keep choices small and
// clear, for people and for the AI. The report explorer can still use every
// fact directly.

export interface ViewDef extends CatalogText {
  label: string;
  description: string;
  fact: string;
  /** The measures this view offers, best first. */
  measures: readonly string[];
  /** The dimensions this view offers, most used first. */
  dimensions: readonly string[];
  /** The segments this view offers. */
  segments?: readonly string[];
  examples?: readonly string[];
}

const TIME = ["businessDate", "shift"] as const;
const PLACE = ["workcenter", "station"] as const;

export const VIEWS: Record<string, ViewDef> = {
  oee: {
    label: "OEE",
    description:
      "How well stations ran: OEE, availability, performance and quality, with the parts and time behind them.",
    synonyms: ["kpis", "efficiency", "machine performance", "availability", "performance", "quality"],
    aiHint: "Start here for any OEE, availability, performance or quality question.",
    examples: ["OEE by station yesterday", "Which line had the worst availability this week?"],
    fact: "stationKpis",
    measures: [
      "oee",
      "availability",
      "performance",
      "quality",
      "goodItems",
      "badItems",
      "totalItems",
      "expectedItems",
      "runSeconds",
      "downSeconds",
      "unplannedDownSeconds",
      "plannedDownSeconds",
      "totalCycles",
      "avgCycleSeconds",
    ],
    dimensions: [...TIME, ...PLACE],
  },

  jobPerformance: {
    label: "Job performance",
    description: "How each job ran on each station: OEE, speed, parts and down time.",
    synonyms: ["job oee", "job efficiency"],
    examples: ["Which jobs ran slowest last week?"],
    fact: "jobKpis",
    measures: [
      "oee",
      "performance",
      "availability",
      "quality",
      "goodItems",
      "badItems",
      "avgCycleSeconds",
      "runSeconds",
      "downSeconds",
    ],
    dimensions: ["jobRun", ...PLACE, ...TIME],
  },

  downtime: {
    label: "Downtime",
    description: "When and why stations stopped, and for how long.",
    synonyms: ["stops", "breakdowns", "down time", "downtime reasons"],
    aiHint: "Use downSeconds for how long, blocks for how many stops. Split by statusReason for why.",
    examples: ["Top downtime reasons this week", "Unplanned downtime by line yesterday"],
    fact: "statePeriods",
    measures: ["downSeconds", "blocks", "maxDurationSeconds", "avgDurationSeconds", "upSeconds", "durationSeconds"],
    dimensions: ["statusReason", "statusCategory", ...PLACE, "job", "state", "status", ...TIME],
    segments: ["down", "unplannedDown", "plannedDown", "open"],
  },

  output: {
    label: "Output",
    description: "Parts made, parts scrapped and scrap rate.",
    synonyms: ["production", "parts made", "yield", "scrap rate", "throughput"],
    aiHint: "Start here for 'how many did we make' questions.",
    examples: ["Parts made and scrap rate by product last week", "Output by line this month"],
    fact: "production",
    measures: ["produced", "scrapped", "scrapRate", "netQuantity"],
    dimensions: ["product", ...PLACE, "job", "tool", "mode", ...TIME],
  },

  scrap: {
    label: "Scrap",
    description: "Scrapped parts and why they were scrapped.",
    synonyms: ["rejects", "defects", "scrap reasons", "waste"],
    examples: ["Top scrap reasons last 7 days", "Scrap by cavity for a tool this month"],
    fact: "dispositions",
    measures: ["quantity", "entries"],
    dimensions: ["reason", "disposition", "product", ...PLACE, "job", "tool", "toolCavity", ...TIME],
  },

  cycles: {
    label: "Cycles",
    description: "Machine cycles: how many, good or bad, and how long they took.",
    synonyms: ["shots", "strokes", "cycle time"],
    examples: ["Average cycle time by job this week"],
    fact: "cycles",
    measures: ["cycles", "avgCycleSeconds", "goodCycles", "badCycles", "goodCycleRate", "earnedSeconds", "quantity"],
    dimensions: [...PLACE, "job", "mode", "cycleStatus", ...TIME],
    segments: ["goodOnly", "badOnly"],
  },

  materials: {
    label: "Material usage",
    description: "Raw material used in production.",
    synonyms: ["resin", "consumption", "material used"],
    aiHint: "Always group by unit.",
    examples: ["Material used by product this month"],
    fact: "materialUsage",
    measures: ["quantity", "itemCount"],
    dimensions: ["material", "unit", "product", ...PLACE, "job", ...TIME],
  },

  operators: {
    label: "Operators",
    description: "Who was logged on, where, and for how long.",
    synonyms: ["labor", "people", "logins", "who worked"],
    examples: ["Hours logged on by operator this week"],
    fact: "logonSessions",
    measures: ["durationSeconds", "sessions", "avgDurationSeconds"],
    dimensions: ["employee", ...PLACE, "logonMethod", ...TIME],
    segments: ["open"],
  },

  calls: {
    label: "Calls",
    description: "Help calls raised on the floor, and how fast they were answered.",
    synonyms: ["andon", "alerts", "response time"],
    examples: ["Average response time by call type this week"],
    fact: "calls",
    measures: ["calls", "avgOpenSeconds", "maxOpenSeconds", "openSeconds"],
    dimensions: ["definition", "severity", ...PLACE, "job", "product", ...TIME],
    segments: ["open"],
  },

  jobs: {
    label: "Job history",
    description: "Which jobs ran where, how often, and for how long.",
    synonyms: ["job runs", "schedule history"],
    fact: "jobRuns",
    measures: ["runs", "durationSeconds"],
    dimensions: ["job", ...PLACE, ...TIME],
    segments: ["open"],
  },
};
