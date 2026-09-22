import { describe, expect, it, vi } from "vitest";
vi.mock("@rw/db", () => ({ default: {} }));
import { isCommentAuthor } from "./shift-comment.js";
import type { ActionActor } from "../../employee/actor-role.js";

const terminal: ActionActor = {
  displayId: "display",
  employeeId: null,
  employeeVersionId: null,
  assurance: "TERMINAL",
};
const person = (assurance: ActionActor["assurance"], displayId = "display"): ActionActor => ({
  displayId,
  employeeId: "employee",
  employeeVersionId: "version",
  assurance,
});

describe("immutable comment ownership", () => {
  it("requires the recorded display author, never an arbitrary null legacy author", () => {
    expect(isCommentAuthor({ authorKind: "DISPLAY", authorId: "display" }, terminal)).toBe(true);
    expect(isCommentAuthor({ authorKind: "DISPLAY", authorId: "other" }, terminal)).toBe(false);
    expect(isCommentAuthor({ authorKind: "UNKNOWN", authorId: null }, terminal)).toBe(false);
  });
  it("provenance alone does not authorize a person-owned comment edit", () => {
    expect(isCommentAuthor({ authorKind: "EMPLOYEE", authorId: "employee" }, terminal)).toBe(false);
    expect(isCommentAuthor({ authorKind: "USER", authorId: "user" }, terminal)).toBe(false);
  });
  it("employee ownership follows an identified person without introducing a PIN requirement", () => {
    const comment = { authorKind: "EMPLOYEE", authorId: "employee" };
    expect(isCommentAuthor(comment, person("VERIFIED", "other-display"))).toBe(true);
    expect(isCommentAuthor(comment, person("IDENTIFIED"))).toBe(true);
    expect(isCommentAuthor(comment, { ...person("VERIFIED"), employeeId: "other" })).toBe(false);
  });
  it("account authorship uses the real user and linked employee can edit employee-authored comments", () => {
    const actor = { ...person("ACCOUNT"), userId: "user" };
    expect(isCommentAuthor({ authorKind: "USER", authorId: "user" }, actor)).toBe(true);
    expect(isCommentAuthor({ authorKind: "USER", authorId: "other-user" }, actor)).toBe(false);
    expect(isCommentAuthor({ authorKind: "EMPLOYEE", authorId: "employee" }, actor)).toBe(true);
  });
  it("a captured USER employee link supports identified terminal edits, without granting legacy comments to current links", () => {
    const comment = { authorKind: "USER", authorId: "user", authorEmployeeId: "employee" };
    expect(isCommentAuthor(comment, person("VERIFIED", "other-display"))).toBe(true);
    expect(isCommentAuthor(comment, person("IDENTIFIED"))).toBe(true);
    expect(isCommentAuthor(comment, terminal)).toBe(false);
    expect(isCommentAuthor(comment, { ...person("VERIFIED"), employeeId: "other-employee" })).toBe(false);
    expect(isCommentAuthor({ authorKind: "USER", authorId: "user" }, person("VERIFIED"))).toBe(false);
  });
  it("identifying an employee does not remove the terminal's ownership of terminal-only comments", () => {
    expect(isCommentAuthor({ authorKind: "DISPLAY", authorId: "display" }, person("IDENTIFIED"))).toBe(true);
    expect(isCommentAuthor({ authorKind: "DISPLAY", authorId: "display" }, person("IDENTIFIED", "other-display"))).toBe(
      false,
    );
  });
});
