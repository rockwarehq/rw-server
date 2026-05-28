/**
 * End-to-end smoke test for the automation framework against the MOCK store.
 *
 * Drives the real framework (no mocks of internals) over an isolated temp store file and asserts
 * the full event → automation → condition → action path.
 * Run: `pnpm --filter @rw/api exec tsx scripts/automations-e2e.ts`
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActionRegistry, createAutomationFramework, statelessContextBuilder, type AutomationStore } from "@rw/automations";
import { createAppAutomationFramework } from "../src/automations/index.js";
import { createFileAutomationStore } from "../src/automations/store.js";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ""}`);
  }
}

/** Run `fn` and return the Error it throws, or null if it didn't throw. */
async function assertThrows(fn: () => Promise<unknown>): Promise<Error | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

async function main(): Promise<void> {
  // Isolated store so we never touch the dev .automations-mock.json. Seeds atm_seed on first load.
  const dir = mkdtempSync(join(tmpdir(), "automations-e2e-"));
  const storePath = join(dir, "automations.json");
  const store = createFileAutomationStore(storePath);
  const fw = await createAppAutomationFramework({ store });

  // ---------------------------------------------------------------------------
  // Seed automation has TWO actions (supervisor alert + shift-lead alert). Test verifies BOTH ran.
  console.log("\n1. Happy path — seed automation matches (station S-1), both actions fire");
  const alerts: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => {
    const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    if (msg.startsWith("[automations] ALERT")) alerts.push(msg);
    else realLog(...(args as Parameters<typeof realLog>));
  };
  let r1: { eventId: string; matched: string[] };
  try {
    r1 = await fw.fire("job.changed", { previousJobId: "j_100", currentJobId: "j_200", stationId: "s_1" });
  } finally {
    console.log = realLog;
  }
  check("eventId generated", typeof r1.eventId === "string" && r1.eventId.length > 0, r1.eventId);
  check("matched = [atm_seed]", JSON.stringify(r1.matched) === '["atm_seed"]', r1.matched);
  check("both actions ran (two ALERT lines)", alerts.length === 2, alerts);
  // Recipients are stored as employee ids; the handler resolves them to display names at run time
  // (email resolution is deferred — see send-alert.ts TODO). Log lines should contain the resolved
  // name, not the raw id.
  check("supervisor alert ran first", alerts[0]?.includes("Sam Supervisor") === true, alerts[0]);
  check("shift-lead alert ran second", alerts[1]?.includes("Riley Shift-Lead") === true, alerts[1]);
  check("no raw employee ids leaked into the alert text", alerts.every((a) => !a.includes("e_supervisor") && !a.includes("e_shift_lead")), alerts);

  // ---------------------------------------------------------------------------
  console.log("\n2. Condition mismatch — valid event, nobody cares (stationId s_2)");
  const r2 = await fw.fire("job.changed", { previousJobId: "j_100", currentJobId: "j_200", stationId: "s_2" });
  check("matched = []", JSON.stringify(r2.matched) === "[]", r2.matched);

  // ---------------------------------------------------------------------------
  console.log("\n3. Invalid payload — wrong type (stationId is a number) — throws");
  const e3 = await assertThrows(() => fw.fire("job.changed", { stationId: 123 } as never));
  check("threw on invalid payload", e3 !== null);
  check("error mentions stationId", e3 !== null && /stationId/i.test(e3.message), e3?.message);

  // ---------------------------------------------------------------------------
  console.log("\n4. Unknown event type — throws");
  const e4 = await assertThrows(() => fw.fire("foo.bar", {}));
  check("threw on unknown event type", e4 !== null);
  check("error mentions unknown event type", e4 !== null && /unknown event type/i.test(e4.message), e4?.message);

  // ---------------------------------------------------------------------------
  console.log("\n5. Authoring — create a new automation, reload, it fires");
  const created = await store.upsert({
    id: store.newId(),
    workspaceId: "dev",
    label: "Alert at s_9",
    enabled: true,
    event: "job.changed",
    eventVersion: "1",
    conditions: { combinator: "and", rules: [{ field: "event.payload.stationId", operator: "=", value: "s_9" }] },
    actions: [
      { type: "sendAlert", version: "1", inputs: { text: "hit {{event.payload.stationId}}", recipientEmployeeIds: ["e_ops"] } },
    ],
  });
  check("upsert returned the automation", created.label === "Alert at s_9");
  // Before reload the engine still runs the old rule set — the new automation is invisible.
  const beforeReload = await fw.fire("job.changed", { stationId: "s_9" });
  check("does NOT fire before reload()", beforeReload.matched.length === 0, beforeReload.matched);
  // Reload rebuilds the compiled engines from the store (what rpc/automations.ts does after a write).
  fw.engine.reload();
  const afterReload = await fw.fire("job.changed", { stationId: "s_9" });
  check("fires after reload()", afterReload.matched.includes(created.id), afterReload.matched);

  // ---------------------------------------------------------------------------
  console.log("\n6. Disable — disabled automation drops out on reload");
  await store.upsert({ ...created, enabled: false });
  fw.engine.reload();
  const afterDisable = await fw.fire("job.changed", { stationId: "s_9" });
  check("disabled automation no longer matches", afterDisable.matched.length === 0, afterDisable.matched);

  // ---------------------------------------------------------------------------
  console.log("\n7. Persistence — store survives a reopen (mock file round-trip)");
  const reopened = createFileAutomationStore(storePath);
  check("seed automation persisted", reopened.get("atm_seed") !== undefined);
  check("authored automation persisted", reopened.get(created.id) !== undefined);

  // ---------------------------------------------------------------------------
  console.log("\n8. Misconfigured action — fire() throws when matched automation has no handler");
  await store.upsert({
    id: store.newId(),
    workspaceId: "dev",
    label: "Broken action",
    enabled: true,
    event: "job.changed",
    eventVersion: "1",
    conditions: { combinator: "and", rules: [{ field: "event.payload.stationId", operator: "=", value: "s_7" }] },
    actions: [{ type: "sendSms", version: "1", inputs: {} }], // no registered handler for sendSms
  });
  fw.engine.reload();
  const e8 = await assertThrows(() => fw.fire("job.changed", { stationId: "s_7" }));
  check("fire() threw", e8 !== null);
  check("error names the missing handler 'sendSms'", e8 !== null && /sendSms/.test(e8.message), e8?.message);

  // ---------------------------------------------------------------------------
  console.log("\n8b. Unknown action version — fire() throws when version pin doesn't match a registered handler");
  await store.upsert({
    id: store.newId(),
    workspaceId: "dev",
    label: "Broken version pin",
    enabled: true,
    event: "job.changed",
    eventVersion: "1",
    conditions: { combinator: "and", rules: [{ field: "event.payload.stationId", operator: "=", value: "s_99" }] },
    actions: [{ type: "sendAlert", version: "999", inputs: { text: "x", recipientEmployeeIds: ["e_ops"] } }], // v999 not registered
  });
  fw.engine.reload();
  const e8b = await assertThrows(() => fw.fire("job.changed", { stationId: "s_99" }));
  check("fire() threw on bad version", e8b !== null);
  check(
    "error names the missing version 'sendAlert@999'",
    e8b !== null && /sendAlert@999/.test(e8b.message),
    e8b?.message,
  );

  // ---------------------------------------------------------------------------
  console.log("\n9. Construction validation — missing builder for declared event type throws");
  const emptyStore: AutomationStore = {
    list: () => [],
    get: () => undefined,
    upsert: (t) => t,
    remove: () => false,
    newId: () => "x",
  };
  let threw = false;
  let errMsg = "";
  try {
    createAutomationFramework({
      eventSchemas: {
        foo: { type: "foo", displayName: "Foo", latest: "1", versions: { "1": { payload: {} } } },
        bar: { type: "bar", displayName: "Bar", latest: "1", versions: { "1": { payload: {} } } },
      },
      actionSchemas: {},
      store: emptyStore,
      contextBuilders: { foo: statelessContextBuilder }, // "bar" intentionally missing
      actions: createActionRegistry(),
    });
  } catch (err) {
    threw = true;
    errMsg = err instanceof Error ? err.message : String(err);
  }
  check("threw at construction", threw);
  check('error names the missing type "bar"', /bar/.test(errMsg), errMsg);

  // ---------------------------------------------------------------------------
  console.log("\n9b. Construction validation — `latest` pointing at non-existent version throws");
  let threwLatest = false;
  let latestMsg = "";
  try {
    createAutomationFramework({
      eventSchemas: {
        foo: { type: "foo", displayName: "Foo", latest: "99", versions: { "1": { payload: {} } } }, // "99" missing
      },
      actionSchemas: {},
      store: emptyStore,
      contextBuilders: { foo: statelessContextBuilder },
      actions: createActionRegistry(),
    });
  } catch (err) {
    threwLatest = true;
    latestMsg = err instanceof Error ? err.message : String(err);
  }
  check("threw on bad latest pointer", threwLatest);
  check('error names latest="99"', /99/.test(latestMsg), latestMsg);

  // ---------------------------------------------------------------------------
  console.log("\n10. Ref picker — listRefOptions returns the registered employees fixture");
  const options = await fw.listRefOptions("employees");
  check("got 3 employee options", options.length === 3, options.length);
  check("supervisor option has id + label", options.some((o) => o.id === "e_supervisor" && o.label === "Sam Supervisor"), options);
  check("ops option has id + label", options.some((o) => o.id === "e_ops" && o.label === "Ops Pager"), options);
  const eRef = await assertThrows(() => fw.listRefOptions("nonsense"));
  check("unknown source throws", eRef !== null && /unknown ref source/i.test(eRef.message), eRef?.message);

  // ---------------------------------------------------------------------------
  console.log("\n11. Catalog surfaces ref metadata on action input properties (at the selected version)");
  const catalog = fw.catalog("job.changed", "sendAlert");
  check("catalog reports event version", catalog.eventVersion === "1", catalog.eventVersion);
  check("catalog reports action version (latest)", catalog.actionVersion === "1", catalog.actionVersion);
  const recipientsProp = catalog.action.versions[catalog.actionVersion]?.inputSchema.properties.recipientEmployeeIds;
  check("recipientEmployeeIds has ref annotation", recipientsProp?.ref?.source === "employees", recipientsProp?.ref);
  check("recipientEmployeeIds is multi", recipientsProp?.ref?.multi === true, recipientsProp?.ref);

  // ---------------------------------------------------------------------------
  console.log("\n11b. Catalog surfaces ref metadata on EVENT payload facts (condition-side picker)");
  const stationFact = catalog.facts.find((f) => f.id === "event.payload.stationId");
  check("stationId fact exists", stationFact !== undefined, stationFact);
  check("stationId fact carries ref.source = 'stations'", stationFact?.ref?.source === "stations", stationFact?.ref);
  const jobFact = catalog.facts.find((f) => f.id === "event.payload.currentJobId");
  check("currentJobId fact carries ref.source = 'jobs'", jobFact?.ref?.source === "jobs", jobFact?.ref);
  const wcFact = catalog.facts.find((f) => f.id === "event.payload.workCenterId");
  check("workCenterId fact carries ref.source = 'workCenters'", wcFact?.ref?.source === "workCenters", wcFact?.ref);
  const deptFact = catalog.facts.find((f) => f.id === "event.payload.department");
  check("department fact has NO ref (free-text)", deptFact?.ref === undefined, deptFact?.ref);

  // ---------------------------------------------------------------------------
  console.log("\n11c. listRefOptions works for each registered source (the picker RPC)");
  const stations = await fw.listRefOptions("stations");
  check("stations source returns 3 options", stations.length === 3, stations.length);
  check("stations options have id + label", stations.every((o) => typeof o.id === "string" && typeof o.label === "string"), stations);
  const jobs = await fw.listRefOptions("jobs");
  check("jobs source returns 3 options", jobs.length === 3, jobs.length);
  const wcs = await fw.listRefOptions("workCenters");
  check("workCenters source returns 3 options", wcs.length === 3, wcs.length);

  // ---------------------------------------------------------------------------
  console.log("\n12. AppEvent carries version (latest by default)");
  const r12 = await fw.fire("job.changed", { previousJobId: "j_1", currentJobId: "j_2", stationId: "s_2" });
  check("fire returned eventId", typeof r12.eventId === "string");
  // No matched assertion needed — point is that fire didn't throw and accepted the latest-default path.
  // Validation that the version flows through is implicit: an unknown event version would have thrown.

  // ---------------------------------------------------------------------------
  console.log("\n13. fire() with explicit version respects the choice");
  const e13 = await assertThrows(() => fw.fire("job.changed", { stationId: "s_1" }, { version: "999" }));
  check("threw on explicit unknown event version", e13 !== null);
  check("error names the unknown version", e13 !== null && /999/.test(e13.message), e13?.message);

  // ---------------------------------------------------------------------------
  rmSync(dir, { recursive: true, force: true });
  console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("e2e crashed:", err);
  process.exit(1);
});
