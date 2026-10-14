/** The plain-English status line shown while a session plays, and once it is checked. */
import { describe, expect, it } from "vitest";
import { analystFixtures } from "@/lib/analyst-route";
import { narrate, type NarrationInput } from "@/lib/narration";
import { AnalystEvent, Session, type ToolCall } from "@/lib/schema";
import { EMPTY_TRAIL, applyEvent, type Trail } from "@/lib/session";

const call = (id: string, round: number): ToolCall => ({
  id,
  name: "get_metric",
  input: { metric: "beta", subject: "PORTFOLIO" },
  output: { value: 1.076261 },
  isError: false,
  round,
});

const fold = (events: AnalystEvent[]): Trail => events.reduce(applyEvent, EMPTY_TRAIL);

const running = (trail: Trail, live = false): NarrationInput => ({
  status: "running",
  trail,
  session: null,
  live,
});

const fixture = analystFixtures["risk-sources"];
const session = Session.parse(fixture?.data);

describe("narration", () => {
  it("says nothing before a run, or when the panel already shows an error or a stop", () => {
    for (const status of ["idle", "error", "stopped"] as const) {
      expect(narrate({ status, trail: EMPTY_TRAIL, session: null, live: false })).toBeNull();
    }
  });

  it("names the source before the first event arrives", () => {
    expect(narrate(running(EMPTY_TRAIL))).toBe("Starting the sample session…");
    expect(narrate(running(EMPTY_TRAIL, true))).toBe("Sending the question to Claude…");
    expect(narrate(running({ rounds: [], retried: true }))).toMatch(/used no tools/);
  });

  it("follows the rounds: planning, asking, then reading what came back", () => {
    const planning = fold([{ type: "round", round: 1 }]);
    expect(narrate(running(planning))).toMatch(
      /^The analyst reads the question .* no numbers yet\.$/,
    );

    const asking = fold([
      { type: "round", round: 1 },
      { type: "tool", call: call("a", 1) },
      { type: "tool", call: call("b", 1) },
    ]);
    expect(narrate(running(asking))).toBe(
      "The analyst asks the risk engine for 2 calculations at once. Code runs each one.",
    );

    const reading = fold([
      { type: "round", round: 1 },
      { type: "tool", call: call("a", 1) },
      { type: "tool", call: call("b", 1) },
      { type: "round", round: 2 },
    ]);
    expect(narrate(running(reading))).toMatch(/^Code returned 2 results\. The analyst reads them/);

    const more = fold([
      { type: "round", round: 1 },
      { type: "tool", call: call("a", 1) },
      { type: "tool", call: call("b", 1) },
      { type: "round", round: 2 },
      { type: "tool", call: call("c", 2) },
    ]);
    expect(narrate(running(more))).toBe(
      "The analyst asks for 1 more calculation. Code runs each one.",
    );

    const again = fold([
      { type: "round", round: 1 },
      { type: "tool", call: call("a", 1) },
      { type: "tool", call: call("b", 1) },
      { type: "round", round: 2 },
      { type: "tool", call: call("c", 2) },
      { type: "round", round: 3 },
    ]);
    expect(narrate(running(again))).toMatch(/^Code returned 1 result \(3 in all\)\./);
  });

  it("narrates a bundled session the same way the panel replays it", () => {
    const events = (fixture?.events ?? []).map((frame) => AnalystEvent.parse(frame.event));
    const trail = fold(events);
    const total = session.calls.length;
    expect(trail.rounds.flatMap((round) => round.calls)).toHaveLength(total);
    // The last round writes the answer, so the line reports everything that came back.
    expect(narrate(running(trail))).toMatch(new RegExp(`\\(${total} in all\\)`));
  });

  it("reports the checker's verdict when the session is done", () => {
    const done = narrate({ status: "done", trail: EMPTY_TRAIL, session, live: false });
    const { numbers, unmatched, fromQuestion } = session.provenance;
    if (unmatched === 0 && fromQuestion === 0) {
      expect(done).toBe(
        `Done. Code checked all ${numbers.length} numbers in the answer, and every one traces back to the risk engine's ${session.calls.length} calculations.`,
      );
    } else {
      expect(done).toMatch(/^Done\. Code checked the \d+ numbers/);
    }

    const noTools = narrate({
      status: "done",
      trail: EMPTY_TRAIL,
      session: { ...session, usedTools: false },
      live: false,
    });
    expect(noTools).toMatch(/used no tools/);

    const restated = narrate({
      status: "done",
      trail: EMPTY_TRAIL,
      session,
      shown: { ...session.provenance, matched: 10, fromQuestion: 2, unmatched: 0 },
      live: false,
    });
    expect(restated).toMatch(
      /: 10 trace back to the risk engine's \d+ calculations, and 2 restate the question\.$/,
    );
  });

  it("follows the verdict on screen, so the altered-figure test is narrated as flagged", () => {
    const altered = session.selfTest;
    expect(altered).toBeTruthy();
    const { numbers, unmatched } = altered!.provenance;
    expect(unmatched).toBeGreaterThan(0);
    const flagged = narrate({
      status: "done",
      trail: EMPTY_TRAIL,
      session,
      shown: altered!.provenance,
      live: false,
    });
    expect(flagged).toBe(
      `Done. Code checked the ${numbers.length} numbers in the answer: ${unmatched} ${unmatched === 1 ? "does" : "do"} not trace back to the risk engine and ${unmatched === 1 ? "is" : "are"} flagged in red.`,
    );
  });
});
