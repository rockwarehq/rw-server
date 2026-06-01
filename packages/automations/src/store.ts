import type { Automation } from "./types.js";


export interface AutomationStore {
  list(): Automation[];
  get(id: string): Automation | undefined;
  upsert(automation: Automation): Promise<Automation>;
  remove(id: string): Promise<boolean>;
  newId(): string;
}
