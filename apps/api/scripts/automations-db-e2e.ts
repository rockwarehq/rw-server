/**
 * End-to-end smoke test for the automation framework against the REAL DATABASE.
 *
 * Sets up a recognizable test workspace + employee (idempotent — re-running just appends new
 * runs), builds a DB-backed framework, creates one automation, fires events, then prints every
 * audit row it wrote (`Automation`, `AutomationRun`, `AutomationRunMatch`, `AutomationActionRun`).
 *
 * Run: `pnpm --filter @rw/api exec tsx scripts/automations-db-e2e.ts`
 */
import "dotenv/config";
import prisma from "@rw/db";
import { createAppAutomationFramework } from "../src/automations/index.js";

const WORKSPACE_NAME = "Automation E2E";
const WORKSPACE_SLUG = "automation-e2e";
// Stable test ids so re-runs update rather than insert duplicates. Real automation ids are
// `atm_<nanoid>` from `fw.store.newId()`; we hardcode here for idempotency.
const TEST_AUTOMATION_ID = "11111111-1111-1111-1111-111111111111";
const TEST_EMPLOYEE_ID = "22222222-2222-2222-2222-222222222222";

async function main(): Promise<void> {
  console.log("─── 1. Seed workspace + employee (with current version) ─────────────");

  const workspace = await prisma.workspace.upsert({
    where: { slug: WORKSPACE_SLUG },
    create: { name: WORKSPACE_NAME, slug: WORKSPACE_SLUG },
    update: {},
  });
  console.log(`  workspace:  ${workspace.name} (id=${workspace.id})`);

  // Employee + current version. Chicken-and-egg: Employee.versionId FK → EmployeeVersion, and
  // EmployeeVersion.employeeId FK → Employee. Create Employee first (no version), then the
  // version, then point Employee.versionId at it.
  const employee = await prisma.employee.upsert({
    where: { id: TEST_EMPLOYEE_ID },
    create: { id: TEST_EMPLOYEE_ID, workspaceId: workspace.id, status: "ACTIVE" },
    update: {},
  });
  let employeeVersion = await prisma.employeeVersion.findFirst({ where: { employeeId: employee.id } });
  if (!employeeVersion) {
    employeeVersion = await prisma.employeeVersion.create({
      data: { employeeId: employee.id, version: 1, firstName: "Test", lastName: "Recipient" },
    });
    await prisma.employee.update({ where: { id: employee.id }, data: { versionId: employeeVersion.id } });
  }
  console.log(`  employee:   ${employeeVersion.firstName} ${employeeVersion.lastName} (id=${employee.id})`);

  console.log("\n─── 2. Build DB-backed automation framework ──────────────────────────");

  const fw = await createAppAutomationFramework({ workspaceId: workspace.id });
  const before = fw.store.list();
  console.log(`  framework built; loaded ${before.length} existing automation(s) for this workspace`);

  console.log("\n─── 3. Create automation and persist to Postgres ─────────────────────");

  const automation = await fw.store.upsert({
    id: TEST_AUTOMATION_ID,
    workspaceId: workspace.id,
    label: "DB E2E: Alert when job changes at S-1",
    enabled: true,
    event: "job.changed",
    eventVersion: "1",
    conditions: {
      combinator: "and",
      // stationId is a picker-typed payload field; condition value is a station id.
      rules: [{ field: "event.payload.stationId", operator: "=", value: "s_1" }],
    },
    actions: [
      {
        type: "sendAlert",
        version: "1",
        inputs: {
          text: "Job changed at {{event.payload.stationId}}: {{event.payload.previousJobId}} → {{event.payload.currentJobId}}",
          recipientEmployeeIds: [employee.id],
        },
      },
    ],
  });
  console.log(`  automation: "${automation.label}" (id=${automation.id})`);
  console.log(`    event=${automation.event}@${automation.eventVersion} actions=${automation.actions.length} recipients=[${employeeVersion.firstName} ${employeeVersion.lastName}]`);

  // Rebuild the compiled engines so the new automation is visible to dispatch
  // (the RPC layer does this after every write; here we do it manually).
  fw.engine.reload();

  console.log("\n─── 4. Fire events — 1 matches, 1 doesn't ───────────────────────────");

  const r1 = await fw.fire("job.changed", { previousJobId: "j_100", currentJobId: "j_200", stationId: "s_1" });
  console.log(`  fire #1 stationId=s_1 → eventId=${r1.eventId} matched=${JSON.stringify(r1.matched)}`);

  const r2 = await fw.fire("job.changed", { previousJobId: "j_300", currentJobId: "j_400", stationId: "s_2" });
  console.log(`  fire #2 stationId=s_2 → eventId=${r2.eventId} matched=${JSON.stringify(r2.matched)}`);

  console.log("\n─── 5. Inspect audit rows in Postgres ───────────────────────────────");

  const automations = await prisma.automation.findMany();
  console.log(`  Automation rows: ${automations.length}`);
  for (const a of automations) {
    console.log(`    • ${a.label} (${a.id})`);
  }

  const runs = await prisma.automationRun.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { firedAt: "asc" },
    include: {
      matches: { orderBy: { matchIdx: "asc" } },
      actionRuns: { orderBy: { actionIdx: "asc" } },
    },
  });
  console.log(`\n  AutomationRun rows in this workspace: ${runs.length}`);
  for (const run of runs) {
    const ts = run.firedAt.toISOString();
    const matchedIds = run.matches.map((m) => m.automationId);
    console.log(`    • [${ts}] event=${run.eventType}@${run.eventVersion} (id=${run.eventId})`);
    console.log(`         status=${run.status}${run.error ? ` error="${run.error}"` : ""} matched=${JSON.stringify(matchedIds)} actionRuns=${run.actionRuns.length}`);
    for (const m of run.matches) {
      console.log(`         match #${m.matchIdx}: ${m.automationId}`);
    }
    for (const ar of run.actionRuns) {
      const errPart = ar.error ? ` error="${ar.error}"` : "";
      console.log(`         action #${ar.actionIdx} (${ar.automationId}): ${ar.actionType}@${ar.actionVersion} status=${ar.status}${errPart}`);
    }
  }

  await prisma.$disconnect();
  console.log("\n✅ Done. The test workspace/employee and audit rows are left in place for inspection.");
  console.log(`   To clean up later:`);
  console.log(`     DELETE FROM "Workspace" WHERE slug = '${WORKSPACE_SLUG}';`);
}

main().catch(async (err) => {
  console.error("DB e2e crashed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
