import { describe, expect, it } from "vitest";
import type { AppEvent } from "./types.js";
import { interpolateInputs } from "./interpolate.js";

const event = (payload: Record<string, unknown>): AppEvent => ({
  id: "e1",
  type: "time.daily",
  version: "1",
  ts: "2026-09-29T10:31:00.000Z",
  payload,
  correlationId: "e1",
  hop: 0,
});

describe("interpolateInputs", () => {
  it("resolves recognized event tokens", () => {
    const out = interpolateInputs({ subject: "Site {{event.payload.siteId}}" }, { event: event({ siteId: "s1" }) });
    expect(out.subject).toBe("Site s1");
  });

  it("blanks a recognized token that resolves to nothing (absent optional field)", () => {
    const out = interpolateInputs({ subject: "Hi {{event.payload.name}}" }, { event: event({}) });
    expect(out.subject).toBe("Hi ");
  });

  it("leaves an unrecognized token intact for a downstream layer to fill", () => {
    // deck.sendLatest fills {{decks}} itself after the engine interpolates; the engine must not
    // blank it, or the required-field check would see an empty subject and reject the run.
    const out = interpolateInputs(
      { subject: "{{decks}}", body: "The latest {{decks}}:" },
      { event: event({ siteId: "s1" }) },
    );
    expect(out.subject).toBe("{{decks}}");
    expect(out.body).toBe("The latest {{decks}}:");
  });
});
