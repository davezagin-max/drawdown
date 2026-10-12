/**
 * Every bundled fixture is checked against the schemas the UI parses with, and every
 * provenance chip is followed back to the tool output it claims to come from.
 *
 * The Python tests (server/tests/test_fixtures.py) prove the fixtures are what the risk
 * engine and the checker produce. These prove the frontend can render them, and that
 * the two copies of the data agree. Assertions compare against each fixture's own
 * `placeholder` flag, so they keep passing once real runs are recorded.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import analystStore from "@/fixtures/analyst.json";
import frontierJson from "@/fixtures/frontier.json";
import presetsJson from "@/fixtures/presets.json";
import sampleJson from "@/fixtures/sample.json";
import { analystFixtures, analystPlaceholder } from "@/lib/analyst-route";
import {
  AnalystEvent,
  Frontier,
  Preset,
  SampleBundle,
  Session,
  type Provenance,
} from "@/lib/schema";

/** Follows "positions[0].risk_share" into a tool output. */
function resolve(output: unknown, path: string): unknown {
  return path
    .split(".")
    .flatMap((part) => {
      const match = /^([^[]+)((?:\[\d+\])*)$/.exec(part);
      if (!match) return [part];
      return [match[1], ...[...match[2].matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]))];
    })
    .reduce<unknown>(
      (node, key) =>
        node !== null && typeof node === "object"
          ? (node as Record<string | number, unknown>)[key]
          : undefined,
      output,
    );
}

function expectChipsToResolve(provenance: Provenance, session: Session, answer: string) {
  expect(provenance.segments.map((s) => s.text).join("")).toBe(answer);
  const marked = provenance.segments.filter((s) => s.number != null);
  expect(marked.map((s) => s.number)).toEqual(provenance.numbers.map((_, i) => i));
  for (const segment of marked) {
    expect(segment.text).toBe(provenance.numbers[segment.number as number].text);
  }
  const count = (status: string) => provenance.numbers.filter((n) => n.status === status).length;
  expect(provenance.matched).toBe(count("matched"));
  expect(provenance.fromQuestion).toBe(count("question"));
  expect(provenance.unmatched).toBe(count("unmatched"));

  for (const number of provenance.numbers) {
    if (number.status !== "matched") {
      expect(number.callId).toBeNull();
      continue;
    }
    const call = session.calls.find((c) => c.id === number.callId);
    expect(call, `${number.text} points at a call that exists`).toBeDefined();
    expect(call?.isError).toBe(false);
    expect(call?.name).toBe(number.tool);
    // The chip's "source value" really is what sits at that path in that tool output.
    expect(resolve(call?.output, number.path as string)).toBe(number.sourceValue);
  }
}

const entries = Object.entries(analystStore);

describe("analyst fixtures", () => {
  it("has one fixture per preset, and presets.json lists them all for recording", () => {
    const presets = Preset.array().parse(presetsJson);
    expect(presets.map((p) => p.body.demoId).sort()).toEqual(Object.keys(analystStore).sort());
    expect(presets.length).toBeGreaterThanOrEqual(3);
    for (const preset of presets) {
      expect(analystFixtures[preset.body.demoId].data.question).toBe(preset.body.question);
    }
  });

  it.each(entries)("%s parses, and every chip resolves to its tool output", (_id, fixture) => {
    const session = Session.parse(fixture.data);
    expectChipsToResolve(session.provenance, session, session.answer);
    if (session.selfTest) {
      expectChipsToResolve(session.selfTest.provenance, session, session.selfTest.answer);
      // The self-test is the same answer with exactly one figure altered and flagged.
      expect(session.selfTest.answer).not.toBe(session.answer);
      expect(session.selfTest.provenance.unmatched).toBe(session.provenance.unmatched + 1);
      expect(session.selfTest.answer).toBe(
        session.answer.replace(session.selfTest.original, session.selfTest.altered),
      );
    }
  });

  it.each(entries)("%s streams well-formed events that agree with the session", (_id, fixture) => {
    const session = Session.parse(fixture.data);
    const events = fixture.events.map((entry) => AnalystEvent.parse(entry.event));
    const offsets = fixture.events.map((entry) => entry.at);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    const streamed = events.flatMap((event) => (event.type === "tool" ? [event.call] : []));
    expect(streamed).toEqual(session.calls);
    expect(events[0]).toEqual({ type: "round", round: 1 });
  });

  it.each(entries)("%s is labelled honestly", (_id, fixture) => {
    const session = Session.parse(fixture.data);
    if (fixture.placeholder) {
      expect(fixture.recordedAt).toBeNull();
      expect(fixture.costUsd).toBe(0);
      expect(Object.values(fixture.usage).every((tokens) => tokens === 0)).toBe(true);
      // A hand-written narration has no excuse for an unverified figure.
      expect(session.provenance.unmatched).toBe(0);
      expect(session.usedTools).toBe(true);
    } else {
      expect(fixture.recordedAt).not.toBeNull();
      expect(fixture.costUsd).toBeGreaterThan(0);
    }
  });

  it("derives the page-wide placeholder flag from the fixtures themselves", () => {
    expect(analystPlaceholder).toBe(entries.some(([, fixture]) => fixture.placeholder));
  });

  it("is identical to the copy the Python API replays", () => {
    for (const name of ["analyst.json", "presets.json"]) {
      expect(readFileSync(`fixtures/${name}`, "utf8")).toBe(
        readFileSync(`server/fixtures/${name}`, "utf8"),
      );
    }
  });
});

