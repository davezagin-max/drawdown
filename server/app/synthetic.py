"""Simulated price history from a seeded factor model.

Why simulated: free market-data sources generally forbid redistribution, so real prices
cannot be committed to a public repository. This model produces five years of daily
prices whose correlations, betas, and sector structure behave like a real equity
universe, which is all the risk engine needs to be demonstrated honestly.

Each security's daily return is

    r = alpha + beta * market + sector_factor + idiosyncratic

- `market` has fat tails (Student-t, 5 degrees of freedom) and passes through regimes:
  a slow bear market, a sharp crash, and the rebound after it.
- Each sector has its own factor with regime-dependent drift, so defensive sectors and
  energy hold up in the slow bear while technology falls further.
- Idiosyncratic noise is Student-t with 4 degrees of freedom.

The benchmark (SPY) is the market factor plus a little tracking noise.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .universe import BENCHMARK, SECTORS, TICKERS, sector_of

SEED = 20261011
TRADING_DAYS = 1260  # five years of 252 trading days
END_DATE = "2026-10-09"


@dataclass(frozen=True)
class Regime:
    name: str
    start: int  # first day index (inclusive)
    end: int  # last day index (exclusive)
    drift: float  # market drift per day
    vol_scale: float


REGIMES: list[Regime] = [
    Regime("calm", 0, 60, 0.0005, 1.0),
    Regime("slow bear", 60, 250, -0.0011, 1.35),
    Regime("recovery", 250, 820, 0.0006, 1.0),
    Regime("crash", 820, 845, -0.0060, 2.4),
    Regime("rebound", 845, 900, 0.0024, 1.6),
    Regime("calm", 900, TRADING_DAYS, 0.0004, 1.0),
]

MARKET_VOL = 0.0088  # daily, about 14% a year
SECTOR_VOL = 0.0050  # daily

# Extra sector drift per day, by regime name. Anything not listed is zero.
SECTOR_DRIFT: dict[str, dict[str, float]] = {
    "Technology": {"calm": 0.0001, "recovery": 0.0001, "slow bear": -0.0006},
    "Communication": {"slow bear": -0.0004, "recovery": 0.0001},
    "Consumer Discretionary": {"slow bear": -0.0004},
    "Consumer Staples": {"slow bear": 0.0004},
    "Health Care": {"slow bear": 0.0004},
    "Utilities": {"slow bear": 0.0003, "crash": 0.0010},
    "Energy": {"slow bear": 0.0016, "recovery": -0.0001, "crash": -0.0030},
    "Financials": {"crash": -0.0020, "rebound": 0.0008},
    "Fixed Income": {"slow bear": -0.0009, "crash": 0.0030, "recovery": 0.0001},
    "Commodities": {"calm": 0.0003, "recovery": 0.0003, "crash": 0.0015},
}

# ticker: (market beta, idiosyncratic vol per year, alpha per year, starting price)
PARAMS: dict[str, tuple[float, float, float, float]] = {
    "AAPL": (1.20, 0.17, -0.02, 142.0),
    "MSFT": (1.10, 0.15, -0.02, 295.0),
    "NVDA": (1.75, 0.34, 0.10, 21.0),
    "AVGO": (1.35, 0.24, 0.12, 49.0),
    "ORCL": (1.00, 0.21, 0.06, 95.0),
    "CRM": (1.30, 0.25, -0.03, 285.0),
    "ADBE": (1.30, 0.24, -0.06, 580.0),
    "AMD": (1.70, 0.34, 0.02, 105.0),
    "CSCO": (0.90, 0.16, -0.01, 55.0),
    "GOOGL": (1.15, 0.19, 0.00, 138.0),
    "META": (1.35, 0.30, 0.08, 325.0),
    "NFLX": (1.30, 0.33, 0.06, 630.0),
    "DIS": (1.15, 0.22, -0.09, 176.0),
    "VZ": (0.45, 0.16, -0.05, 53.0),
    "AMZN": (1.30, 0.22, -0.06, 164.0),
    "TSLA": (1.95, 0.44, 0.02, 265.0),
    "HD": (1.00, 0.17, 0.01, 335.0),
    "MCD": (0.60, 0.13, 0.03, 245.0),
    "NKE": (1.05, 0.23, -0.12, 155.0),
    "PG": (0.45, 0.12, 0.02, 141.0),
    "KO": (0.55, 0.11, 0.02, 54.0),
    "PEP": (0.55, 0.12, 0.00, 158.0),
    "WMT": (0.50, 0.14, 0.09, 46.0),
    "COST": (0.80, 0.16, 0.10, 450.0),
    "JNJ": (0.50, 0.12, -0.01, 160.0),
    "UNH": (0.70, 0.19, -0.06, 400.0),
    "LLY": (0.60, 0.25, 0.22, 235.0),
    "PFE": (0.60, 0.19, -0.12, 42.0),
    "MRK": (0.45, 0.16, 0.03, 80.0),
    "ABBV": (0.55, 0.17, 0.08, 109.0),
    "JPM": (1.10, 0.17, 0.07, 166.0),
    "BAC": (1.30, 0.20, 0.00, 44.0),
    "GS": (1.30, 0.19, 0.07, 390.0),
    "MS": (1.35, 0.20, 0.04, 99.0),
    "V": (0.95, 0.14, 0.03, 225.0),
    "MA": (1.05, 0.15, 0.04, 355.0),
    "CAT": (1.05, 0.21, 0.09, 195.0),
    "BA": (1.40, 0.30, -0.10, 225.0),
    "HON": (0.95, 0.14, -0.02, 218.0),
    "UPS": (0.95, 0.19, -0.12, 190.0),
    "GE": (1.15, 0.22, 0.16, 82.0),
    "XOM": (0.80, 0.19, -0.02, 61.0),
    "CVX": (0.85, 0.19, 0.00, 108.0),
    "COP": (0.95, 0.24, 0.02, 71.0),
    "NEE": (0.55, 0.19, -0.05, 82.0),
    "DUK": (0.40, 0.13, 0.00, 99.0),
    "AMT": (0.75, 0.20, -0.08, 265.0),
    "PLD": (1.00, 0.20, -0.04, 127.0),
    "LIN": (0.85, 0.14, 0.04, 300.0),
    "TLT": (-0.20, 0.07, -0.05, 144.0),
    "GLD": (0.05, 0.11, 0.05, 165.0),
}


def _fat_tailed(rng: np.random.Generator, df: int, size: int) -> np.ndarray:
    """Student-t draws rescaled to unit variance."""
    return rng.standard_t(df, size=size) * np.sqrt((df - 2) / df)


def generate_prices(seed: int = SEED) -> pd.DataFrame:
    """Daily closing prices for the whole universe, one column per ticker, rounded to cents."""
    rng = np.random.default_rng(seed)
    days = TRADING_DAYS
    regime_of = np.empty(days, dtype=object)
    drift = np.empty(days)
    vol_scale = np.empty(days)
    for regime in REGIMES:
        regime_of[regime.start : regime.end] = regime.name
        drift[regime.start : regime.end] = regime.drift
        vol_scale[regime.start : regime.end] = regime.vol_scale

    market = drift + MARKET_VOL * vol_scale * _fat_tailed(rng, 5, days)

    sector_factor: dict[str, np.ndarray] = {}
    for sector in SECTORS:
        extra = np.array([SECTOR_DRIFT.get(sector, {}).get(name, 0.0) for name in regime_of])
        sector_factor[sector] = extra + SECTOR_VOL * np.sqrt(vol_scale) * _fat_tailed(rng, 5, days)

    # One row more than `days` returns: the first row is the starting price.
    dates = pd.bdate_range(end=END_DATE, periods=days + 1, name="date")
    columns: dict[str, np.ndarray] = {}
    for ticker in TICKERS:
        if ticker == BENCHMARK:
            returns = market + 0.0004 * rng.standard_normal(days)
            start = 436.0
        else:
            beta, idio_annual, alpha_annual, start = PARAMS[ticker]
            idio = idio_annual / np.sqrt(252) * _fat_tailed(rng, 4, days)
            returns = alpha_annual / 252 + beta * market + sector_factor[sector_of(ticker)] + idio
        returns = np.clip(returns, -0.25, 0.25)
        path = start * np.concatenate([[1.0], np.cumprod(1.0 + returns)])
        columns[ticker] = np.round(path, 2)
    return pd.DataFrame(columns, index=dates)
