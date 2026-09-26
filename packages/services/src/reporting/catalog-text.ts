import type { CatalogText, FactDef, SegmentDef } from "./types.js";

// The words for the catalog: what each fact, measure and dimension means, the
// other names people use for it, and tips for the AI. None of this touches
// SQL. It lives apart from facts.ts so the SQL stays easy to read, and it is
// merged onto FACTS once, when the module loads (see applyCatalogText).
//
// Write for a person on the floor: short, plain, no jargon. A test checks that
// every measure and dimension ends up with a description.

/** Text for a dimension key, used by every fact that has that key. */
const SHARED_DIMENSIONS: Record<string, CatalogText> = {
  businessDate: {
    description:
      "The work day the row belongs to. A night shift that ends after midnight still counts on the day it started.",
    synonyms: ["date", "day", "work day", "production day"],
    aiHint: "Use this for any 'by day / week / month' question, and pick the size with dateGranularity.",
  },
  shift: {
    description: "The shift the row happened in, like Day or Night on a given date.",
    synonyms: ["crew", "shift name"],
  },
  scheduled: {
    description:
      "Whether the time was inside a planned shift. Time outside any shift is hidden unless you group or filter by this.",
    synonyms: ["planned time", "unscheduled", "off shift"],
    aiHint: "Leave it alone unless the question is about time outside shifts.",
  },
  station: {
    description: "The machine or work spot that did the work.",
    synonyms: ["machine", "press", "asset", "equipment", "cell"],
    aiHint: "People often say 'press 12' or 'machine 3'. Use find_values to turn a name into an id.",
  },
  workcenter: {
    description: "The group of stations the row belongs to, like a line or an area.",
    synonyms: ["line", "area", "department", "work center", "cell"],
  },
  job: {
    description: "The job that was running.",
    synonyms: ["work order", "run", "part run"],
  },
  product: {
    description: "The part or product made.",
    synonyms: ["part", "item", "sku", "part number"],
  },
  productSku: {
    description: "The product's SKU code. Same rows as product, but shows the code instead of the name.",
    synonyms: ["sku", "part number"],
  },
  tool: {
    description: "The tool or mold used.",
    synonyms: ["mold", "mould", "die", "fixture"],
  },
  toolCavity: {
    description: "The cavity of the tool the scrap came from.",
    synonyms: ["cavity"],
  },
  mode: {
    description: "The production mode the station was in, like Production, Setup or Maintenance.",
    synonyms: ["production mode", "setup", "changeover"],
  },
  material: {
    description: "The raw material, like a resin or a coil.",
    synonyms: ["resin", "raw material", "component"],
  },
  unit: {
    description: "The unit a material quantity is counted in, like KG or LB.",
    synonyms: ["uom", "unit of measure"],
    aiHint: "Material quantities in different units must never be added. Always group by unit.",
  },
  employee: {
    description: "The operator's name.",
    synonyms: ["operator", "worker", "person", "who"],
  },
  employeeNumber: {
    description: "The operator's badge number. Same rows as employee, but shows the number.",
    synonyms: ["badge", "employee id"],
  },
  display: {
    description: "The screen the operator logged on at.",
    synonyms: ["terminal", "screen", "tablet"],
  },
  order: {
    description: "The customer order.",
    synonyms: ["sales order", "po", "customer order"],
  },
  amendment: {
    description: "The manual fix that changed the row's job, if any.",
  },
  granularity: {
    description:
      "How long each saved KPI window is. SHIFT is the default. Never add windows of different sizes together.",
    aiHint: "Leave it alone. Only set HOUR (with hourly dates) when the question is about hours.",
  },
};

interface FactText extends CatalogText {
  examples?: readonly string[];
  measures?: Record<string, CatalogText>;
  /** Wins over SHARED_DIMENSIONS for this fact. */
  dimensions?: Record<string, CatalogText>;
  segments?: Record<string, SegmentDef>;
  /** Measures that must be split by these dimensions. */
  requires?: Record<string, readonly string[]>;
}

