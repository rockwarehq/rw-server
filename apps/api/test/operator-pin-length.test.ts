import { describe, expect, it } from "vitest";
import { pinLengthOf } from "../src/rpc/operator.js";

// A plant's PIN length is JSON in site attrs: anything but a whole 4 to 8 is 4.
describe("pinLengthOf", () => {
  it("keeps a whole 4 to 8", () => {
    expect([4, 5, 6, 7, 8].map(pinLengthOf)).toEqual([4, 5, 6, 7, 8]);
  });

  it("falls back to 4 for anything else", () => {
    expect([undefined, null, 3, 9, 12, 4.5, "6", -1].map(pinLengthOf)).toEqual([4, 4, 4, 4, 4, 4, 4, 4]);
  });
});
