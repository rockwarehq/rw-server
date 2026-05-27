import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { nanoid } from "nanoid";
import type { Trigger } from "./types.js";

/** The minimum the framework needs from a trigger store. Implement this against @rw/db later. */
export interface TriggerStore {
  list(): Trigger[];
  get(id: string): Trigger | undefined;
  upsert(t: Trigger): Trigger;
  remove(id: string): boolean;
  newId(): string;
}

const seedTrigger: Trigger = {
  id: "trg_seed",
  label: "Alert on job change at S-1",
  enabled: true,
  event: "job.changed",
  conditions: {
    combinator: "and",
    rules: [{ field: "event.payload.station", operator: "=", value: "S-1" }],
  },
  action: {
    type: "sendAlert",
    inputs: {
      text: "Job changed from {{event.payload.previousJob}} to {{event.payload.currentJob}} at {{event.payload.station}}",
      emails: ["supervisor@example.com"],
    },
  },
};

/**
 * MOCK, file-backed trigger store. Persists triggers to a JSON file so they survive restarts in
 * development. This is a stand-in for a real database — swap it for a @rw/db-backed implementation
 * of TriggerStore later; nothing else in the framework changes.
 *
 * File location: the `filePath` arg, else $TRIGGERS_MOCK_FILE, else ./.triggers-mock.json (cwd).
 */
export function createFileTriggerStore(filePath?: string): TriggerStore {
  const path = resolve(filePath ?? process.env.TRIGGERS_MOCK_FILE ?? ".triggers-mock.json");
  const triggers = new Map<string, Trigger>();

  load();

  function load(): void {
    if (existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as Trigger[];
        for (const t of raw) triggers.set(t.id, t);
        return;
      } catch {
        // Corrupt/unreadable file — fall through and reseed.
      }
    }
    triggers.set(seedTrigger.id, seedTrigger);
    save();
  }

  function save(): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify([...triggers.values()], null, 2));
  }

  return {
    list: () => [...triggers.values()],
    get: (id) => triggers.get(id),
    upsert: (t) => {
      triggers.set(t.id, t);
      save();
      return t;
    },
    remove: (id) => {
      const ok = triggers.delete(id);
      if (ok) save();
      return ok;
    },
    newId: () => `trg_${nanoid(8)}`,
  };
}
