"""The analyst's four tools: strict schemas for the model, handlers wired to the risk engine.

Rules these handlers follow, because the provenance checker depends on them:

- Every number the model might quote is in the output, including the inputs it passed
  (echoed back) and the differences between scenarios, so it never has to do arithmetic.
- Outputs carry no incidental numbers (seeds, row counts of internals) that prose could
  match by accident.
- Fractions are decimals (0.1834 is 18.34%); fields ending in `_pct` are already percent;
  fields ending in `_usd` are dollars.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import numpy as np

from . import risk
from .claude_client import strict_tool
from .portfolio import MONTE_CARLO_SEED, PORTFOLIO, Portfolio, r6
from .universe import SECTORS, TICKERS, UNIVERSE, sector_of

ToolHandler = Callable[[dict[str, Any]], Any]

METRICS = [
    "annual_return",
    "volatility",
    "sharpe",
    "sortino",
    "max_drawdown",
    "beta",
    "var_95",
    "cvar_95",
    "var_99",
    "cvar_99",
    "holdings",
    "sector_exposure",
    "risk_contribution",
    "correlation",
]
PORTFOLIO_ONLY = {"holdings", "sector_exposure", "risk_contribution"}
NO_SECTOR = "NONE"

MAX_SHOCK_PCT = 90.0
MAX_HORIZON_DAYS = 504
MIN_SIMULATIONS, MAX_SIMULATIONS = 100, 10_000
MAX_SIMULATED_DAYS = 2_520_000  # horizon x simulations: bounds memory on a small host

TOOLS: list[dict[str, Any]] = [
    strict_tool(
        "get_metric",
        "Look up one risk metric for the whole portfolio or for a single ticker. "
        "Fractions are decimals (0.18 means 18%). VaR and CVaR are one-day losses, "
        "reported as positive fractions. Call this several times in one turn when you "
        "need several metrics.",
        {
            "metric": {
                "type": "string",
                "enum": METRICS,
                "description": "holdings, sector_exposure and risk_contribution describe "
                "the whole portfolio and need subject PORTFOLIO.",
            },
            "subject": {
                "type": "string",
                "enum": [PORTFOLIO, *TICKERS],
                "description": "PORTFOLIO, or a ticker (SPY is the market benchmark).",
            },
        },
    ),
    strict_tool(
        "run_stress_test",
        "Estimate what an instant shock would do to the portfolio. Each holding moves by "
        "its beta times the market shock, plus the sector shock if it is in that sector. "
        "Use sector NONE and sector_shock_pct 0 for a market-only scenario.",
        {
            "market_shock_pct": {
                "type": "number",
                "description": "Market move in percent, for example -20 for a 20% fall.",
            },
            "sector": {"type": "string", "enum": [NO_SECTOR, *SECTORS]},
            "sector_shock_pct": {
                "type": "number",
                "description": "Extra move in percent for holdings in that sector.",
            },
        },
    ),
    strict_tool(
        "rebalance_to_target",
        "Report what moving one sector or one ticker to a target weight would do to the "
        "portfolio's risk numbers. Every other holding is scaled in proportion. This "
        "describes a hypothetical; it is not a recommendation.",
        {
            "scope": {"type": "string", "enum": ["sector", "ticker"]},
            "name": {"type": "string", "description": "A sector name or a ticker symbol."},
            "target_weight_pct": {
                "type": "number",
                "description": "The new weight in percent of the portfolio, 0 to 100.",
            },
        },
    ),
    strict_tool(
        "monte_carlo",
        "Simulate the portfolio's value over a horizon by resampling its historical daily "
        f"returns. horizon_days is 1 to {MAX_HORIZON_DAYS} trading days (252 is one year); "
        f"simulations is {MIN_SIMULATIONS} to {MAX_SIMULATIONS}.",
        {
            "horizon_days": {"type": "integer"},
            "simulations": {"type": "integer"},
        },
    ),
]


def _text(args: dict[str, Any], key: str) -> str:
    value = args.get(key)
    if not isinstance(value, str):
        raise ValueError(f"{key} must be text.")
    return value.strip()


def _real(args: dict[str, Any], key: str, low: float, high: float) -> float:
    value = args.get(key)
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ValueError(f"{key} must be a number.")
    if not low <= value <= high:
        raise ValueError(f"{key} must be between {low:g} and {high:g}.")
    return float(value)


def _whole(args: dict[str, Any], key: str, low: int, high: int) -> int:
    value = args.get(key)
    if isinstance(value, bool) or not isinstance(value, int | float) or value != int(value):
        raise ValueError(f"{key} must be a whole number.")
    if not low <= value <= high:
        raise ValueError(f"{key} must be between {low} and {high}.")
    return int(value)


def get_metric(portfolio: Portfolio, args: dict[str, Any]) -> dict[str, Any]:
    metric = _text(args, "metric")
    subject = _text(args, "subject").upper()
    if metric not in METRICS:
        raise ValueError(f"Unknown metric: {metric}.")
    if subject != PORTFOLIO and subject not in UNIVERSE:
        raise ValueError(f"Unknown subject: {subject}. Use PORTFOLIO or a ticker.")
    if metric in PORTFOLIO_ONLY and subject != PORTFOLIO:
        raise ValueError(f"{metric} describes the whole portfolio; use subject PORTFOLIO.")
    base: dict[str, Any] = {"metric": metric, "subject": subject}
    series = portfolio.series(subject)

    if metric == "annual_return":
        return {
            **base,
            "value": r6(risk.annualized_return(series)),
            "unit": "fraction per year (geometric)",
            "trading_days_per_year": risk.TRADING_DAYS_PER_YEAR,
        }
    if metric == "volatility":
        return {
            **base,
            "value": r6(risk.annualized_volatility(series)),
            "unit": "fraction per year",
            "trading_days_per_year": risk.TRADING_DAYS_PER_YEAR,
        }
    if metric == "sharpe":
        return {
            **base,
            "value": r6(risk.sharpe_ratio(series)),
            "unit": "ratio",
            "risk_free_rate": risk.RISK_FREE_ANNUAL,
        }
    if metric == "sortino":
        return {
            **base,
            "value": r6(risk.sortino_ratio(series)),
            "unit": "ratio",
            "risk_free_rate": risk.RISK_FREE_ANNUAL,
        }
    if metric == "beta":
        return {**base, "value": r6(risk.beta(series, portfolio.market)), "unit": "vs SPY"}
    if metric == "max_drawdown":
        fall = portfolio.drawdown(subject)
        return {**base, "value": fall.pop("depth"), "unit": "fraction, peak to trough", **fall}
    if metric in ("var_95", "cvar_95", "var_99", "cvar_99"):
        kind, level = metric.split("_")
        confidence = int(level) / 100
        measure = risk.historical_var if kind == "var" else risk.historical_cvar
        loss = measure(series, confidence)
        result = {
            **base,
            "value": r6(loss),
            "unit": "loss as a positive fraction",
            "confidence": confidence,
            "horizon_days": 1,
        }
        if subject == PORTFOLIO:
            result["loss_usd"] = round(loss * portfolio.total_value, 2)
        return result
    if metric == "holdings":
        return {
            **base,
            "count": len(portfolio.holdings),
            "total_value_usd": round(portfolio.total_value, 2),
            "positions": [
                {
                    "ticker": h.ticker,
                    "sector": sector_of(h.ticker),
                    "weight": r6(h.weight),
                    "value_usd": round(h.weight * portfolio.total_value, 2),
                }
                for h in portfolio.holdings
            ],
        }
    if metric == "sector_exposure":
        return {
            **base,
            "sectors": [{"sector": s, "weight": r6(w)} for s, w in portfolio.sectors.items()],
        }
    if metric == "risk_contribution":
        shares = portfolio.risk_shares
        ranked = sorted(portfolio.holdings, key=lambda h: -shares[h.ticker])
        return {
            **base,
            "unit": "share of portfolio variance",
            "positions": [
                {"ticker": h.ticker, "weight": r6(h.weight), "risk_share": r6(shares[h.ticker])}
                for h in ranked
            ],
        }
    # correlation
    matrix = risk.correlation_matrix(portfolio.matrix)
    names = portfolio.tickers
    if subject == PORTFOLIO:
        pairs = [
            (float(matrix[i, j]), names[i], names[j])
            for i in range(len(names))
            for j in range(i + 1, len(names))
        ]
        highest, lowest = max(pairs), min(pairs)
        return {
            **base,
            "average_pairwise": r6(sum(p[0] for p in pairs) / len(pairs)),
            "highest": {"pair": [highest[1], highest[2]], "value": r6(highest[0])},
            "lowest": {"pair": [lowest[1], lowest[2]], "value": r6(lowest[0])},
        }
    others = [(i, other) for i, other in enumerate(names) if other != subject]
    return {
        **base,
        "with_holdings": [
            {
                "ticker": other,
                "value": r6(
                    risk.correlation_matrix(np.column_stack([series, portfolio.matrix[:, i]]))[0, 1]
                ),
            }
            for i, other in others
        ],
    }


def run_stress_test(portfolio: Portfolio, args: dict[str, Any]) -> dict[str, Any]:
    market = _real(args, "market_shock_pct", -MAX_SHOCK_PCT, MAX_SHOCK_PCT)
    extra = _real(args, "sector_shock_pct", -MAX_SHOCK_PCT, MAX_SHOCK_PCT)
    sector = _text(args, "sector")
    if sector != NO_SECTOR and sector not in SECTORS:
        raise ValueError(f"Unknown sector: {sector}.")
    if sector == NO_SECTOR and extra != 0:
        raise ValueError("sector_shock_pct needs a sector; use 0 with sector NONE.")

    positions: list[dict[str, Any]] = []
    total = 0.0
    for holding in portfolio.holdings:
        beta = portfolio.betas[holding.ticker]
        move = beta * market / 100
        if sector_of(holding.ticker) == sector:
            move += extra / 100
        move = max(move, -1.0)  # a holding cannot lose more than everything
        total += holding.weight * move
        positions.append(
            {
                "ticker": holding.ticker,
                "beta": r6(beta),
                "change": r6(move),
                "change_usd": round(holding.weight * portfolio.total_value * move, 2),
            }
        )
    positions.sort(key=lambda p: p["change_usd"])
    return {
        "market_shock_pct": market,
        "sector": sector,
        "sector_shock_pct": extra,
        "sector_weight": r6(portfolio.sectors.get(sector, 0.0)),
        "portfolio_change": r6(total),
        "portfolio_change_usd": round(total * portfolio.total_value, 2),
        "portfolio_value_after_usd": round((1 + total) * portfolio.total_value, 2),
        "positions": positions,
        "method": "each holding moves by its beta times the market shock, plus the sector shock",
    }


def rebalance_to_target(portfolio: Portfolio, args: dict[str, Any]) -> dict[str, Any]:
    scope = _text(args, "scope")
    name = _text(args, "name")
    target_pct = _real(args, "target_weight_pct", 0.0, 100.0)
    target = target_pct / 100
    weights = {h.ticker: h.weight for h in portfolio.holdings}

    if scope == "sector":
        match = next((s for s in SECTORS if s.lower() == name.lower()), None)
        if match is None:
            raise ValueError(f"Unknown sector: {name}. Sectors: {', '.join(SECTORS)}.")
        name = match
        inside = {t for t in weights if sector_of(t) == name}
        if not inside:
            raise ValueError(
                f"The portfolio holds nothing in {name}. Use scope ticker to add a position."
            )
    elif scope == "ticker":
        name = name.upper()
        if name not in UNIVERSE:
            raise ValueError(f"Unknown ticker: {name}.")
        weights.setdefault(name, 0.0)
        inside = {name}
    else:
        raise ValueError("scope must be sector or ticker.")

    current = sum(weights[t] for t in inside)
    outside = 1.0 - current
    if outside <= 1e-12 and target < 1:
        raise ValueError("There is nothing else in the portfolio to move the weight into.")
    after: dict[str, float] = {}
    for ticker, weight in weights.items():
        if ticker in inside:
            # A new position has no current weight to scale, so it takes the whole target.
            after[ticker] = weight * target / current if current > 0 else target
        else:
            after[ticker] = weight * (1 - target) / outside if outside > 1e-12 else 0.0
    if sum(1 for w in after.values() if w > 1e-12) < 1:
        raise ValueError("The target leaves nothing in the portfolio.")

    rebalanced = portfolio.reweighted(after)
    before_risk, after_risk = portfolio.risk_summary(), rebalanced.risk_summary()
    turnover = 0.5 * sum(abs(after[t] - weights[t]) for t in weights)
    return {
        "scope": scope,
        "name": name,
        "current_weight_pct": r6(current * 100),
        "target_weight_pct": target_pct,
        "var_confidence": 0.95,
        "before": before_risk,
        "after": after_risk,
        "change": {key: r6(after_risk[key] - before_risk[key]) for key in before_risk},
        "turnover": r6(turnover),
        "turnover_usd": round(turnover * portfolio.total_value, 2),
        "weights_after": [
            {"ticker": h.ticker, "weight": r6(h.weight)} for h in rebalanced.holdings
        ],
        "note": "A what-if on historical data. It describes risk, not what to buy or sell.",
    }


def monte_carlo(portfolio: Portfolio, args: dict[str, Any]) -> dict[str, Any]:
    horizon = _whole(args, "horizon_days", 1, MAX_HORIZON_DAYS)
    simulations = _whole(args, "simulations", MIN_SIMULATIONS, MAX_SIMULATIONS)
    if horizon * simulations > MAX_SIMULATED_DAYS:
        raise ValueError("That is too much to simulate at once. Lower simulations or the horizon.")
    result = risk.monte_carlo(portfolio.returns, horizon, simulations, MONTE_CARLO_SEED)
    start = portfolio.total_value
    percentiles = {f"p{q}": r6(result.percentile(q)) for q in risk.BAND_PERCENTILES}
    return {
        "horizon_days": horizon,
        "simulations": simulations,
        "method": "bootstrap: each path resamples historical daily returns with replacement",
        "start_value_usd": round(start, 2),
        "return_percentiles": percentiles,
        "value_usd_percentiles": {k: round(start * (1 + v), 2) for k, v in percentiles.items()},
        "mean_return": r6(result.mean),
        "probability_of_loss": r6(result.probability_of_loss),
    }


def build_handlers(portfolio: Portfolio) -> dict[str, ToolHandler]:
    """Handlers for `call_claude`, bound to one portfolio. A raised error goes back to the model."""
    return {
        "get_metric": lambda args: get_metric(portfolio, args),
        "run_stress_test": lambda args: run_stress_test(portfolio, args),
        "rebalance_to_target": lambda args: rebalance_to_target(portfolio, args),
        "monte_carlo": lambda args: monte_carlo(portfolio, args),
    }