/** Text for the three KPI facts, which share their measures. */
const KPI_MEASURES: Record<string, CatalogText> = {
  totalCycles: { description: "All cycles run.", synonyms: ["shots", "strokes", "cycles"] },
  goodCycles: { description: "Cycles marked good." },
  badCycles: { description: "Cycles marked bad." },
  expectedCycles: { description: "Cycles the station should have run at its standard speed." },
  totalItems: { description: "All parts made, good and bad.", synonyms: ["parts", "pieces", "count", "output"] },
  goodItems: { description: "Good parts made.", synonyms: ["good parts", "good count", "yield"] },
  badItems: { description: "Bad parts made.", synonyms: ["scrap", "rejects", "bad parts"] },
  expectedItems: { description: "Parts the station should have made at its standard speed.", synonyms: ["target"] },
  runSeconds: { description: "Time the station was running, in seconds.", synonyms: ["run time", "uptime"] },
  downSeconds: { description: "Time the station was down, in seconds.", synonyms: ["downtime"] },
  plannedDownSeconds: { description: "Down time that was planned, like breaks or maintenance, in seconds." },
  unplannedDownSeconds: {
    description: "Down time that was not planned, like breakdowns, in seconds.",
    synonyms: ["breakdowns", "unplanned downtime"],
  },
  idealCycleSeconds: { description: "How long the cycles run should have taken at standard speed, in seconds." },
  totalCycleSeconds: { description: "How long the cycles actually took, in seconds." },
  elapsedPlannedProductionSeconds: {
    description: "Time the station was supposed to be making parts, in seconds.",
    synonyms: ["planned time", "available time"],
  },
  availability: {
    description: "Share of planned time the station was running. Run time ÷ planned production time.",
    synonyms: ["uptime %", "availability %"],
  },
  performance: {
    description: "How close to standard speed the station ran while it was running.",
    synonyms: ["speed", "rate", "efficiency"],
  },
  avgCycleSeconds: { description: "Average actual cycle time, in seconds.", synonyms: ["cycle time"] },
  quality: {
    description: "Share of parts made that were good.",
    synonyms: ["yield", "first pass yield", "good %"],
  },
  oee: {
    description: "Overall equipment effectiveness: availability × performance × quality.",
    synonyms: ["overall equipment effectiveness", "efficiency"],
    aiHint: "Always ask for oee itself. Never average OEE numbers yourself; the server combines them the right way.",
  },
};

