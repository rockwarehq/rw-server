// The simulator's whole configuration is one JSON file (SIM_CONFIG_PATH). The
// UI edits it through the API; every save is validated, written atomically,
// and applied to the running engine.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

export const AUTO_STATES = ["great", "normal", "slow", "microstop", "down"] as const;
export type AutoState = (typeof AUTO_STATES)[number];

// A program is a list of steps that loops forever. Each step runs for
// `durationSec`; without one it holds until the program is changed.
export const stepSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("rate"),
    /** Rate multiplier: 1 = standard, 1.2 = 20% fast. */
    rate: z.number().positive().max(10),
    /** ± fraction of noise on every cycle. */
    jitter: z.number().min(0).max(0.5).default(0.03),
    durationSec: z.number().positive().optional(),
  }),
  z.object({ type: z.literal("stop"), durationSec: z.number().positive().optional() }),
]);
export type Step = z.infer<typeof stepSchema>;

export const tagRefSchema = z.object({ deviceId: z.string().min(1), tagPath: z.string().min(1) });
export type TagRef = z.infer<typeof tagRefSchema>;

export const stationSimSchema = z.object({
  /** Off = the simulator leaves this station alone (e.g. a real gateway feeds it). */
  enabled: z.boolean().default(false),
  /** auto = realistic random machine; program = the steps below. */
  mode: z.enum(["auto", "program"]).catch("auto").default("auto"),
  steps: z.array(stepSchema).default([{ type: "rate", rate: 1, jitter: 0.03 }]),
  /** Publish here instead of the tag the station's cycle hook watches. */
  tagOverride: tagRefSchema.nullable().default(null),
});
export type StationSim = z.infer<typeof stationSimSchema>;

export const simConfigSchema = z.object({
  version: z.literal(1).default(1),
  stations: z.record(z.string(), stationSimSchema).default({}),
});
export type SimConfig = z.infer<typeof simConfigSchema>;

export function defaultStationSim(): StationSim {
  return stationSimSchema.parse({});
}

export class ConfigStore {
  private config: SimConfig = simConfigSchema.parse({});
  private writing: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {}

  async load(): Promise<SimConfig> {
    try {
      this.config = simConfigSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return this.config;
  }

  get(): SimConfig {
    return this.config;
  }

  station(stationId: string): StationSim {
    return this.config.stations[stationId] ?? defaultStationSim();
  }

  async setStation(stationId: string, sim: StationSim): Promise<void> {
    this.config = { ...this.config, stations: { ...this.config.stations, [stationId]: sim } };
    await this.save();
  }

  async setStations(updates: Record<string, StationSim>): Promise<void> {
    this.config = { ...this.config, stations: { ...this.config.stations, ...updates } };
    await this.save();
  }

  // Serialized + write-then-rename, so a crash mid-save never leaves a torn file.
  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.config, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, `${snapshot}\n`, "utf8");
      await rename(tmp, this.path);
    });
    return this.writing;
  }
}
