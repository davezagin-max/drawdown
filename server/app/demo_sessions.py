"""Placeholder analyst sessions for demo mode, built from the real engine.

No API key exists while this repository is being built, so the demo cannot replay a
real model run yet. These sessions stand in until one is recorded. What is hand-written
is the prose and the choice of tool calls. What is real is everything else: each tool
call below is executed by the same handlers the live analyst uses, each number in the
prose is formatted from those outputs, and the finished text goes through the same
provenance checker. Every fixture is marked `placeholder: true` and the UI says so.

`scripts/record.py` replaces them with recorded Claude Opus 5.5 runs.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date
from typing import Any

from .analyst import build_session
from .config import OPUS, Usage
from .portfolio import Portfolio
from .tools import build_handlers

Outputs = list[dict[str, Any]]
Round = tuple[str, list[tuple[str, dict[str, Any]]]]

# Replay pacing in recorded milliseconds (the frontend replays at 4x).
THINK_MS = 2600
WORK_MS = 3400
TOOL_GAP_MS = 160


def pct(value: float, decimals: int = 1) -> str:
    return f"{abs(value) * 100:.{decimals}f}%"


def usd(value: float) -> str:
    return f"${abs(value):,.0f}"


def day(iso: str) -> str:
    d = date.fromisoformat(iso)
    return f"{d.day} {d:%B} {d.year}"


def _risk_sources(o: Outputs) -> str:
    volatility, beta, sectors, shares, drawdown, var, market = o
    top_sector = sectors["sectors"][0]
    top, low = shares["positions"][0], shares["positions"][-1]
    if low["risk_share"] < 0:
        tail = (
            f"At the other end, {low['ticker']}'s risk share is slightly negative, at "
            f"-{pct(low['risk_share'])}: it has tended to move against the rest, which "
            "dampens the swings."
        )
    else:
        tail = f"{low['ticker']} adds the least, at {pct(low['risk_share'])} of the variance."
    return (
        f"The portfolio's volatility is {pct(volatility['value'])} a year, against "
        f"{pct(market['value'])} for the SPY benchmark, and its beta of {beta['value']:.2f} "
        "means it tends to move a little more than the market does.\n\n"
        f"Most of that risk sits in one place. {top_sector['sector']} is "
        f"{pct(top_sector['weight'], 0)} of the money, and {top['ticker']} alone is "
        f"{pct(top['weight'], 0)} of the weight but {pct(top['risk_share'])} of the "
        f"portfolio's variance. {tail}\n\n"
        f"The worst fall in this history was {pct(drawdown['value'])}, from "
        f"{day(drawdown['peak_date'])} to {day(drawdown['trough_date'])}, over "
        f"{drawdown['trading_days_peak_to_trough']} trading days. On an ordinary bad day, "
        f"the {pct(var['confidence'], 0)} one-day value at risk is {pct(var['value'])}, "
        f"or about {usd(var['loss_usd'])}."
    )


def _market_drop(o: Outputs) -> str:
    combined, market_only, beta, drawdown = o
    worst = combined["positions"][0]
    gainers = [p for p in combined["positions"] if p["change_usd"] > 0]
    hedge = (
        f" {gainers[-1]['ticker']} is the only holding that gains, because its beta is "
        f"negative, at {gainers[-1]['beta']:.2f}."
        if len(gainers) == 1
        else ""
    )
    deeper = abs(combined["portfolio_change"]) > abs(drawdown["value"])
    return (
        f"In this scenario the portfolio falls {pct(combined['portfolio_change'])}, a loss "
        f"of about {usd(combined['portfolio_change_usd'])} that leaves "
        f"{usd(combined['portfolio_value_after_usd'])}. A "
        f"{abs(market_only['market_shock_pct']):.0f}% market fall on its own accounts for "
        f"{pct(market_only['portfolio_change'])}: the portfolio's beta is "
        f"{beta['value']:.2f}, so it moves slightly more than the market.\n\n"
        f"The extra {abs(combined['sector_shock_pct']):.0f}% hit to technology adds the "
        f"rest, because technology is {pct(combined['sector_weight'], 0)} of the portfolio. "
        f"{worst['ticker']} is the largest single loss at {usd(worst['change_usd'])}.{hedge}\n\n"
        f"For scale, the worst fall in this simulated history was {pct(drawdown['value'])}, "
        f"so the scenario is {'deeper' if deeper else 'shallower'} than anything the "
        "history contains. The estimate is linear: it scales each holding by its beta and "
        "ignores how correlations shift in a real sell-off."
    )


def _trim_tech(o: Outputs) -> str:
    rebalance, _sectors, simulation = o
    before, after = rebalance["before"], rebalance["after"]
    percentiles = simulation["return_percentiles"]
    return (
        f"Technology is {rebalance['current_weight_pct']:.0f}% of the portfolio today. "
        f"Moving it to {rebalance['target_weight_pct']:.0f}% and scaling every other "
        f"holding up in proportion would mean trading {pct(rebalance['turnover'], 0)} of "
        f"the portfolio, about {usd(rebalance['turnover_usd'])}.\n\n"
        f"On this history, volatility would go from {pct(before['volatility'])} to "
        f"{pct(after['volatility'])}, beta from {before['beta']:.2f} to {after['beta']:.2f}, "
        f"and the worst fall from {pct(before['max_drawdown'])} to "
        f"{pct(after['max_drawdown'])}. The {pct(rebalance['var_confidence'], 0)} one-day "
        f"value at risk would move from {pct(before['var_95'], 2)} to "
        f"{pct(after['var_95'], 2)}.\n\n"
        f"For context, a simulation of the current mix over {simulation['horizon_days']} "
        f"trading days, across {simulation['simulations']:,} paths, ends with a loss in "
        f"{pct(simulation['probability_of_loss'], 0)} of them. The middle outcome is a gain "
        f"of {pct(percentiles['p50'])} and the 5th-percentile outcome is a loss of "
        f"{pct(percentiles['p5'])}. None of this says which mix is better. It describes how "
        "the risk numbers would have differed."
    )


# demoId -> (question, rounds of (progress note, tool calls), closing note, narration)
SCRIPTS: dict[str, tuple[str, list[Round], str, Callable[[Outputs], str]]] = {
    "risk-sources": (
        "Where is the risk in this portfolio coming from?",
        [
            (
                "Starting with the headline risk numbers and how the money is spread.",
                [
                    ("get_metric", {"metric": "volatility", "subject": "PORTFOLIO"}),
                    ("get_metric", {"metric": "beta", "subject": "PORTFOLIO"}),
                    ("get_metric", {"metric": "sector_exposure", "subject": "PORTFOLIO"}),
                    ("get_metric", {"metric": "risk_contribution", "subject": "PORTFOLIO"}),
                ],
            ),
            (
                "One holding carries far more risk than its weight. Checking the worst fall, "
                "an ordinary bad day, and the benchmark for comparison.",
                [
                    ("get_metric", {"metric": "max_drawdown", "subject": "PORTFOLIO"}),
                    ("get_metric", {"metric": "var_95", "subject": "PORTFOLIO"}),
                    ("get_metric", {"metric": "volatility", "subject": "SPY"}),
                ],
            ),
        ],
        "Writing up where the risk concentrates.",
        _risk_sources,
    ),
    "market-drop": (
        "What happens if the market falls 20% and technology drops a further 10%?",
        [
            (
                "Running the combined shock next to a market-only version, so the technology "
                "effect can be separated out.",
                [
                    (
                        "run_stress_test",
                        {
                            "market_shock_pct": -20,
                            "sector": "Technology",
                            "sector_shock_pct": -10,
                        },
                    ),
                    (
                        "run_stress_test",
                        {"market_shock_pct": -20, "sector": "NONE", "sector_shock_pct": 0},
                    ),
                    ("get_metric", {"metric": "beta", "subject": "PORTFOLIO"}),
                ],
            ),
            (
                "Putting the scenario next to the worst fall this history actually produced.",
                [("get_metric", {"metric": "max_drawdown", "subject": "PORTFOLIO"})],
            ),
        ],
        "Writing up the scenario and its limits.",
        _market_drop,
    ),
    "trim-tech": (
        "What would cutting technology to 20% of the portfolio do to its risk?",
        [
            (
                "Rebalancing technology down to the target and reading the risk numbers "
                "before and after.",
                [
                    (
                        "rebalance_to_target",
                        {"scope": "sector", "name": "Technology", "target_weight_pct": 20},
                    ),
                    ("get_metric", {"metric": "sector_exposure", "subject": "PORTFOLIO"}),
                ],
            ),
            (
                "Simulating a year of the current mix for context.",
                [("monte_carlo", {"horizon_days": 252, "simulations": 5000})],
            ),
        ],
        "Writing up the before and after.",
        _trim_tech,
    ),
}


def build_placeholder(demo_id: str, portfolio: Portfolio) -> dict[str, Any]:
    """One placeholder fixture, in the same shape a recorded run is stored in."""
    question, rounds, closing, narrate = SCRIPTS[demo_id]
    handlers = build_handlers(portfolio)
    calls: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []
    clock = 0

    def emit(event: dict[str, Any]) -> None:
        events.append({"at": clock, "event": event})

    for number, (note, requests) in enumerate(rounds, start=1):
        emit({"type": "round", "round": number})
        clock += THINK_MS
        emit({"type": "note", "text": note})
        clock += WORK_MS
        for name, arguments in requests:
            call = {
                "id": f"toolu_sample_{len(calls) + 1:02d}",
                "name": name,
                "input": arguments,
                "output": handlers[name](arguments),
                "isError": False,
                "round": number,
            }
            calls.append(call)
            emit({"type": "tool", "call": call})
            clock += TOOL_GAP_MS
    emit({"type": "round", "round": len(rounds) + 1})
    clock += THINK_MS
    emit({"type": "note", "text": closing})

    answer = narrate([call["output"] for call in calls])
    return {
        "label": demo_id,
        "placeholder": True,
        "recordedAt": None,
        "model": OPUS,
        "usage": Usage().as_dict(),
        "costUsd": 0,
        "data": build_session(question, answer, calls, rounds=len(rounds) + 1),
        "events": events,
    }


def presets() -> list[dict[str, Any]]:
    """Every preset request, for `scripts/record.py` to replay with a key."""
    return [
        {"route": "/api/analyst", "body": {"demoId": demo_id, "question": script[0]}}
        for demo_id, script in SCRIPTS.items()
    ]
