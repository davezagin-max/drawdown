"""The ticker universe: symbols, display names, and sectors.

The symbols and sectors are real, and used only as labels. The bundled price history is
simulated (see `app/synthetic.py`), so nothing here describes the real companies.
"""

from __future__ import annotations

from dataclasses import dataclass

BENCHMARK = "SPY"


@dataclass(frozen=True)
class Security:
    ticker: str
    name: str
    sector: str


_ROWS: list[tuple[str, str, str]] = [
    ("AAPL", "Apple", "Technology"),
    ("MSFT", "Microsoft", "Technology"),
    ("NVDA", "Nvidia", "Technology"),
    ("AVGO", "Broadcom", "Technology"),
    ("ORCL", "Oracle", "Technology"),
    ("CRM", "Salesforce", "Technology"),
    ("ADBE", "Adobe", "Technology"),
    ("AMD", "Advanced Micro Devices", "Technology"),
    ("CSCO", "Cisco", "Technology"),
    ("GOOGL", "Alphabet", "Communication"),
    ("META", "Meta Platforms", "Communication"),
    ("NFLX", "Netflix", "Communication"),
    ("DIS", "Walt Disney", "Communication"),
    ("VZ", "Verizon", "Communication"),
    ("AMZN", "Amazon", "Consumer Discretionary"),
    ("TSLA", "Tesla", "Consumer Discretionary"),
    ("HD", "Home Depot", "Consumer Discretionary"),
    ("MCD", "McDonald's", "Consumer Discretionary"),
    ("NKE", "Nike", "Consumer Discretionary"),
    ("PG", "Procter & Gamble", "Consumer Staples"),
    ("KO", "Coca-Cola", "Consumer Staples"),
    ("PEP", "PepsiCo", "Consumer Staples"),
    ("WMT", "Walmart", "Consumer Staples"),
    ("COST", "Costco", "Consumer Staples"),
    ("JNJ", "Johnson & Johnson", "Health Care"),
    ("UNH", "UnitedHealth", "Health Care"),
    ("LLY", "Eli Lilly", "Health Care"),
    ("PFE", "Pfizer", "Health Care"),
    ("MRK", "Merck", "Health Care"),
    ("ABBV", "AbbVie", "Health Care"),
    ("JPM", "JPMorgan Chase", "Financials"),
    ("BAC", "Bank of America", "Financials"),
    ("GS", "Goldman Sachs", "Financials"),
    ("MS", "Morgan Stanley", "Financials"),
    ("V", "Visa", "Financials"),
    ("MA", "Mastercard", "Financials"),
    ("CAT", "Caterpillar", "Industrials"),
    ("BA", "Boeing", "Industrials"),
    ("HON", "Honeywell", "Industrials"),
    ("UPS", "United Parcel Service", "Industrials"),
    ("GE", "GE Aerospace", "Industrials"),
    ("XOM", "Exxon Mobil", "Energy"),
    ("CVX", "Chevron", "Energy"),
    ("COP", "ConocoPhillips", "Energy"),
    ("NEE", "NextEra Energy", "Utilities"),
    ("DUK", "Duke Energy", "Utilities"),
    ("AMT", "American Tower", "Real Estate"),
    ("PLD", "Prologis", "Real Estate"),
    ("LIN", "Linde", "Materials"),
    ("TLT", "20+ Year Treasury Bond ETF", "Fixed Income"),
    ("GLD", "Gold ETF", "Commodities"),
    (BENCHMARK, "S&P 500 ETF", "Benchmark"),
]

UNIVERSE: dict[str, Security] = {t: Security(t, name, sector) for t, name, sector in _ROWS}
TICKERS: list[str] = list(UNIVERSE)
# Sectors a holding can belong to, in display order. The benchmark is not a sector.
SECTORS: list[str] = list(
    dict.fromkeys(s.sector for s in UNIVERSE.values() if s.ticker != BENCHMARK)
)


def sector_of(ticker: str) -> str:
    return UNIVERSE[ticker].sector