const FACTS_TEXT: Record<string, FactText> = {
  cycles: {
    synonyms: ["shots", "strokes", "machine cycles"],
    examples: ["How many cycles did each press run yesterday?", "Average cycle time by job this week"],
    aiHint: "For parts made, prefer the production fact. Use cycles for machine counts and cycle times.",
    measures: {
      cycles: { description: "Number of finished cycles.", synonyms: ["shots", "count"] },
      quantity: { description: "Parts made by the cycles. A cycle with no quantity counts as 1." },
      goodCycles: { description: "Cycles marked good." },
      badCycles: { description: "Cycles marked bad or thrown away." },
      cycleSeconds: { description: "Total time spent in cycles, in seconds." },
      avgCycleSeconds: { description: "Average time of one cycle, in seconds.", synonyms: ["cycle time"] },
      earnedSeconds: { description: "Standard time earned by the finished cycles, in seconds." },
      goodCycleRate: { description: "Share of cycles marked good." },
      amendedCycles: { description: "Cycles whose job was changed by a manual fix." },
    },
    dimensions: {
      cycleStatus: { description: "Whether the cycle was good, bad or thrown away." },
    },
    segments: {
      goodOnly: { label: "Good cycles", description: "Only cycles marked good.", filter: `f."cycleStatus" = 'GOOD'` },
      badOnly: {
        label: "Bad cycles",
        description: "Only cycles marked bad or thrown away.",
        filter: `f."cycleStatus" <> 'GOOD'`,
      },
    },
  },

  items: {
    synonyms: ["parts made", "output", "production"],
    aiHint: "For output with scrap taken off, use the production fact instead.",
    measures: {
      rows: { description: "Number of item records." },
      quantity: { description: "Parts made.", synonyms: ["output", "pieces", "count"] },
      amendedItems: { description: "Item records whose job was changed by a manual fix." },
    },
  },

  dispositions: {
    synonyms: ["scrap", "rejects", "waste", "defects"],
    examples: ["Top scrap reasons last 7 days", "Scrap by cavity for tool X this month"],
    measures: {
      entries: { description: "Number of scrap entries." },
      quantity: { description: "Parts scrapped.", synonyms: ["scrap count", "rejects"] },
    },
    dimensions: {
      disposition: { description: "What happened to the part, like Scrap or Rework." },
      reason: { description: "Why the part was scrapped.", synonyms: ["scrap reason", "defect", "cause"] },
    },
  },

  statePeriods: {
    synonyms: ["downtime", "stops", "status history", "up time"],
    examples: ["Top downtime reasons this week", "Unplanned downtime by line yesterday"],
    aiHint:
      "Best place for downtime reasons. Use blocks to count stops, not periods. For downtime use downSeconds or the down segment.",
    measures: {
      periods: { description: "Pieces of time, split at shift changes. One stop can be many pieces." },
      blocks: { description: "Number of separate stops or runs. Each counts once.", synonyms: ["stops", "events"] },
      durationSeconds: { description: "Total time, in seconds." },
      avgDurationSeconds: { description: "Average length of one piece, in seconds." },
      maxDurationSeconds: { description: "Longest single piece, in seconds." },
      downSeconds: { description: "Time the station was down, in seconds.", synonyms: ["downtime"] },
      upSeconds: { description: "Time the station was up, in seconds.", synonyms: ["uptime", "run time"] },
    },
    dimensions: {
      state: { description: "Up or down." },
      status: { description: "Finer status: fast, slow, up or down." },
      statusReason: { description: "Why the station was down or slow.", synonyms: ["downtime reason", "cause"] },
      statusCategory: { description: "The group the reason belongs to, like Mechanical or Material." },
    },
    segments: {
      down: { label: "Down", description: "Only time the station was down.", filter: `f."state" = 'DOWN'` },
      plannedDown: {
        label: "Planned down",
        description: "Only down time that was planned, like breaks.",
        filter: `f."state" = 'DOWN' AND f."isPlannedDown" IS TRUE`,
      },
      unplannedDown: {
        label: "Unplanned down",
        description: "Only down time that was not planned, like breakdowns.",
        synonyms: ["breakdowns"],
        filter: `f."state" = 'DOWN' AND f."isPlannedDown" IS NOT TRUE`,
      },
      open: {
        label: "Still going",
        description: "Only stretches that have not ended yet.",
        filter: `f."endTime" IS NULL`,
      },
    },
  },

  modePeriods: {
    synonyms: ["setup time", "changeovers", "maintenance time"],
    aiHint: "Stretches are not split at shift changes yet, so don't use this fact for per-shift numbers.",
    measures: {
      periods: { description: "Number of mode stretches." },
      durationSeconds: { description: "Total time in the mode, in seconds." },
      avgDurationSeconds: { description: "Average length of one stretch, in seconds." },
    },
  },

  jobRuns: {
    synonyms: ["job history", "assignments"],
    measures: {
      runs: { description: "Number of times a job was put on a station. Each counts once." },
      periods: { description: "Pieces of job time, split at shift changes." },
      durationSeconds: { description: "Total time the job was on the station, in seconds." },
      avgDurationSeconds: { description: "Average length of one piece, in seconds." },
    },
    segments: {
      open: { label: "Running now", description: "Only jobs still on the station.", filter: `f."endTime" IS NULL` },
    },
  },

  logonSessions: {
    synonyms: ["operators", "logins", "labor", "who worked"],
    examples: ["Hours logged on by operator this week"],
    measures: {
      sessions: { description: "Number of logons." },
      durationSeconds: { description: "Total time logged on, in seconds.", synonyms: ["labor time", "hours"] },
      avgDurationSeconds: { description: "Average length of one logon, in seconds." },
    },
    dimensions: {
      logonMethod: { description: "How the operator logged on: ID, PIN, badge or generic." },
    },
    segments: {
      open: {
        label: "Logged on now",
        description: "Only logons that have not ended.",
        filter: `f."logoffTime" IS NULL`,
      },
    },
  },

  calls: {
    synonyms: ["andon", "alerts", "help calls", "requests"],
    examples: ["Average response time by call type this week"],
    measures: {
      calls: { description: "Number of calls raised." },
      openSeconds: { description: "Total time calls were open, in seconds." },
      avgOpenSeconds: {
        description: "Average time from raising a call to closing it, in seconds.",
        synonyms: ["response time"],
      },
      maxOpenSeconds: { description: "Longest time one call was open, in seconds." },
    },
    dimensions: {
      definition: { description: "The kind of call, like Maintenance or Quality.", synonyms: ["call type"] },
      severity: { description: "How urgent the call was." },
      source: { description: "Whether a person or the system raised the call." },
    },
    segments: {
      open: { label: "Open calls", description: "Only calls not closed yet.", filter: `f."closedAt" IS NULL` },
    },
  },

  materialLedger: {
    synonyms: ["material stock", "material moves", "receipts"],
    aiHint: "Quantities go up and down (receipts are positive, use in production is negative). Always group by unit.",
    measures: {
      entries: { description: "Number of material changes." },
      quantity: { description: "Net change in material. Positive adds stock, negative takes it away." },
    },
    dimensions: {
      kind: { description: "What kind of change: receipt, fix, write-off, transfer, opening or production." },
    },
    requires: { quantity: ["unit"] },
  },

  materialUsage: {
    synonyms: ["consumption", "material used", "resin used"],
    examples: ["Material used by product this month"],
    aiHint: "Always group by unit.",
    measures: {
      quantity: { description: "Material used in production." },
      itemCount: { description: "Parts made while using the material." },
    },
    requires: { quantity: ["unit"] },
  },

  orderConsumptions: {
    synonyms: ["shipments", "fulfillment", "orders filled"],
    aiHint: "This only covers orders that were completed. It is not a list of all orders.",
    measures: {
      lines: { description: "Number of order lines filled." },
      quantity: { description: "Amount taken from stock to fill orders." },
    },
    dimensions: {
      source: { description: "How the amount was recorded: by hand, automatically, or filled in later." },
    },
  },

  stockAdjustments: {
    synonyms: ["inventory corrections", "cycle counts"],
    measures: {
      entries: { description: "Number of stock fixes." },
      delta: { description: "Net change in stock from the fixes. Can be negative." },
    },
    dimensions: {
      reason: { description: "Why the stock was changed, like a count or damage." },
    },
  },

  production: {
    synonyms: ["output", "net production", "yield", "parts made"],
    examples: ["Parts made and scrap rate by product last week", "Net output by line this month"],
    aiHint: "Best fact for 'how many did we make' and scrap rate.",
    measures: {
      produced: { description: "Parts made.", synonyms: ["output", "pieces"] },
      scrapped: { description: "Parts scrapped.", synonyms: ["scrap", "rejects"] },
      netQuantity: { description: "Parts made minus parts scrapped. Can be below zero for a short time span." },
      scrapRate: { description: "Scrapped ÷ made.", synonyms: ["scrap %", "reject rate"] },
    },
    dimensions: {
      entryType: { description: "Whether the row is parts made or parts scrapped." },
    },
  },

  stationKpis: {
    synonyms: ["oee", "kpis", "machine performance"],
    examples: ["OEE by station yesterday", "Availability, performance and quality by line this week"],
    aiHint: "Best fact for OEE, availability, performance and quality by station, line or day.",
    measures: KPI_MEASURES,
  },
  workcenterKpis: {
    synonyms: ["line oee", "line kpis"],
    aiHint:
      "Only use this when someone asks for the line's own numbers. Station KPIs grouped by workcenter usually fit better.",
    measures: KPI_MEASURES,
  },
  jobKpis: {
    synonyms: ["job performance", "job oee"],
    examples: ["Which jobs ran slowest last week?"],
    measures: KPI_MEASURES,
    dimensions: {
      jobRun: { description: "The job, on one station. The same job on two stations shows up twice." },
    },
  },
};

/** Merge the words above onto the catalog. Keeps whatever a def already says. */
export function applyCatalogText(facts: Record<string, FactDef>): void {
  for (const [factKey, fact] of Object.entries(facts)) {
    const text = FACTS_TEXT[factKey];
    if (text) {
      fact.synonyms ??= text.synonyms;
      fact.aiHint ??= text.aiHint;
      fact.examples ??= text.examples;
      fact.description ??= text.description;
      if (text.segments) fact.segments = { ...text.segments, ...fact.segments };
    }
    for (const [key, measure] of Object.entries(fact.measures)) {
      mergeText(measure, text?.measures?.[key]);
      const required = text?.requires?.[key];
      if (required) measure.requiresDimensions ??= required;
    }
    for (const [key, dimension] of Object.entries(fact.dimensions)) {
      mergeText(dimension, text?.dimensions?.[key]);
      mergeText(dimension, SHARED_DIMENSIONS[key]);
    }
  }
}

function mergeText(target: CatalogText, text: CatalogText | undefined): void {
  if (!text) return;
  target.description ??= text.description;
  target.synonyms ??= text.synonyms;
  target.aiHint ??= text.aiHint;
}
