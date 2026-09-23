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

const plant = (tier: "VIEW" | "MANAGE" | "ADMIN", siteId = SITE_A) =>
  personFromRows([{ tier, kind: "PLANT", siteId, workcenterId: null }]);
const crew = (tier: "VIEW" | "MANAGE", workcenterId = WC_1) =>
  personFromRows([{ tier, kind: "WORKCENTER", siteId: SITE_A, workcenterId }]);

const MEMBER = plant("VIEW");
const MANAGER = plant("MANAGE");
const ADMIN = plant("ADMIN");
const CREW = crew("MANAGE");
const OWNER = emptyPerson({ owner: true });
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
  it("members read, managers write, admins hold the shelf above", async () => {
    await expect(user(MEMBER).require("VIEW", { site: SITE_A })).resolves.toEqual({ siteId: SITE_A });
    expect((await denied(user(MEMBER).require("MANAGE", { site: SITE_A }))).message).toBe(
      "Requires MANAGE access here",
    );
    await user(MANAGER).require("MANAGE", { job: "job-1" });
    await denied(user(MANAGER).require("ADMIN", { site: SITE_A }));
    await user(ADMIN).require("ADMIN", { site: SITE_A });
  });

  it("is site-sensitive", async () => {
    await denied(user(MANAGER).require("VIEW", { job: "job-b" }));
  });

  it("missing rows are NOT_FOUND with the kind's message", async () => {
    const err = await denied(user(OWNER).require("VIEW", { station: "missing" }));
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe("Station not found");
  });

  it("any access at a site makes you a plant member", async () => {
    await user(CREW).require("VIEW", { site: SITE_A });
    await denied(user(CREW).require("MANAGE", { site: SITE_A }));
  });
});

describe("users: floor things", () => {
  it("plant members do not see the floor; the crew does", async () => {
    await denied(user(MEMBER).require("VIEW", { station: "st-1" }));
    await user(crew("VIEW")).require("VIEW", { station: "st-1" });
  });

  it("crew MANAGE covers their own cell only", async () => {
    await user(CREW).require("MANAGE", { station: "st-1" });
    await denied(user(CREW).require("VIEW", { station: "st-2" }));
  });

  it("plant MANAGE cascades to every cell", async () => {
    await user(MANAGER).require("MANAGE", { station: "st-2" });
    await user(ADMIN).require("MANAGE", { station: "st-2" });
  });
});

describe("users: site-less rows, somewhere, owner", () => {
  it("site-less rows: reads need any site, changes need the tier at some plant", async () => {
    await expect(user(MEMBER).require("VIEW", { gateway: "g" })).resolves.toEqual({ siteId: null });
    await denied(user(MEMBER).require("MANAGE", { gateway: "g" }));
    await user(MANAGER).require("MANAGE", { gateway: "g" });
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

  it("requireOwner: owners, and ENGINEER staff unless excluded", async () => {
    user(OWNER).requireOwner();
    user(ENGINEER).requireOwner();
    await denied(() => user(ENGINEER).requireOwner({ allowStaff: false }));
    expect((await denied(() => user(ADMIN).requireOwner())).message).toBe("Reserved for the workspace owner");
    await denied(() => user(SUPPORT).requireOwner());
  });

  it("staff: SUPPORT reads everywhere and writes nowhere; ENGINEER does both", async () => {
    await user(SUPPORT).require("VIEW", { station: "st-2" });
    await denied(user(SUPPORT).require("MANAGE", { site: SITE_A }));
    await user(ENGINEER).require("ADMIN", { site: SITE_B });
  });

  it("can() answers without throwing", () => {
    expect(user(MANAGER).can("MANAGE", { site: SITE_A })).toBe(true);
    expect(user(MEMBER).can("MANAGE", { site: SITE_A })).toBe(false);
    expect(user(OWNER).can("ADMIN", { site: SITE_B })).toBe(true);
  });
});

describe("users: lists", () => {
  it("PLANT lists need the tier on the plant", async () => {
    expect(user(MEMBER).list("VIEW")).toEqual({ siteId: SITE_A });
    expect(user(CREW).list("VIEW")).toEqual({ siteId: SITE_A });
    await denied(() => user(MEMBER).list("MANAGE"));
  });

  it("WORKCENTER lists: crew narrow to their cells, managers see the floor", async () => {
    expect(user(CREW).list("VIEW", undefined, "WORKCENTER")).toEqual({ siteId: SITE_A, workcenterIds: [WC_1] });
    expect(user(MANAGER).list("VIEW", undefined, "WORKCENTER")).toEqual({ siteId: SITE_A });
    await denied(() => user(MEMBER).list("VIEW", undefined, "WORKCENTER"));
  });

  it("needs a site context and honors an explicit site", async () => {
    const err = await denied(() => user(MEMBER, null).list("VIEW"));
    expect(err.code).toBe("NO_WORKSPACE");
    await denied(() => user(MEMBER).list("VIEW", SITE_B));
    expect(user(OWNER, null).list("VIEW", SITE_B)).toEqual({ siteId: SITE_B });
  });

  it("visible sites: membership for people, all for owners and staff", () => {
    expect(visibleSites(CREW)).toEqual([SITE_A]);
    expect(visibleSites(OWNER)).toBe("all");
    expect(visibleSites(SUPPORT)).toBe("all");
  });
});

describe("devices", () => {
  const display = new DeviceAccess("display", SITE_A, locate as never);
  const app = new DeviceAccess("app", SITE_A, locate as never);

  it("displays: any tier at their own site (unchanged rule)", async () => {
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

  it("devices are denied site-less rows, somewhere and owner checks", async () => {
    expect((await denied(display.require("VIEW", { gateway: "g" }))).message).toBe(
      "This action requires a user account",
    );
    await denied(() => display.requireSomewhere());
    expect((await denied(() => app.requireOwner())).message).toBe("Workspace-level actions require a user account");
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
    const a = user(OWNER);
    const job = await a.require("VIEW", { job: "job-1" });
    const gw = await a.require("VIEW", { gateway: "g" });
    const site: string = job.siteId;
    // @ts-expect-error site-less kinds may resolve to no site
    const gwSite: string = gw.siteId;
    expect([site, gwSite]).toBeDefined();
  });
});
