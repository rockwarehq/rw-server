import type { RefSource } from "@rw/automations";

/** MOCK stations fixture for the file-mock path — same shape as the DB-backed source. */
const FIXTURE = [
  { id: "s_1", name: "S-1" },
  { id: "s_2", name: "S-2" },
  { id: "s_3", name: "S-3" },
];

export const stationsRefSource: RefSource = {
  key: "stations",
  async list(_ctx) {
    return FIXTURE.map((s) => ({ id: s.id, label: s.name }));
  },
};
