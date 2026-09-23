import { describe, expect, it, vi } from "vitest";
import {
  AccessDenied,
  DeviceAccess,
  emptyPerson,
  noAccess,
  type Person,
  personFromRows,
  UserAccess,
  visibleSites,
} from "./access.js";

const SITE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SITE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WC_1 = "11111111-1111-4111-8111-111111111111";
const WC_2 = "22222222-2222-4222-8222-222222222222";

const plant = (level: "VIEW" | "MANAGE" | "ADMIN", siteId = SITE_A) =>
  personFromRows([{ level, kind: "PLANT", siteId, workcenterId: null }]);
const crew = (level: "VIEW" | "MANAGE", workcenterId = WC_1) =>
  personFromRows([{ level, kind: "WORKCENTER", siteId: SITE_A, workcenterId }]);

const VIEWER = plant("VIEW");
const MEMBER = plant("MANAGE");
const ADMIN = plant("ADMIN");
const CREW = crew("MANAGE");
const ACCOUNT_ADMIN = emptyPerson({ accountAdmin: true });
const SUPPORT = emptyPerson({ staff: "SUPPORT" });
const ENGINEER = emptyPerson({ staff: "ENGINEER" });

// Row lookups: stations in WC_1, plant things at SITE_A, a site-less gateway.
const locate = vi.fn(async (kind: string, id: string) => {
  if (id === "missing") return null;
  if (kind === "station") return { siteId: SITE_A, workcenterId: id === "st-2" ? WC_2 : WC_1 };
  if (kind === "gateway") return { siteId: null };
  if (kind === "job" && id === "job-b") return { siteId: SITE_B };
  return { siteId: SITE_A };
});

const user = (person: Person, siteId: string | null = SITE_A) => new UserAccess(person, siteId, locate as never);

async function denied(p: Promise<unknown> | (() => unknown)) {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (err) {
    expect(err).toBeInstanceOf(AccessDenied);
    return err as AccessDenied;
  }
  throw new Error("expected AccessDenied");
}

describe("users: plant things", () => {
  it("viewers read, members write, admins hold the shelf above", async () => {
    await expect(user(VIEWER).require("VIEW", { site: SITE_A })).resolves.toEqual({ siteId: SITE_A });
    expect((await denied(user(VIEWER).require("MANAGE", { site: SITE_A }))).message).toBe(
      "Requires MANAGE access here",
    );
    await user(MEMBER).require("MANAGE", { job: "job-1" });
    await denied(user(MEMBER).require("ADMIN", { site: SITE_A }));
    await user(ADMIN).require("ADMIN", { site: SITE_A });
  });

  it("is site-sensitive", async () => {
    await denied(user(MEMBER).require("VIEW", { job: "job-b" }));
  });

  it("missing rows are NOT_FOUND with the kind's message", async () => {
    const err = await denied(user(ACCOUNT_ADMIN).require("VIEW", { station: "missing" }));
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe("Station not found");
  });

  it("any access at a site lets you read the plant", async () => {
    await user(CREW).require("VIEW", { site: SITE_A });
    await denied(user(CREW).require("MANAGE", { site: SITE_A }));
  });
});

describe("users: floor things", () => {
  it("plant viewers and members do not see the floor; the crew does", async () => {
    await denied(user(VIEWER).require("VIEW", { station: "st-1" }));
    await denied(user(MEMBER).require("VIEW", { station: "st-1" }));
    await user(crew("VIEW")).require("VIEW", { station: "st-1" });
  });

  it("crew MANAGE covers their own cell only", async () => {
    await user(CREW).require("MANAGE", { station: "st-1" });
    await denied(user(CREW).require("VIEW", { station: "st-2" }));
  });

  it("only plant ADMIN cascades to every cell", async () => {
    await denied(user(MEMBER).require("VIEW", { station: "st-2" }));
    await user(ADMIN).require("MANAGE", { station: "st-2" });
  });

  it("ADMIN on a floor row asks the row's plant", async () => {
    await user(ADMIN).require("ADMIN", { station: "st-2" });
    await denied(user(CREW).require("ADMIN", { station: "st-1" }));
    await denied(user(MEMBER).require("ADMIN", { station: "st-1" }));
  });

  it("a plant member with a cell reaches that cell only", async () => {
    const person = personFromRows([
      { level: "MANAGE", kind: "PLANT", siteId: SITE_A, workcenterId: null },
      { level: "MANAGE", kind: "WORKCENTER", siteId: SITE_A, workcenterId: WC_1 },
    ]);
    await user(person).require("MANAGE", { job: "job-1" });
    await user(person).require("MANAGE", { station: "st-1" });
    await denied(user(person).require("VIEW", { station: "st-2" }));
    expect(user(person).list("VIEW", undefined, "WORKCENTER")).toEqual({ siteId: SITE_A, workcenterIds: [WC_1] });
  });
});

