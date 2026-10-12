/**
 * Smoke test of the main path in demo mode: no key, one preset, the whole session
 * replayed through the real route handler and parsed the way the browser parses it.
 */
import { describe, expect, it, vi } from "vitest";
import { analystFixtures, analystRoute } from "@/lib/analyst-route";
import type { ApiResponse, StreamFrame } from "@/lib/api";
import { AnalystEvent, Session } from "@/lib/schema";
import { EMPTY_TRAIL, allCalls, applyEvent } from "@/lib/session";

type Frame = StreamFrame<unknown, unknown>;

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/analyst", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

async function frames(res: Response): Promise<Frame[]> {
  return (await res.text())
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice(6)) as Frame);
}

// 1000x replay speed: the pacing is for people, not for tests.
const route = () => analystRoute(1000);

describe("POST /api/analyst in demo mode", () => {
  it("replays a preset session end to end without a key or a network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const fixture = analystFixtures["risk-sources"];
    const res = await route()(post({ demoId: "risk-sources", question: "ignored in demo mode" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const received = await frames(res);
    expect(received[0]).toEqual({
      type: "meta",
      meta: { mode: "demo", placeholder: fixture.placeholder, recordedAt: fixture.recordedAt },
    });

    // Fold the events the way the panel does and check the trail it would show.
    let trail = EMPTY_TRAIL;
    for (const frame of received) {
      if (frame.type === "event") trail = applyEvent(trail, AnalystEvent.parse(frame.event));
    }
    const done = received.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type !== "done") throw new Error("unreachable");
    const session = Session.parse(done.data);
    expect(allCalls(trail)).toEqual(session.calls);
    expect(trail.rounds.map((r) => r.round)).toEqual(
      Array.from({ length: session.rounds }, (_, i) => i + 1),
    );
    if (fixture.placeholder) {
      // The samples are written to show these; a recorded run's shape is up to the model.
      expect(trail.rounds.some((r) => r.calls.length > 1)).toBe(true); // parallel tool calls
      expect(trail.rounds.some((r) => r.notes.length > 0)).toBe(true); // progress notes
      expect(session.provenance.numbers.length).toBeGreaterThan(5);
    }

    // The answer arrives with a verdict on every figure.
    expect(
      session.provenance.matched + session.provenance.fromQuestion + session.provenance.unmatched,
    ).toBe(session.provenance.numbers.length);
    expect(done.meta.mode).toBe("demo");
    expect(done.meta.placeholder).toBe(fixture.placeholder);
    expect(done.meta.costUsd).toBe(fixture.costUsd);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("serves every preset", async () => {
    for (const demoId of Object.keys(analystFixtures)) {
      const received = await frames(await route()(post({ demoId })));
      expect(received.at(-1)?.type, demoId).toBe("done");
    }
  });

  it("explains a request that has no recording", async () => {
    for (const body of [{ demoId: "not-a-preset" }, { question: "What about bonds?" }]) {
      const res = await route()(post(body));
      const json = (await res.json()) as ApiResponse<never>;
      expect(res.status).toBe(404);
      expect(json.ok === false && json.error.kind).toBe("demo_miss");
      expect(json.ok === false && json.error.message).toContain("add your Anthropic key");
    }
  });

  it("rejects malformed bodies", async () => {
    expect((await route()(post({ demoId: 42 }))).status).toBe(400);
    expect((await route()(post({ demoId: "x".repeat(65) }))).status).toBe(400);
  });

  it("never runs a live session itself: that is the risk API's job", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await route()(
      post({ demoId: "risk-sources" }, { "x-anthropic-key": "sk-ant-test-0123456789abcdef" }),
    );
    const received = await frames(res);
    const last = received.at(-1);
    expect(last?.type).toBe("error");
    expect(last?.type === "error" && last.error.message).toContain("risk engine API");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
