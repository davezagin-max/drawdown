"""Holdings in, analysis out: CSV validation, the portfolio context, and the full bundle.

Uploaded holdings are parsed and analysed in memory for one request and never stored.
"""

from __future__ import annotations

import csv
import io
import math
import re
from dataclasses import dataclass
from functools import cached_property
from typing import Any

import numpy as np

from . import risk
from .prices import PriceData
from .universe import BENCHMARK, UNIVERSE, sector_of

MAX_CSV_BYTES = 32_000
MAX_HOLDINGS = 50
MIN_HOLDINGS = 2
DEFAULT_TOTAL_VALUE = 100_000.0
PORTFOLIO = "PORTFOLIO"

SAMPLE_TOTAL_VALUE = 250_000.0
# A deliberately tech-heavy portfolio, so the analysis has something to find.
SAMPLE_WEIGHTS: dict[str, float] = {
    "NVDA": 0.14,
    "AAPL": 0.12,
    "MSFT": 0.12,
    "AMZN": 0.09,
    "GOOGL": 0.08,
    "JPM": 0.08,
    "TLT": 0.08,
    "TSLA": 0.06,
    "UNH": 0.06,
    "COST": 0.06,
    "JNJ": 0.06,
    "XOM": 0.05,
}

_TICKER = re.compile(r"^[A-Z][A-Z.]{0,5}$")
_TICKER_COLUMNS = ("ticker", "symbol")
_VALUE_COLUMNS = ("value", "market_value", "amount")
_WEIGHT_COLUMNS = ("weight", "weight_pct", "allocation")


class HoldingsError(ValueError):
    """A problem with supplied holdings. The message is written for the visitor to read."""


@dataclass(frozen=True)
class Holding:
    ticker: str
    weight: float  # fraction of the portfolio; a portfolio's weights sum to 1


def _number(raw: str, row: int) -> float:
    cleaned = raw.strip().replace("$", "").replace(",", "").replace("%", "")
    try:
        value = float(cleaned)
    except ValueError:
        raise HoldingsError(f"Row {row}: the amount is not a number.") from None
    if not math.isfinite(value) or value <= 0:
        raise HoldingsError(f"Row {row}: the amount must be greater than zero.")
    return value


def normalize(amounts: dict[str, float]) -> list[Holding]:
    """Validate tickers and turn positive amounts into weights that sum to 1."""
    if len(amounts) > MAX_HOLDINGS:
        raise HoldingsError(f"A portfolio can have at most {MAX_HOLDINGS} holdings.")
    unknown = [t for t in amounts if t not in UNIVERSE]
    if unknown:
        shown = ", ".join(t for t in unknown[:5] if _TICKER.match(t)) or "an unreadable symbol"
        raise HoldingsError(
            f"Not in the bundled universe of {len(UNIVERSE)} tickers: {shown}. "
            "Prices are simulated, so only the listed symbols can be analysed."
        )
    if len(amounts) < MIN_HOLDINGS:
        raise HoldingsError(f"Add at least {MIN_HOLDINGS} different holdings.")
    total = sum(amounts.values())
    if not math.isfinite(total) or total <= 0 or any(a <= 0 for a in amounts.values()):
        raise HoldingsError("Every holding needs an amount greater than zero.")
    holdings = [Holding(t, a / total) for t, a in amounts.items()]
    return sorted(holdings, key=lambda h: (-h.weight, h.ticker))


def parse_holdings_csv(text: str) -> tuple[list[Holding], float, bool]:
    """Parse `ticker,value` or `ticker,weight` rows.

    Returns the holdings, the portfolio's dollar value, and whether that value was
    assumed (a weights-only file carries no dollar amounts).
    """
    if len(text.encode()) > MAX_CSV_BYTES:
        raise HoldingsError(f"The file is too large (limit {MAX_CSV_BYTES // 1000} KB).")
    rows = [
        [cell.strip() for cell in row]
        for row in csv.reader(io.StringIO(text.lstrip("﻿")))
        if any(cell.strip() for cell in row)
    ]
    if len(rows) < 2:
        raise HoldingsError("The file needs a header row and at least one holding.")
    header = [cell.lower().replace(" ", "_") for cell in rows[0]]
    ticker_at = next((header.index(c) for c in _TICKER_COLUMNS if c in header), None)
    value_at = next((header.index(c) for c in _VALUE_COLUMNS if c in header), None)
    weight_at = next((header.index(c) for c in _WEIGHT_COLUMNS if c in header), None)
    amount_at = value_at if value_at is not None else weight_at
    if ticker_at is None or amount_at is None:
        raise HoldingsError('The header needs a "ticker" column and a "value" or "weight" column.')
    if len(rows) - 1 > MAX_HOLDINGS:
        raise HoldingsError(f"A portfolio can have at most {MAX_HOLDINGS} holdings.")

    amounts: dict[str, float] = {}
    for number, row in enumerate(rows[1:], start=2):
        if len(row) <= max(ticker_at, amount_at):
            raise HoldingsError(f"Row {number}: a column is missing.")
        ticker = row[ticker_at].upper()
        if not _TICKER.match(ticker):
            raise HoldingsError(f"Row {number}: that is not a ticker symbol.")
        amounts[ticker] = amounts.get(ticker, 0.0) + _number(row[amount_at], number)
    holdings = normalize(amounts)
    if value_at is not None:
        return holdings, round(sum(amounts.values()), 2), False
    return holdings, DEFAULT_TOTAL_VALUE, True


