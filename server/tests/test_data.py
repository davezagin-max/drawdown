"""The bundled price history: marked synthetic, reproducible, and shaped like a real market."""

import json

import numpy as np

from app import risk
from app.prices import BUNDLED, load_prices
from app.synthetic import PARAMS, SEED, TRADING_DAYS, generate_prices
from app.universe import BENCHMARK, SECTORS, TICKERS, UNIVERSE


def test_universe_has_about_fifty_tickers_and_a_benchmark() -> None:
    assert len(TICKERS) == 52
    assert BENCHMARK in UNIVERSE
    assert "Benchmark" not in SECTORS
    assert set(PARAMS) == set(TICKERS) - {BENCHMARK}


def test_bundled_prices_are_marked_synthetic() -> None:
    data = load_prices()
    meta = json.loads(BUNDLED.with_suffix(".meta.json").read_text())
    assert data.synthetic
    assert meta["source"] == "synthetic"
    assert meta["seed"] == SEED
    assert data.prices.shape == (TRADING_DAYS + 1, len(TICKERS))
    assert list(data.prices.columns) == TICKERS
    assert not data.prices.isna().any().any()
    assert (data.prices > 0).all().all()
    assert data.prices.index.is_monotonic_increasing


def test_generator_is_deterministic_and_matches_the_bundled_file() -> None:
    first = generate_prices()
    assert first.equals(generate_prices())
    assert not first.equals(generate_prices(seed=SEED + 1))
    # A cent of slack: math libraries may differ in the last bit across platforms.
    assert np.allclose(first.to_numpy(), load_prices().prices.to_numpy(), atol=0.011)


def test_simulated_market_has_realistic_structure() -> None:
    prices = load_prices().prices
    returns = {t: risk.simple_returns(prices[t].to_numpy()) for t in TICKERS}
    market = returns[BENCHMARK]

    def beta(ticker: str) -> float:
        return risk.beta(returns[ticker], market)

    # Betas land near what the model was asked for.
    assert beta("NVDA") > 1.4 and beta("TSLA") > 1.5
    assert beta("KO") < 0.8 and beta("DUK") < 0.7
    assert beta("TLT") < 0
    # Same-sector names move together more than cross-sector ones.
    table = np.column_stack([returns[t] for t in ("XOM", "CVX", "PG")])
    corr = risk.correlation_matrix(table)
    assert corr[0, 1] > corr[0, 2]
    # The benchmark has equity-like risk and went through at least one real drawdown.
    assert 0.10 < risk.annualized_volatility(market) < 0.25
    assert risk.max_drawdown(prices[BENCHMARK].to_numpy()).depth < -0.15
    # Fat tails: far more extreme days than a normal distribution would give.
    z = (market - market.mean()) / market.std()
    assert float(np.mean(z**4)) > 3.5
