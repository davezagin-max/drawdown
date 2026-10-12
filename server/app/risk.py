"""Risk engine: pure functions over price and return series.

Every function takes plain numpy arrays and returns plain numbers, so each can be
checked by hand on a tiny input (see tests/test_risk.py).

Conventions, stated once and used everywhere:

- Returns are simple daily returns, r_t = P_t / P_(t-1) - 1, unless a name says "log".
- A year is 252 trading days. Volatility annualises by sqrt(252).
- Variance, volatility, and covariance use the sample estimator (divide by n - 1).
- Annual return is geometric (CAGR): prod(1 + r) ** (252 / n) - 1.
- The risk-free rate is a constant 4% a year, earned evenly: 0.04 / 252 per day.
- Sharpe  = mean(r - rf) / std(r) * sqrt(252).
- Sortino = mean(r - rf) / downside deviation * sqrt(252), where downside deviation is
  sqrt(mean(min(r - rf, 0) ** 2)) taken over ALL days, not only the losing ones.
- Drawdown is a negative fraction: value / running peak - 1. Max drawdown is its minimum.
- VaR and CVaR are one-day figures reported as POSITIVE loss fractions.
  VaR(95%) is minus the 5th percentile of daily returns, interpolating linearly between
  the two nearest observations. CVaR(95%) is minus the mean of the returns at or below
  that percentile.
- Beta = cov(asset, market) / var(market).
- A portfolio's daily return is the weighted sum of its holdings' returns with the
  weights held fixed, which means it is rebalanced back to target every day.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

TRADING_DAYS_PER_YEAR = 252
RISK_FREE_ANNUAL = 0.04

Array = np.ndarray


def _series(values: Array | list[float], minimum: int, what: str) -> Array:
    array = np.asarray(values, dtype=float)
    if array.ndim != 1:
        raise ValueError(f"{what} must be one-dimensional.")
    if array.size < minimum:
        raise ValueError(f"{what} needs at least {minimum} observations.")
    if not np.all(np.isfinite(array)):
        raise ValueError(f"{what} contains a missing or infinite value.")
    return array


def simple_returns(prices: Array | list[float]) -> Array:
    """r_t = P_t / P_(t-1) - 1. One fewer element than `prices`."""
    p = _series(prices, 2, "prices")
    if np.any(p <= 0):
        raise ValueError("prices must be positive.")
    return p[1:] / p[:-1] - 1.0


def log_returns(prices: Array | list[float]) -> Array:
    """ln(P_t / P_(t-1)). Log returns add up across days; simple returns do not."""
    p = _series(prices, 2, "prices")
    if np.any(p <= 0):
        raise ValueError("prices must be positive.")
    return np.log(p[1:] / p[:-1])


def growth_curve(returns: Array | list[float]) -> Array:
    """Value of 1 invested before the first return: [1, 1+r1, (1+r1)(1+r2), ...]."""
    r = _series(returns, 1, "returns")
    return np.concatenate([[1.0], np.cumprod(1.0 + r)])


def annualized_return(returns: Array | list[float]) -> float:
    """Geometric annual growth rate (CAGR)."""
    r = _series(returns, 1, "returns")
    total = float(np.prod(1.0 + r))
    if total <= 0:
        return -1.0
    return total ** (TRADING_DAYS_PER_YEAR / r.size) - 1.0


def annualized_volatility(returns: Array | list[float]) -> float:
    """Sample standard deviation of daily returns, times sqrt(252)."""
    r = _series(returns, 2, "returns")
    return float(np.std(r, ddof=1) * np.sqrt(TRADING_DAYS_PER_YEAR))


def sharpe_ratio(returns: Array | list[float], risk_free_annual: float = RISK_FREE_ANNUAL) -> float:
    """Average daily excess return per unit of daily volatility, annualised."""
    r = _series(returns, 2, "returns")
    spread = float(np.std(r, ddof=1))
    if spread == 0:
        return 0.0
    excess = r - risk_free_annual / TRADING_DAYS_PER_YEAR
    return float(np.mean(excess) / spread * np.sqrt(TRADING_DAYS_PER_YEAR))


def downside_deviation(returns: Array | list[float], target_daily: float = 0.0) -> float:
    """Root mean square of the shortfalls below `target_daily`, over all days (not annualised)."""
    r = _series(returns, 1, "returns")
    shortfall = np.minimum(r - target_daily, 0.0)
    return float(np.sqrt(np.mean(shortfall**2)))


def sortino_ratio(
    returns: Array | list[float], risk_free_annual: float = RISK_FREE_ANNUAL
) -> float:
    """Like Sharpe, but only days below the risk-free rate count as risk."""
    r = _series(returns, 2, "returns")
    target = risk_free_annual / TRADING_DAYS_PER_YEAR
    downside = downside_deviation(r, target)
    if downside == 0:
        return 0.0
    return float(np.mean(r - target) / downside * np.sqrt(TRADING_DAYS_PER_YEAR))


def drawdown_series(values: Array | list[float]) -> Array:
    """How far each value sits below the highest value so far (0 at a new high)."""
    v = _series(values, 1, "values")
    return v / np.maximum.accumulate(v) - 1.0


@dataclass(frozen=True)
class Drawdown:
    depth: float  # negative fraction, 0.0 if the series never falls
    peak: int  # index of the high the fall started from
    trough: int  # index of the lowest point
    recovery: int | None  # first index back at or above the peak, if any


def max_drawdown(values: Array | list[float]) -> Drawdown:
    """The largest peak-to-trough fall in a value series, with where it started and ended."""
    v = _series(values, 1, "values")
    underwater = drawdown_series(v)
    trough = int(np.argmin(underwater))
    peak = int(np.argmax(v[: trough + 1]))  # first time the running high was set
    recovered = np.nonzero(v[trough:] >= v[peak])[0]
    recovery = int(trough + recovered[0]) if trough != peak and recovered.size else None
    return Drawdown(float(underwater[trough]), peak, trough, recovery)


def beta(asset_returns: Array | list[float], market_returns: Array | list[float]) -> float:
    """Sensitivity to the market: cov(asset, market) / var(market)."""
    a = _series(asset_returns, 2, "asset returns")
    m = _series(market_returns, 2, "market returns")
    if a.size != m.size:
        raise ValueError("asset and market returns must cover the same days.")
    variance = float(np.var(m, ddof=1))
    if variance == 0:
        raise ValueError("market returns do not vary.")
    covariance = float(np.sum((a - a.mean()) * (m - m.mean())) / (a.size - 1))
    return covariance / variance


def covariance_matrix(returns: Array) -> Array:
    """Sample covariance of daily returns. `returns` is days x assets."""
    matrix = np.asarray(returns, dtype=float)
    if matrix.ndim != 2 or matrix.shape[0] < 2:
        raise ValueError("returns must be a days x assets table with at least 2 days.")
    centered = matrix - matrix.mean(axis=0)
    return centered.T @ centered / (matrix.shape[0] - 1)


def correlation_matrix(returns: Array) -> Array:
    """Pearson correlation between every pair of columns. `returns` is days x assets."""
    covariance = covariance_matrix(returns)
    spread = np.sqrt(np.diag(covariance))
    if np.any(spread == 0):
        raise ValueError("a return series does not vary, so its correlation is undefined.")
    matrix = covariance / np.outer(spread, spread)
    np.fill_diagonal(matrix, 1.0)
    return np.clip(matrix, -1.0, 1.0)


def portfolio_returns(returns: Array, weights: Array | list[float]) -> Array:
    """Daily portfolio return with fixed weights. `returns` is days x assets."""
    matrix = np.asarray(returns, dtype=float)
    w = np.asarray(weights, dtype=float)
    if matrix.ndim != 2 or w.shape != (matrix.shape[1],):
        raise ValueError("need one weight per column of returns.")
    return matrix @ w


def sector_exposure(weights: dict[str, float], sectors: dict[str, str]) -> dict[str, float]:
    """Total weight per sector, largest first."""
    totals: dict[str, float] = {}
    for ticker, weight in weights.items():
        totals[sectors[ticker]] = totals.get(sectors[ticker], 0.0) + weight
    return dict(sorted(totals.items(), key=lambda item: (-item[1], item[0])))


def risk_contributions(covariance: Array, weights: Array | list[float]) -> Array:
    """Each holding's share of portfolio variance: w_i * (Cov w)_i / (w' Cov w). Sums to 1."""
    w = np.asarray(weights, dtype=float)
    marginal = np.asarray(covariance, dtype=float) @ w
    variance = float(w @ marginal)
    if variance <= 0:
        raise ValueError("portfolio variance must be positive.")
    return w * marginal / variance


def historical_var(returns: Array | list[float], confidence: float = 0.95) -> float:
    """One-day value at risk as a positive loss fraction (see the module conventions)."""
    r = _series(returns, 2, "returns")
    if not 0.5 < confidence < 1:
        raise ValueError("confidence must be between 0.5 and 1.")
    # 1 - 0.95 is 0.05000000000000004 in floating point; rounding keeps the percentile on
    # the observation it should land on.
    return float(-np.quantile(r, round(1.0 - confidence, 10)))


def historical_cvar(returns: Array | list[float], confidence: float = 0.95) -> float:
    """Average loss on the days at or beyond the VaR threshold, as a positive fraction."""
    r = _series(returns, 2, "returns")
    threshold = -historical_var(r, confidence)
    # The tolerance keeps a return that equals the threshold in the tail despite rounding.
    return float(-np.mean(r[r <= threshold + 1e-12]))


@dataclass(frozen=True)
class MonteCarlo:
    horizon_days: int
    simulations: int
    terminal: Array  # total return of each simulated path at the horizon
    bands: Array  # 5 x horizon_days: the 5/25/50/75/95th percentile growth by day

    def percentile(self, q: float) -> float:
        return float(np.percentile(self.terminal, q))

    @property
    def probability_of_loss(self) -> float:
        return float(np.mean(self.terminal < 0))

    @property
    def mean(self) -> float:
        return float(np.mean(self.terminal))


BAND_PERCENTILES = (5, 25, 50, 75, 95)


def monte_carlo(
    returns: Array | list[float], horizon_days: int, simulations: int, seed: int
) -> MonteCarlo:
    """Bootstrap simulation: each path draws `horizon_days` historical days with replacement.

    Resampling real days keeps the fat tails of the history without assuming a
    distribution. It does assume days are independent, so it understates how losses
    cluster (see the README's limitations).
    """
    r = _series(returns, 2, "returns")
    if horizon_days < 1 or simulations < 1:
        raise ValueError("horizon_days and simulations must be positive.")
    rng = np.random.default_rng(seed)
    picks = rng.integers(0, r.size, size=(simulations, horizon_days))
    growth = np.cumprod(1.0 + r[picks], axis=1)
    return MonteCarlo(
        horizon_days=horizon_days,
        simulations=simulations,
        terminal=growth[:, -1] - 1.0,
        bands=np.percentile(growth, BAND_PERCENTILES, axis=0) - 1.0,
    )