describe("users: site-less rows, somewhere, account admin", () => {
  it("site-less rows: reads need any site, changes need the level at some plant", async () => {
    await expect(user(VIEWER).require("VIEW", { gateway: "g" })).resolves.toEqual({ siteId: null });
    await denied(user(VIEWER).require("MANAGE", { gateway: "g" }));
    await user(MEMBER).require("MANAGE", { gateway: "g" });
    await denied(user(emptyPerson()).require("VIEW", { gateway: "g" }));
  });

  it("requireSomewhere", async () => {
    expect((await denied(() => user(emptyPerson()).requireSomewhere("VIEW"))).message).toBe("No site access");
    user(CREW).requireSomewhere("VIEW");
    expect((await denied(() => user(CREW).requireSomewhere("MANAGE"))).message).toBe(
      "Requires MANAGE access at some plant",
    );
    user(plant("ADMIN", SITE_B)).requireSomewhere("ADMIN");
  });

  it("requireAccountAdmin: account admins, and ENGINEER staff unless excluded", async () => {
    user(ACCOUNT_ADMIN).requireAccountAdmin();
    user(ENGINEER).requireAccountAdmin();
    await denied(() => user(ENGINEER).requireAccountAdmin({ allowStaff: false }));
    expect((await denied(() => user(ADMIN).requireAccountAdmin())).message).toBe("Reserved for account admins");
    await denied(() => user(SUPPORT).requireAccountAdmin());
  });

  it("staff: SUPPORT reads everywhere and writes nowhere; ENGINEER does both", async () => {
    await user(SUPPORT).require("VIEW", { station: "st-2" });
    await denied(user(SUPPORT).require("MANAGE", { site: SITE_A }));
    await user(ENGINEER).require("ADMIN", { site: SITE_B });
  });

  it("can() answers without throwing", () => {
    expect(user(MEMBER).can("MANAGE", { site: SITE_A })).toBe(true);
    expect(user(VIEWER).can("MANAGE", { site: SITE_A })).toBe(false);
    expect(user(ACCOUNT_ADMIN).can("ADMIN", { site: SITE_B })).toBe(true);
  });
});

describe("users: lists", () => {
  it("PLANT lists need the level on the plant", async () => {
    expect(user(VIEWER).list("VIEW")).toEqual({ siteId: SITE_A });
    expect(user(CREW).list("VIEW")).toEqual({ siteId: SITE_A });
    await denied(() => user(VIEWER).list("MANAGE"));
  });

  it("WORKCENTER lists: crew narrow to their cells, admins see the floor", async () => {
    expect(user(CREW).list("VIEW", undefined, "WORKCENTER")).toEqual({ siteId: SITE_A, workcenterIds: [WC_1] });
    expect(user(ADMIN).list("VIEW", undefined, "WORKCENTER")).toEqual({ siteId: SITE_A });
    await denied(() => user(MEMBER).list("VIEW", undefined, "WORKCENTER"));
    await denied(() => user(VIEWER).list("VIEW", undefined, "WORKCENTER"));
  });

  it("needs a site context and honors an explicit site", async () => {
    const err = await denied(() => user(VIEWER, null).list("VIEW"));
    expect(err.code).toBe("NO_WORKSPACE");
    await denied(() => user(VIEWER).list("VIEW", SITE_B));
    expect(user(ACCOUNT_ADMIN, null).list("VIEW", SITE_B)).toEqual({ siteId: SITE_B });
  });

  it("visible sites: membership for people, all for account admins and staff", () => {
    expect(visibleSites(CREW)).toEqual([SITE_A]);
    expect(visibleSites(ACCOUNT_ADMIN)).toBe("all");
    expect(visibleSites(SUPPORT)).toBe("all");
  });
});

describe("devices", () => {
  const display = new DeviceAccess("display", SITE_A, locate as never);
  const app = new DeviceAccess("app", SITE_A, locate as never);

  it("displays: any level at their own site (unchanged rule)", async () => {
    await display.require("MANAGE", { station: "st-2" });
    await display.require("MANAGE", { site: SITE_A });
    expect((await denied(display.require("VIEW", { job: "job-b" }))).message).toBe(
      "Display can only access resources in its site",
    );
  });

  it("API tokens: read-only at their own site", async () => {
    await app.require("VIEW", { station: "st-1" });
    await denied(app.require("MANAGE", { station: "st-1" }));
    expect((await denied(app.require("VIEW", { job: "job-b" }))).message).toBe("Token not authorized for this site");
  });

  it("devices are denied site-less rows, somewhere and account-admin checks", async () => {
    expect((await denied(display.require("VIEW", { gateway: "g" }))).message).toBe(
      "This action requires a user account",
    );
    await denied(() => display.requireSomewhere());
    expect((await denied(() => app.requireAccountAdmin())).message).toBe(
      "Workspace-level actions require a user account",
    );
  });

  it("devices list within their own site only", async () => {
    expect(display.list("VIEW", undefined, "WORKCENTER")).toEqual({ siteId: SITE_A });
    await denied(() => display.list("VIEW", SITE_B));
    expect(display.sites()).toEqual([SITE_A]);
  });
});

describe("no credentials", () => {
  it("every check is UNAUTHENTICATED", async () => {
    expect((await denied(noAccess.require("VIEW", { site: SITE_A }))).code).toBe("UNAUTHENTICATED");
    expect(noAccess.can("VIEW", { site: SITE_A })).toBe(false);
  });
});

describe("types", () => {
  it("require() proves a site for kinds that always have one", async () => {
    const a = user(ACCOUNT_ADMIN);
    const job = await a.require("VIEW", { job: "job-1" });
    const gw = await a.require("VIEW", { gateway: "g" });
    const site: string = job.siteId;
    // @ts-expect-error site-less kinds may resolve to no site
    const gwSite: string = gw.siteId;
    expect([site, gwSite]).toBeDefined();
  });
});
