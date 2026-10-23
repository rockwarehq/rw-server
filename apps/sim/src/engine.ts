// Drives the enabled stations: one runner per station, each a self-rescheduling
// timer that asks program.ts what to do next and publishes cycle signals onto
// the station's cycle tag. Also watches every cycle tag for messages the
// simulator didn't send, so the UI can warn when a gateway is feeding the same
// tag (two publishers = double cycles).

import { headers, type NatsConnection, type Subscription } from "@nats-io/transport-node";
import { deriveTagSubject } from "@rw/runtime/graph-subjects";

import type { ConfigStore, StationSim, TagRef } from "./config.js";
import type { StationInfo } from "./discovery.js";
import {
  type AutoStretch,
  type ProgramCursor,
  type Rng,
  advanceCursor,
  hashSeed,
  newCursor,
  pickAutoStretch,
  planCycle,
  seededRng,
  stepEndsAt,
} from "./program.js";

const SIM_HEADER = "Rw-Sim";
/** How long the cycle bit stays high before dropping back to 0. */
const PULSE_MS = 500;
/** Recheck cadence while there is nothing to pace against (no job / no standard). */
const IDLE_RECHECK_MS = 10_000;
/** A foreign message within this window counts as "someone else is publishing". */
const FOREIGN_WINDOW_MS = 60_000;
/** Cycle-to-cycle noise in auto. */
const AUTO_JITTER = 0.03;

const encoder = new TextEncoder();

export interface RunnerStatus {
  running: boolean;
  mode: "auto" | "program";
  /** Human summary, e.g. "auto · slow" or "step 2/3". */
  behavior: string;
  rate: number;
  autoState: string | null;
  stepIndex: number | null;
  stepEndsAt: string | null;
  nextCycleAt: string | null;
  lastCycleAt: string | null;
  cycles: number;
  note: string | null;
}

export interface StationView extends StationInfo {
  sim: StationSim;
  runtime: RunnerStatus | null;
  /** The tag actually published to (override, else the hook's). */
  tag: TagRef | null;
  /** Last time something other than this simulator published on the tag. */
  foreignAt: string | null;
}

interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

function tagFor(info: StationInfo, sim: StationSim): TagRef | null {
  return sim.tagOverride ?? info.cycleTag;
}

const sameTag = (a: TagRef | null, b: TagRef | null) => a?.deviceId === b?.deviceId && a?.tagPath === b?.tagPath;

class StationRunner {
  private timer: NodeJS.Timeout | null = null;
  private rng: Rng;
  private cursor: ProgramCursor;
  private stretch: AutoStretch | null = null;
  private status: RunnerStatus;
  private stopped = false;

  constructor(
    private readonly engine: SimEngine,
    readonly stationId: string,
    private tag: TagRef,
  ) {
    this.rng = seededRng(hashSeed(stationId) ^ Date.now());
    this.cursor = newCursor(Date.now());
    this.status = {
      running: true,
      mode: "auto",
      behavior: "starting",
      rate: 0,
      autoState: null,
      stepIndex: null,
      stepEndsAt: null,
      nextCycleAt: null,
      lastCycleAt: null,
      cycles: 0,
      note: null,
    };
    // Start low so the first cycle is a clean 0 → 1 rise.
    this.engine.publish(this.tag, 0);
    this.tick();
  }

  snapshot(): RunnerStatus {
    return { ...this.status };
  }

  /** Config changed: restart the program from its first step. */
  restart(tag: TagRef): void {
    if (!sameTag(tag, this.tag)) {
      this.tag = tag;
      this.engine.publish(this.tag, 0);
    }
    this.cursor = newCursor(Date.now());
    this.stretch = null;
    this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number, fn: () => void): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(fn, Math.max(0, ms));
  }

  private tick(): void {
    if (this.stopped) return;
    const now = Date.now();
    const info = this.engine.station(this.stationId);
    const sim = this.engine.config.station(this.stationId);
    this.status.mode = sim.mode;

    if (!info?.standards) {
      this.status = {
        ...this.status,
        behavior: "waiting",
        rate: 0,
        nextCycleAt: null,
        note: info?.jobId ? "job has no standard" : "no job assigned",
      };
      this.schedule(IDLE_RECHECK_MS, () => this.tick());
      return;
    }
    this.status.note = null;

    let rate: number;
    let jitter: number;
    let wakeAt: number | null;
    if (sim.mode === "auto") {
      if (!this.stretch || now >= this.stretch.endsAt) this.stretch = pickAutoStretch(undefined, now, this.rng);
      rate = this.stretch.rate;
      jitter = AUTO_JITTER;
      wakeAt = this.stretch.endsAt;
      this.status = {
        ...this.status,
        behavior: `auto · ${this.stretch.state}`,
        autoState: this.stretch.state,
        stepIndex: null,
        stepEndsAt: new Date(this.stretch.endsAt).toISOString(),
      };
    } else {
      this.cursor = advanceCursor(sim.steps, this.cursor, now);
      const step = sim.steps[this.cursor.index];
      if (!step) {
        this.status = { ...this.status, behavior: "no steps", rate: 0, nextCycleAt: null };
        this.schedule(IDLE_RECHECK_MS, () => this.tick());
        return;
      }
      rate = step.type === "rate" ? step.rate : 0;
      jitter = step.type === "rate" ? step.jitter : 0;
      wakeAt = stepEndsAt(step, this.cursor);
      this.status = {
        ...this.status,
        behavior: sim.steps.length > 1 ? `step ${this.cursor.index + 1}/${sim.steps.length}` : "program",
        autoState: null,
        stepIndex: this.cursor.index,
        stepEndsAt: wakeAt ? new Date(wakeAt).toISOString() : null,
      };
    }

    this.status.rate = rate;
    if (rate <= 0) {
      this.status.nextCycleAt = null;
      this.schedule(wakeAt != null ? wakeAt - now : IDLE_RECHECK_MS, () => this.tick());
      return;
    }

    const plan = planCycle(info.standards, rate, jitter, this.rng);
    this.status.nextCycleAt = new Date(now + plan.delayMs).toISOString();
    this.schedule(plan.delayMs, () => this.fire(plan.quantity));
  }

  private fire(quantity: number | null): void {
    if (this.stopped) return;
    const info = this.engine.station(this.stationId);
    // Count-by-time: the count lands before the bit, the PLC handshake order.
    if (quantity != null && info?.quantityTag) this.engine.publish(info.quantityTag, quantity);
    this.engine.publish(this.tag, 1);
    const tag = this.tag;
    setTimeout(() => this.engine.publish(tag, 0), PULSE_MS);

    this.status.cycles += 1;
    this.status.lastCycleAt = new Date().toISOString();
    this.tick();
  }
}

