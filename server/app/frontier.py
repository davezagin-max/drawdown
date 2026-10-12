"""The simulated frontier: thousands of random long-only mixes of the same holdings.

Each mix gets the same realised statistics as the real portfolio (same functions, same
history), so the highlighted "current" point agrees with the headline numbers exactly.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from . import risk
from .portfolio import Portfolio

FRONTIER_SEED = 11
DEFAULT_POINTS = 3000
# Dirichlet concentration: small values give lopsided mixes, large ones near-equal mixes.
CONCENTRATIONS = (0.3, 1.0, 3.0)


def random_weights(count: int, assets: int, rng: np.random.Generator) -> np.ndarray:
    """`count` long-only weight vectors that each sum to 1.

    Each mix holds a random subset of the assets (two or more of them, when there are
    that many), weighted by a Dirichlet draw. Mixing subset sizes and concentrations
    spreads the cloud from near-single-holding corners to the diversified middle.
    Weighting all the assets every time would bunch every point around the average.
    """
    alpha = rng.choice(CONCENTRATIONS, size=(count, 1))
    draws = rng.gamma(shape=np.broadcast_to(alpha, (count, assets)))
    held = rng.integers(min(2, assets), assets + 1, size=(count, 1))
    order = rng.random((count, assets)).argsort(axis=1).argsort(axis=1)  # a random ranking per mix
    draws = np.where(order < held, draws, 0.0)
    totals = draws.sum(axis=1, keepdims=True)
    return np.where(totals > 0, draws / np.where(totals > 0, totals, 1.0), 1.0 / assets)


def portfolio_stats(matrix: np.ndarray, weights: np.ndarray) -> np.ndarray:
    """Volatility, annual return, Sharpe, and max drawdown for many mixes at once.

    `matrix` is days x assets, `weights` is mixes x assets. Returns mixes x 4.
    The formulas are the ones in `risk`, written across a whole table at a time.
    """
    daily = matrix @ weights.T  # days x mixes
    days = daily.shape[0]
    growth = np.cumprod(1.0 + daily, axis=0)
    spread = daily.std(axis=0, ddof=1)
    volatility = spread * np.sqrt(risk.TRADING_DAYS_PER_YEAR)
    annual = growth[-1] ** (risk.TRADING_DAYS_PER_YEAR / days) - 1.0
    excess = daily.mean(axis=0) - risk.RISK_FREE_ANNUAL / risk.TRADING_DAYS_PER_YEAR
    sharpe = np.divide(excess, spread, out=np.zeros_like(excess), where=spread > 0) * np.sqrt(
        risk.TRADING_DAYS_PER_YEAR
    )
    curve = np.vstack([np.ones(daily.shape[1]), growth])
    drawdown = (curve / np.maximum.accumulate(curve, axis=0) - 1.0).min(axis=0)
    return np.column_stack([volatility, annual, sharpe, drawdown])


def simulate_frontier(portfolio: Portfolio, count: int = DEFAULT_POINTS) -> dict[str, Any]:
    """The point cloud plus the three highlighted mixes."""
    rng = np.random.default_rng(FRONTIER_SEED)
    weights = random_weights(count, len(portfolio.tickers), rng)
    stats = portfolio_stats(portfolio.matrix, weights)
    current = portfolio_stats(portfolio.matrix, portfolio.weights[None, :])[0]

    def point(row: np.ndarray) -> dict[str, float]:
        return {
            "volatility": round(float(row[0]), 4),
            "annualReturn": round(float(row[1]), 4),
            "sharpe": round(float(row[2]), 4),
            "maxDrawdown": round(float(row[3]), 4),
        }

    return {
        "count": count,
        # [volatility, annual return, Sharpe, max drawdown] per simulated mix
        "points": [[round(float(v), 4) for v in row] for row in stats],
        "current": point(current),
        "maxSharpe": point(stats[int(np.argmax(stats[:, 2]))]),
        "minVolatility": point(stats[int(np.argmin(stats[:, 0]))]),
    }
