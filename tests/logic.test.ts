/** The frontend's own deterministic logic: the trail reducer, formatting, and chart math. */
import { describe, expect, it } from "vitest";
import { buildCloud } from "@/lib/cloud";
import { count, day, month, num, pct, signedPct, usd } from "@/lib/format";
import { linear, nearest, parseHex, path, ramp, ticks } from "@/lib/scale";
import type { AnalystEvent, Frontier, ToolCall } from "@/lib/schema";
import { EMPTY_TRAIL, allCalls, applyEvent, callHeadline, callSignature } from "@/lib/session";

const call = (id: string, round: number, extra: Partial<ToolCall> = {}): ToolCall => ({
  id,
  name: "get_metric",
  input: { metric: "beta", subject: "PORTFOLIO" },
  output: { value: 1.076261 },
  isError: false,
  round,
  ...extra,
});

const fold = (events: AnalystEvent[]) => events.reduce(applyEvent, EMPTY_TRAIL);

describe("trail reducer", () => {
  it("groups notes and parallel calls under the round that produced them", () => {
    const trail = fold([
      { type: "round", round: 1 },
      { type: "note", text: "Pulling the headline numbers." },
      { type: "tool", call: call("a", 1) },
      { type: "tool", call: call("b", 1) },
      { type: "round", round: 2 },
      { type: "note", text: "Checking the worst fall." },
      { type: "tool", call: call("c", 2) },
      { type: "round", round: 3 },
    ]);
    expect(trail.rounds.map((r) => [r.round, r.notes.length, r.calls.map((c) => c.id)])).toEqual([
      [1, 1, ["a", "b"]],
      [2, 1, ["c"]],
      [3, 0, []],
    ]);
    expect(allCalls(trail).map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(trail.retried).toBe(false);
  });

  it("does not mutate the previous state", () => {
    const first = fold([{ type: "round", round: 1 }]);
    const second = applyEvent(first, { type: "tool", call: call("a", 1) });
    expect(first.rounds[0].calls).toHaveLength(0);
    expect(second.rounds[0].calls).toHaveLength(1);
  });

  it("starts over when the model is asked again after answering without tools", () => {
    const trail = fold([
      { type: "round", round: 1 },
      { type: "retry", reason: "no_tools" },
      { type: "round", round: 1 },
      { type: "tool", call: call("a", 1) },
    ]);
    expect(trail.retried).toBe(true);
    expect(trail.rounds).toHaveLength(1);
    expect(allCalls(trail)).toHaveLength(1);
  });

  it("tolerates events that arrive without their round being announced", () => {
    const trail = fold([
      { type: "note", text: "early" },
      { type: "tool", call: call("a", 2) },
    ]);
    expect(trail.rounds.map((r) => r.round)).toEqual([1, 2]);
  });
});

describe("tool call summaries", () => {
  it("writes a call the way a reader would", () => {
    expect(callSignature(call("a", 1))).toBe("get_metric(beta, PORTFOLIO)");
    expect(
      callSignature(
        call("b", 1, {
          name: "run_stress_test",
          input: { market_shock_pct: -20, sector: "Technology", sector_shock_pct: -10 },
        }),
      ),
    ).toBe("run_stress_test(-20, Technology, -10)");
  });

  it("picks the headline result per tool and nothing for a failed call", () => {
    expect(callHeadline(call("a", 1))).toEqual([{ label: "value", value: 1.076261 }]);
    expect(
      callHeadline(
        call("b", 1, {
          name: "rebalance_to_target",
          output: { before: { volatility: 0.19 }, after: { volatility: 0.17 } },
        }),
      ),
    ).toEqual([
      { label: "volatility before", value: 0.19 },
      { label: "after", value: 0.17 },
    ]);
    expect(
      callHeadline(
        call("c", 1, {
          name: "monte_carlo",
          output: { return_percentiles: { p50: 0.17 }, probability_of_loss: 0.19 },
        }),
      ),
    ).toHaveLength(2);
    expect(callHeadline(call("d", 1, { isError: true, output: "boom" }))).toEqual([]);
    expect(callHeadline(call("e", 1, { output: { sectors: [] } }))).toEqual([]);
  });
});

describe("formatting", () => {
  it("formats fractions as percentages with a real minus sign", () => {
    expect(pct(0.186872)).toBe("18.7%");
    expect(pct(-0.299714)).toBe("−30.0%");
    expect(pct(0.017038, 2)).toBe("1.70%");
    expect(pct(-0.0001)).toBe("0.0%"); // rounds to zero: no stray minus
    expect(signedPct(0.181)).toBe("+18.1%");
    expect(signedPct(-0.122, 0)).toBe("−12%");
    expect(signedPct(0)).toBe("0.0%");
  });

  it("formats ratios, money, counts, and dates", () => {
    expect(num(1.076261)).toBe("1.08");
    expect(num(-0.209669)).toBe("−0.21");
    expect(usd(4259.43)).toBe("$4,259");
    expect(usd(-63313.05)).toBe("−$63,313");
    expect(count(1260)).toBe("1,260");
    expect(day("2022-08-04")).toBe("Aug 4, 2022");
    expect(month("2021-12-10")).toBe("Dec 2021");
  });
});

describe("chart math", () => {
  it("maps a domain onto a range, including inverted ranges", () => {
    const y = linear([0, 10], [100, 0]);
    expect([y(0), y(5), y(10)]).toEqual([100, 50, 0]);
    expect(linear([3, 3], [0, 10])(3)).toBe(0); // a flat domain does not divide by zero
  });

  it("picks round tick values that cover the data", () => {
    expect(ticks(0.83, 2.34, 3)).toEqual([1, 2]); // a step of 1 is the first round one wide enough
    expect(ticks(-0.12, 0.61, 4)).toEqual([0, 0.2, 0.4, 0.6]);
    expect(ticks(-0.2997, 0, 3)).toEqual([-0.2, -0.1, 0]);
    expect(ticks(5, 5)).toEqual([5]);
  });

  it("finds the nearest value in a sorted list", () => {
    const xs = [10, 20, 30, 40];
    expect([nearest(xs, 0), nearest(xs, 24), nearest(xs, 26), nearest(xs, 99)]).toEqual([
      0, 1, 2, 3,
    ]);
  });

  it("builds paths and color ramps", () => {
    expect(
      path([
        [0, 0],
        [10, 5.25],
      ]),
    ).toBe("M0.0,0.0L10.0,5.3");
    expect(parseHex("#ffb000")).toEqual([255, 176, 0]);
    expect(parseHex("#fff")).toEqual([255, 255, 255]);
    const stops = [parseHex("#000000"), parseHex("#808080"), parseHex("#ffffff")];
    expect(ramp(stops, 0)).toEqual([0, 0, 0]);
    expect(ramp(stops, 0.5)).toEqual([128, 128, 128]);
    expect(ramp(stops, 2)).toEqual([255, 255, 255]); // clamped
  });
});

describe("frontier cloud", () => {
  const point = (
    volatility: number,
    annualReturn: number,
    sharpe: number,
    maxDrawdown: number,
  ) => ({
    volatility,
    annualReturn,
    sharpe,
    maxDrawdown,
  });
  const frontier: Frontier = {
    count: 3,
    points: [
      [0.1, 0.02, 0.1, -0.1],
      [0.2, 0.1, 0.5, -0.3],
      [0.3, 0.2, 0.9, -0.5],
    ],
    current: point(0.2, 0.1, 0.5, -0.3),
    maxSharpe: point(0.3, 0.2, 0.9, -0.5),
    minVolatility: point(0.1, 0.02, 0.1, -0.1),
  };
  const cloud = buildCloud(frontier);

  it("appends the three highlights after the simulated mixes", () => {
    expect(cloud.size).toBe(6);
    expect(cloud.highlights.map((h) => [h.key, h.index])).toEqual([
      ["current", 3],
      ["maxSharpe", 4],
      ["minVolatility", 5],
    ]);
    expect(cloud.raw(3)).toEqual([0.2, 0.1, 0.5, -0.3]);
  });

  it("scales each axis to the unit box", () => {
    expect(cloud.volatility).toEqual({ min: 0.1, max: 0.3 });
    // first mix: lowest volatility, lowest return, shallowest fall
    expect(Array.from(cloud.positions.slice(0, 3))).toEqual([-1, -1, 1]);
    // third mix: the opposite corner
    expect(Array.from(cloud.positions.slice(6, 9))).toEqual([1, 1, -1]);
    expect(Array.from(cloud.positions.slice(3, 6)).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([
      0, -0.111111, 0,
    ]);
  });

  it("shades by Sharpe between 0 and 1, clamping the extremes", () => {
    for (const value of cloud.shade) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect(cloud.shade[0]).toBe(0);
    expect(cloud.shade[2]).toBe(1);
    expect(cloud.shade[1]).toBeCloseTo(0.5, 5);
  });

  it("survives a degenerate cloud where every mix is the same", () => {
    const flat = buildCloud({
      ...frontier,
      points: [[0.2, 0.1, 0.5, -0.3]],
      count: 1,
      maxSharpe: frontier.current,
      minVolatility: frontier.current,
    });
    expect(Array.from(flat.positions).every(Number.isFinite)).toBe(true);
    expect(Array.from(flat.shade).every(Number.isFinite)).toBe(true);
  });
});
