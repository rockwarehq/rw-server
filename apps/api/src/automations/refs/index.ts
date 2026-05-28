// File-mock ref sources, one per kind. Wired into the framework's RefRegistry in
// `apps/api/src/automations/index.ts` for the file-mock path (the DB-backed path uses parallel
// sources from each domain folder under `@rw/services/<domain>/automation-ref`).
//
// To add a new ref source: drop a `<name>.ts` here exporting a `RefSource`, re-export it below,
// register it in `index.ts`. Add a parallel DB-backed source under the matching domain.

export { employeesRefSource, getFixtureEmployeeById, type Employee } from "./employees.js";
export { workCentersRefSource } from "./workcenters.js";
export { stationsRefSource } from "./stations.js";
export { jobsRefSource } from "./jobs.js";
