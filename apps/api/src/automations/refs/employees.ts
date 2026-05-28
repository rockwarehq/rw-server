import type { RefSource } from "@rw/automations";

/**
 * MOCK employees fixture + ref source for the file-mock path. Mirrors the shape returned by the
 * DB-backed source at `@rw/services/employee/automation-ref` so the editor renders identically.
 *
 * Two call sites:
 *   - `employeesRefSource.list(ctx)` — feeds the editor's recipient picker over the RPC layer.
 *   - `getFixtureEmployeeById(id)` — used by action handlers to resolve stored ids → Employee at
 *     run time (no framework hydration today, see @rw/automations README "Ref data sources").
 */

export interface Employee {
  id: string;
  name: string;
}

const FIXTURE: Employee[] = [
  { id: "e_supervisor", name: "Sam Supervisor" },
  { id: "e_shift_lead", name: "Riley Shift-Lead" },
  { id: "e_ops", name: "Ops Pager" },
];

const BY_ID = new Map(FIXTURE.map((e) => [e.id, e]));

/** Resolve a stored employee id against the in-memory fixture. Used by the file-mock branch only. */
export function getFixtureEmployeeById(id: string): Employee | undefined {
  return BY_ID.get(id);
}

export const employeesRefSource: RefSource = {
  key: "employees",
  async list(_ctx) {
    return FIXTURE.map((e) => ({ id: e.id, label: e.name }));
  },
};
