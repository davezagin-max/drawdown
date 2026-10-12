/**
 * Shapes of everything the risk engine sends: the analysis bundle, the frontier
 * cloud, and an analyst session. The Python side defines them (server/app/schema.py
 * and server/app/portfolio.py); these zod schemas validate them again on arrival,
 * because the API is a separate service and the bundled JSON is generated.
 */
import { z } from "zod";

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const Holding = z.object({
  ticker: z.string(),
  name: z.string(),
  sector: z.string(),
  weight: z.number(),
  value: z.number(),
  annualReturn: z.number(),
  volatility: z.number(),
  beta: z.number(),
  maxDrawdown: z.number(),
  riskShare: z.number(),
});
export type Holding = z.infer<typeof Holding>;

const Percentiles = z.object({
  p5: z.number(),
  p25: z.number(),
  p50: z.number(),
  p75: z.number(),
  p95: z.number(),
});
const Bands = z.object({
  p5: z.array(z.number()),
  p25: z.array(z.number()),
  p50: z.array(z.number()),
  p75: z.array(z.number()),
  p95: z.array(z.number()),
});

export const Analysis = z.object({
  dataset: z.object({
    source: z.string(),
    synthetic: z.boolean(),
    start: iso,
    end: iso,
    tradingDays: z.number(),
  }),
  assumptions: z.object({
    riskFreeAnnual: z.number(),
    tradingDaysPerYear: z.number(),
    benchmark: z.string(),
  }),
  totalValue: z.number(),
  valueAssumed: z.boolean(),
  holdings: z.array(Holding).min(1),
  metrics: z.object({
    annualReturn: z.number(),
    volatility: z.number(),
    sharpe: z.number(),
    sortino: z.number(),
    beta: z.number(),
    maxDrawdown: z.object({
      depth: z.number(),
      peakDate: iso,
      troughDate: iso,
      recoveryDate: iso.nullable(),
      tradingDays: z.number(),
    }),
    var95: z.number(),
    cvar95: z.number(),
    var99: z.number(),
    cvar99: z.number(),
  }),
  benchmark: z.object({
    annualReturn: z.number(),
    volatility: z.number(),
    sharpe: z.number(),
    maxDrawdown: z.number(),
  }),
  series: z.object({
    dates: z.array(iso).min(2),
    portfolio: z.array(z.number()),
    benchmark: z.array(z.number()),
    underwater: z.array(z.number()),
  }),
  correlation: z.object({
    tickers: z.array(z.string()),
    matrix: z.array(z.array(z.number())),
  }),
  sectors: z.array(z.object({ sector: z.string(), weight: z.number() })),
  monteCarlo: z.object({
    horizonDays: z.number(),
    simulations: z.number(),
    percentiles: Percentiles,
    probabilityOfLoss: z.number(),
    mean: z.number(),
    bandDays: z.array(z.number()),
    bands: Bands,
  }),
});
export type Analysis = z.infer<typeof Analysis>;

const FrontierPoint = z.object({
  volatility: z.number(),
  annualReturn: z.number(),
  sharpe: z.number(),
  maxDrawdown: z.number(),
});
export type FrontierPoint = z.infer<typeof FrontierPoint>;

export const Frontier = z.object({
  count: z.number(),
  /** [volatility, annual return, Sharpe, max drawdown] per simulated mix */
  points: z.array(z.tuple([z.number(), z.number(), z.number(), z.number()])),
  current: FrontierPoint,
  maxSharpe: FrontierPoint,
  minVolatility: FrontierPoint,
});
export type Frontier = z.infer<typeof Frontier>;

export const PortfolioResponse = z.object({ analysis: Analysis, frontier: Frontier });
export type PortfolioResponse = z.infer<typeof PortfolioResponse>;

export const SampleBundle = z.object({
  analysis: Analysis,
  universe: z.array(z.object({ ticker: z.string(), name: z.string(), sector: z.string() })),
  limits: z.object({
    maxCsvBytes: z.number(),
    maxHoldings: z.number(),
    minHoldings: z.number(),
    maxQuestionChars: z.number(),
  }),
});
export type SampleBundle = z.infer<typeof SampleBundle>;

export const TOOL_NAMES = [
  "get_metric",
  "run_stress_test",
  "rebalance_to_target",
  "monte_carlo",
] as const;

export const ToolCall = z.object({
  id: z.string(),
  name: z.enum(TOOL_NAMES),
  input: z.record(z.string(), z.unknown()),
  output: z.unknown(),
  isError: z.boolean(),
  round: z.number().int(),
});
export type ToolCall = z.infer<typeof ToolCall>;

export const NumberCheck = z.object({
  text: z.string(),
  value: z.number(),
  unit: z.enum(["percent", "bps", "plain"]),
  /** matched: traced to a tool output. question: restated from the question. unmatched: neither. */
  status: z.enum(["matched", "question", "unmatched"]),
  callId: z.string().nullable(),
  tool: z.string().nullable(),
  path: z.string().nullable(),
  sourceValue: z.number().nullable(),
  approximate: z.boolean(),
  alternatives: z.number().int(),
});
export type NumberCheck = z.infer<typeof NumberCheck>;

export const Provenance = z.object({
  segments: z.array(z.object({ text: z.string(), number: z.number().int().nullish() })),
  numbers: z.array(NumberCheck),
  matched: z.number().int(),
  fromQuestion: z.number().int(),
  unmatched: z.number().int(),
  ignored: z.array(z.object({ text: z.string(), reason: z.string() })),
});
export type Provenance = z.infer<typeof Provenance>;

export const Session = z.object({
  question: z.string(),
  answer: z.string(),
  calls: z.array(ToolCall),
  rounds: z.number().int(),
  usedTools: z.boolean(),
  provenance: Provenance,
  selfTest: z
    .object({
      answer: z.string(),
      provenance: Provenance,
      original: z.string(),
      altered: z.string(),
    })
    .nullable(),
});
export type Session = z.infer<typeof Session>;

export const AnalystEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("round"), round: z.number().int() }),
  z.object({ type: z.literal("note"), text: z.string() }),
  z.object({ type: z.literal("tool"), call: ToolCall }),
  z.object({ type: z.literal("retry"), reason: z.literal("no_tools") }),
]);
export type AnalystEvent = z.infer<typeof AnalystEvent>;

export const Preset = z.object({
  route: z.literal("/api/analyst"),
  body: z.object({ demoId: z.string(), question: z.string() }),
});
export type Preset = z.infer<typeof Preset>;