describe("bundled analysis", () => {
  const sample = SampleBundle.parse(sampleJson);
  const frontier = Frontier.parse(frontierJson);
  const { analysis } = sample;

  it("is marked as simulated data", () => {
    expect(analysis.dataset.synthetic).toBe(true);
    expect(analysis.dataset.source).toBe("synthetic");
  });

  it("is internally consistent", () => {
    const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
    expect(sum(analysis.holdings.map((h) => h.weight))).toBeCloseTo(1, 6);
    expect(sum(analysis.sectors.map((s) => s.weight))).toBeCloseTo(1, 6);
    expect(sum(analysis.holdings.map((h) => h.riskShare))).toBeCloseTo(1, 4);
    expect(sum(analysis.holdings.map((h) => h.value))).toBeCloseTo(analysis.totalValue, 0);
    const { series, metrics, correlation } = analysis;
    expect(series.portfolio).toHaveLength(series.dates.length);
    expect(series.underwater).toHaveLength(series.dates.length);
    expect(Math.min(...series.underwater)).toBeCloseTo(metrics.maxDrawdown.depth, 3);
    expect(series.dates).toContain(metrics.maxDrawdown.peakDate);
    expect(series.dates).toContain(metrics.maxDrawdown.troughDate);
    expect(correlation.matrix).toHaveLength(correlation.tickers.length);
    correlation.matrix.forEach((row, i) => {
      expect(row[i]).toBe(1);
      row.forEach((value, j) => expect(value).toBe(correlation.matrix[j][i]));
    });
    expect(metrics.cvar95).toBeGreaterThanOrEqual(metrics.var95);
    expect(metrics.var99).toBeGreaterThanOrEqual(metrics.var95);
  });

  it("agrees with the tool outputs in the analyst sessions", () => {
    // The dashboard tile and the analyst's tool call are two routes to the same engine.
    const session = Session.parse(analystFixtures["risk-sources"].data);
    const output = (metric: string, subject: string) =>
      session.calls.find((c) => c.input.metric === metric && c.input.subject === subject)
        ?.output as { value: number } | undefined;
    if (output("volatility", "PORTFOLIO")) {
      expect(output("volatility", "PORTFOLIO")?.value).toBeCloseTo(analysis.metrics.volatility, 6);
    }
    if (output("beta", "PORTFOLIO")) {
      expect(output("beta", "PORTFOLIO")?.value).toBeCloseTo(analysis.metrics.beta, 6);
    }
  });

  it("places the current portfolio on the frontier where the headline numbers say", () => {
    expect(frontier.points).toHaveLength(frontier.count);
    expect(frontier.current.volatility).toBeCloseTo(analysis.metrics.volatility, 3);
    expect(frontier.current.annualReturn).toBeCloseTo(analysis.metrics.annualReturn, 3);
    expect(frontier.current.sharpe).toBeCloseTo(analysis.metrics.sharpe, 3);
    expect(frontier.current.maxDrawdown).toBeCloseTo(analysis.metrics.maxDrawdown.depth, 3);
    const sharpes = frontier.points.map((p) => p[2]);
    expect(frontier.maxSharpe.sharpe).toBe(Math.max(...sharpes));
    expect(frontier.minVolatility.volatility).toBe(Math.min(...frontier.points.map((p) => p[0])));
  });
});