def sample_holdings() -> list[Holding]:
    return normalize(dict(SAMPLE_WEIGHTS))


def r6(value: float) -> float:
    """Round for output. Six decimals keeps every digit a reader could quote."""
    return round(float(value), 6) + 0.0  # adding 0.0 turns -0.0 into 0.0


class Portfolio:
    """A set of weights over the price history, with the series the engine needs."""

    def __init__(self, data: PriceData, holdings: list[Holding], total_value: float):
        if total_value <= 0 or not math.isfinite(total_value):
            raise HoldingsError("The portfolio value must be greater than zero.")
        self.data = data
        self.holdings = holdings
        self.total_value = float(total_value)
        self.tickers = [h.ticker for h in holdings]
        self.weights = np.array([h.weight for h in holdings])
        self.dates = [d.date().isoformat() for d in data.prices.index]

    def reweighted(self, weights: dict[str, float]) -> Portfolio:
        """The same money in a different mix (zero weights are dropped)."""
        kept = {t: w for t, w in weights.items() if w > 1e-12}
        total = sum(kept.values())
        holdings = sorted(
            (Holding(t, w / total) for t, w in kept.items()), key=lambda h: (-h.weight, h.ticker)
        )
        return Portfolio(self.data, holdings, self.total_value)

    def asset_returns(self, ticker: str) -> np.ndarray:
        return risk.simple_returns(self.data.prices[ticker].to_numpy())

    @cached_property
    def matrix(self) -> np.ndarray:
        """Daily returns of the holdings, days x holdings."""
        return np.column_stack([self.asset_returns(t) for t in self.tickers])

    @cached_property
    def returns(self) -> np.ndarray:
        return risk.portfolio_returns(self.matrix, self.weights)

    @cached_property
    def market(self) -> np.ndarray:
        return self.asset_returns(BENCHMARK)

    @cached_property
    def growth(self) -> np.ndarray:
        return risk.growth_curve(self.returns)

    @cached_property
    def betas(self) -> dict[str, float]:
        return {t: risk.beta(self.matrix[:, i], self.market) for i, t in enumerate(self.tickers)}

    @cached_property
    def risk_shares(self) -> dict[str, float]:
        shares = risk.risk_contributions(risk.covariance_matrix(self.matrix), self.weights)
        return dict(zip(self.tickers, (float(s) for s in shares), strict=True))

    @cached_property
    def sectors(self) -> dict[str, float]:
        weights = dict(zip(self.tickers, (float(w) for w in self.weights), strict=True))
        return risk.sector_exposure(weights, {t: sector_of(t) for t in self.tickers})

    def series(self, subject: str) -> np.ndarray:
        """Daily returns for the whole portfolio or for one ticker in the universe."""
        if subject == PORTFOLIO:
            return self.returns
        if subject not in UNIVERSE:
            raise ValueError(f"Unknown ticker: {subject}.")
        return self.asset_returns(subject)

    def drawdown(self, subject: str = PORTFOLIO) -> dict[str, Any]:
        result = risk.max_drawdown(risk.growth_curve(self.series(subject)))
        return {
            "depth": r6(result.depth),
            "peak_date": self.dates[result.peak],
            "trough_date": self.dates[result.trough],
            "recovery_date": None if result.recovery is None else self.dates[result.recovery],
            "trading_days_peak_to_trough": result.trough - result.peak,
        }

    def risk_summary(self) -> dict[str, float]:
        """The risk numbers a what-if is compared on."""
        return {
            "volatility": r6(risk.annualized_volatility(self.returns)),
            "max_drawdown": r6(risk.max_drawdown(self.growth).depth),
            "beta": r6(risk.beta(self.returns, self.market)),
            "var_95": r6(risk.historical_var(self.returns, 0.95)),
            "cvar_95": r6(risk.historical_cvar(self.returns, 0.95)),
        }


MONTE_CARLO_SEED = 7
DASHBOARD_HORIZON = 252
DASHBOARD_SIMULATIONS = 2000


def _sample_indices(length: int, step: int, keep: list[int | None]) -> list[int]:
    """Every `step`-th index plus the ones that must not be skipped."""
    chosen = set(range(0, length, step)) | {length - 1}
    chosen.update(i for i in keep if i is not None)
    return sorted(chosen)