export class SimEngine {
  private stations = new Map<string, StationInfo>();
  private runners = new Map<string, StationRunner>();
  private watchers = new Map<string, Subscription>();
  private foreignAt = new Map<string, number>();

  constructor(
    private readonly nc: NatsConnection,
    readonly config: ConfigStore,
    private readonly log: Logger,
  ) {}

  /** Workspaces owning the discovered stations — whose users may sign in. */
  workspaceIds(): Set<string> {
    return new Set([...this.stations.values()].map((s) => s.workspaceId).filter(Boolean));
  }

  station(id: string): StationInfo | undefined {
    return this.stations.get(id);
  }

  publish(tag: TagRef, value: number): void {
    const h = headers();
    h.set(SIM_HEADER, "1");
    const envelope = { value, quality: "good", timestamp: Date.now() };
    this.nc.publish(deriveTagSubject(tag.deviceId, tag.tagPath), encoder.encode(JSON.stringify(envelope)), {
      headers: h,
    });
  }

  /** New discovery results: refresh station info, tag watchers and runners. */
  updateStations(infos: StationInfo[]): void {
    this.stations = new Map(infos.map((s) => [s.id, s]));
    this.syncWatchers();
    for (const id of new Set([...this.runners.keys(), ...this.stations.keys()])) this.syncRunner(id, false);
  }

  /** A station's config was saved: (re)start, restart or stop its runner. */
  applyStation(id: string): void {
    this.syncWatchers();
    this.syncRunner(id, true);
  }

  views(): StationView[] {
    const now = Date.now();
    return [...this.stations.values()].map((info) => {
      const sim = this.config.station(info.id);
      const tag = tagFor(info, sim);
      const foreign = tag ? this.foreignAt.get(deriveTagSubject(tag.deviceId, tag.tagPath)) : undefined;
      return {
        ...info,
        sim,
        tag,
        runtime: this.runners.get(info.id)?.snapshot() ?? null,
        foreignAt: foreign && now - foreign < FOREIGN_WINDOW_MS ? new Date(foreign).toISOString() : null,
      };
    });
  }

  stop(): void {
    for (const r of this.runners.values()) r.stop();
    this.runners.clear();
    for (const s of this.watchers.values()) s.unsubscribe();
    this.watchers.clear();
  }

  private syncRunner(id: string, restart: boolean): void {
    const info = this.stations.get(id);
    const sim = this.config.station(id);
    const tag = info ? tagFor(info, sim) : null;
    const runner = this.runners.get(id);

    if (!info || !sim.enabled || !tag) {
      if (runner) {
        runner.stop();
        this.runners.delete(id);
        this.log.info(`[sim] stopped ${info?.name ?? id}`);
      }
      return;
    }
    if (!runner) {
      this.runners.set(id, new StationRunner(this, id, tag));
      this.log.info(`[sim] started ${info.name}`);
    } else if (restart) {
      runner.restart(tag);
    }
  }

  private syncWatchers(): void {
    const wanted = new Set<string>();
    for (const info of this.stations.values()) {
      const tag = tagFor(info, this.config.station(info.id));
      if (tag) wanted.add(deriveTagSubject(tag.deviceId, tag.tagPath));
    }
    for (const [subject, sub] of this.watchers) {
      if (!wanted.has(subject)) {
        sub.unsubscribe();
        this.watchers.delete(subject);
      }
    }
    for (const subject of wanted) {
      if (this.watchers.has(subject)) continue;
      const sub = this.nc.subscribe(subject, {
        callback: (err, msg) => {
          if (err) return;
          if (msg.headers?.get(SIM_HEADER) !== "1") this.foreignAt.set(subject, Date.now());
        },
      });
      this.watchers.set(subject, sub);
    }
  }
}
