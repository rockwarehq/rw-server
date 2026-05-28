import type { RefSource } from "@rw/automations";

/** MOCK jobs fixture for the file-mock path — same shape as the DB-backed source. */
const FIXTURE = [
  { id: "j_100", name: "J-100" },
  { id: "j_200", name: "J-200" },
  { id: "j_300", name: "J-300" },
];

export const jobsRefSource: RefSource = {
  key: "jobs",
  async list(_ctx) {
    return FIXTURE.map((j) => ({ id: j.id, label: j.name }));
  },
};