def analyze(portfolio: Portfolio, *, value_assumed: bool = False) -> dict[str, Any]:
    """Everything the dashboard shows for one portfolio, ready to serialise."""
    returns, market = portfolio.returns, portfolio.market
    drawdown = risk.max_drawdown(portfolio.growth)
    benchmark_growth = risk.growth_curve(market)
    underwater = risk.drawdown_series(portfolio.growth)
    keep = _sample_indices(
        len(portfolio.dates), 3, [drawdown.peak, drawdown.trough, drawdown.recovery]
    )

    def r4(values: np.ndarray, indices: list[int]) -> list[float]:
        return [round(float(values[i]), 4) for i in indices]

    holdings = []
    for index, holding in enumerate(portfolio.holdings):
        series = portfolio.matrix[:, index]
        holdings.append(
            {
                "ticker": holding.ticker,
                "name": UNIVERSE[holding.ticker].name,
                "sector": sector_of(holding.ticker),
                "weight": r6(holding.weight),
                "value": round(holding.weight * portfolio.total_value, 2),
                "annualReturn": r6(risk.annualized_return(series)),
                "volatility": r6(risk.annualized_volatility(series)),
                "beta": r6(portfolio.betas[holding.ticker]),
                "maxDrawdown": r6(risk.max_drawdown(risk.growth_curve(series)).depth),
                "riskShare": r6(portfolio.risk_shares[holding.ticker]),
            }
        )

    # Heatmap order: grouped by sector, biggest sector first, so blocks of related names show.
    sector_rank = {sector: rank for rank, sector in enumerate(portfolio.sectors)}
    order = sorted(
        range(len(portfolio.tickers)),
        key=lambda i: (sector_rank[sector_of(portfolio.tickers[i])], -portfolio.weights[i]),
    )
    correlation = risk.correlation_matrix(portfolio.matrix[:, order])

    simulation = risk.monte_carlo(
        returns, DASHBOARD_HORIZON, DASHBOARD_SIMULATIONS, MONTE_CARLO_SEED
    )
    band_days = _sample_indices(DASHBOARD_HORIZON, 6, [])
    meta = portfolio.data.meta
    return {
        "dataset": {
            "source": str(meta.get("source", "unknown")),
            "synthetic": portfolio.data.synthetic,
            "start": portfolio.dates[0],
            "end": portfolio.dates[-1],
            "tradingDays": len(returns),
        },
        "assumptions": {
            "riskFreeAnnual": risk.RISK_FREE_ANNUAL,
            "tradingDaysPerYear": risk.TRADING_DAYS_PER_YEAR,
            "benchmark": BENCHMARK,
        },
        "totalValue": round(portfolio.total_value, 2),
        "valueAssumed": value_assumed,
        "holdings": holdings,
        "metrics": {
            "annualReturn": r6(risk.annualized_return(returns)),
            "volatility": r6(risk.annualized_volatility(returns)),
            "sharpe": r6(risk.sharpe_ratio(returns)),
            "sortino": r6(risk.sortino_ratio(returns)),
            "beta": r6(risk.beta(returns, market)),
            "maxDrawdown": {
                "depth": r6(drawdown.depth),
                "peakDate": portfolio.dates[drawdown.peak],
                "troughDate": portfolio.dates[drawdown.trough],
                "recoveryDate": None
                if drawdown.recovery is None
                else portfolio.dates[drawdown.recovery],
                "tradingDays": drawdown.trough - drawdown.peak,
            },
            "var95": r6(risk.historical_var(returns, 0.95)),
            "cvar95": r6(risk.historical_cvar(returns, 0.95)),
            "var99": r6(risk.historical_var(returns, 0.99)),
            "cvar99": r6(risk.historical_cvar(returns, 0.99)),
        },
        "benchmark": {
            "annualReturn": r6(risk.annualized_return(market)),
            "volatility": r6(risk.annualized_volatility(market)),
            "sharpe": r6(risk.sharpe_ratio(market)),
            "maxDrawdown": r6(risk.max_drawdown(benchmark_growth).depth),
        },
        "series": {
            "dates": [portfolio.dates[i] for i in keep],
            "portfolio": r4(portfolio.growth, keep),
            "benchmark": r4(benchmark_growth, keep),
            "underwater": r4(underwater, keep),
        },
        "correlation": {
            "tickers": [portfolio.tickers[i] for i in order],
            "matrix": [[round(float(v), 3) for v in row] for row in correlation],
        },
        "sectors": [{"sector": s, "weight": r6(w)} for s, w in portfolio.sectors.items()],
        "monteCarlo": {
            "horizonDays": simulation.horizon_days,
            "simulations": simulation.simulations,
            "percentiles": {f"p{q}": r6(simulation.percentile(q)) for q in risk.BAND_PERCENTILES},
            "probabilityOfLoss": r6(simulation.probability_of_loss),
            "mean": r6(simulation.mean),
            "bandDays": [d + 1 for d in band_days],
            "bands": {
                f"p{q}": r4(simulation.bands[row], band_days)
                for row, q in enumerate(risk.BAND_PERCENTILES)
            },
        },
    }
