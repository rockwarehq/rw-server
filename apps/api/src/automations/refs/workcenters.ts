import type { RefSource } from "@rw/automations";

/** MOCK workcenters fixture for the file-mock path — same shape as the DB-backed source. */
const FIXTURE = [
  { id: "wc_assembly", name: "Assembly" },
  { id: "wc_paint", name: "Paint Booth" },
  { id: "wc_packout", name: "Packout" },
];

export const workCentersRefSource: RefSource = {
  key: "workCenters",
  async list(_ctx) {
    return FIXTURE.map((wc) => ({ id: wc.id, label: wc.name }));
  },
};
