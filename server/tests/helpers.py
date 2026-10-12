"""A four-day price history small enough to work every number out by hand."""

from __future__ import annotations

import pandas as pd

from app.portfolio import Holding, Portfolio
from app.prices import PriceData

# Daily returns:  SPY +10%, -10%, +10%
#                 AAPL is exactly twice SPY  (+20%, -20%, +20%)  -> beta 2
#                 TLT is minus half of SPY   (-5%, +5%, -5%)     -> beta -0.5
#                 GLD does not move with SPY (+1%, 0%, +1%)
TINY_PRICES = pd.DataFrame(
    {
        "SPY": [100.0, 110.0, 99.0, 108.9],
        "AAPL": [100.0, 120.0, 96.0, 115.2],
        "TLT": [100.0, 95.0, 99.75, 94.7625],
        "GLD": [50.0, 50.5, 50.5, 51.005],
    },
    index=pd.to_datetime(["2024-01-01", "2024-01-02", "2024-01-03", "2024-01-04"]),
)


def tiny_portfolio(total_value: float = 1000.0) -> Portfolio:
    """Half AAPL, half TLT: daily returns +7.5%, -7.5%, +7.5%."""
    data = PriceData(prices=TINY_PRICES, meta={"source": "test"})
    return Portfolio(data, [Holding("AAPL", 0.5), Holding("TLT", 0.5)], total_value)
