"""Holdings validation, the analysis bundle, and the simulated frontier."""

import numpy as np
import pytest

from app import risk
from app.frontier import portfolio_stats, random_weights, simulate_frontier
from app.portfolio import (
    DEFAULT_TOTAL_VALUE,
    MAX_CSV_BYTES,
    MAX_HOLDINGS,
    SAMPLE_TOTAL_VALUE,
    SAMPLE_WEIGHTS,
    HoldingsError,
    Portfolio,
    analyze,
    parse_holdings_csv,
    sample_holdings,
)
from app.prices import load_prices
from app.universe import TICKERS
from tests.helpers import tiny_portfolio


def sample() -> Portfolio:
    return Portfolio(load_prices(), sample_holdings(), SAMPLE_TOTAL_VALUE)


# --- holdings CSV -------------------------------------------------------------------


def test_csv_with_dollar_values_becomes_weights() -> None:
    holdings, total, assumed = parse_holdings_csv(
        'ticker,value\naapl,"$6,000.00"\nMSFT,3000\n\nTLT, 1000 \n'
    )
    assert [(h.ticker, h.weight) for h in holdings] == [
        ("AAPL", pytest.approx(0.6)),
        ("MSFT", pytest.approx(0.3)),
        ("TLT", pytest.approx(0.1)),
    ]
    assert (total, assumed) == (10_000.0, False)


def test_csv_with_weights_is_normalised_and_the_value_is_assumed() -> None:
    holdings, total, assumed = parse_holdings_csv("﻿Symbol,Weight\nNVDA,30%\nKO,45%\nGLD,15%\n")
    assert sum(h.weight for h in holdings) == pytest.approx(1.0)
    assert holdings[0].ticker == "KO" and holdings[0].weight == pytest.approx(0.5)
    assert (total, assumed) == (DEFAULT_TOTAL_VALUE, True)


def test_csv_merges_repeated_tickers() -> None:
    holdings, total, _ = parse_holdings_csv("ticker,value\nAAPL,100\nKO,100\nAAPL,200\n")
    assert {h.ticker: h.weight for h in holdings} == {
        "AAPL": pytest.approx(0.75),
        "KO": pytest.approx(0.25),
    }
    assert total == 400.0


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("", "header row"),
        ("ticker,value\n", "header row"),
        ("name,price\nAAPL,5\nKO,5\n", "ticker"),
        ("ticker,value\nAAPL,abc\nKO,5\n", "Row 2: the amount is not a number"),
        ("ticker,value\nAAPL,5\nKO,-5\n", "Row 3: the amount must be greater than zero"),
        ("ticker,value\nAAPL,5\nKO,nan\n", "Row 3"),
        ("ticker,value\nAAPL,5\nKO\n", "Row 3: a column is missing"),
        ("ticker,value\nAAPL,5\n<script>,5\n", "Row 3: that is not a ticker symbol"),
        ("ticker,value\nAAPL,5\n", "at least 2"),
        ("ticker,value\nAAPL,5\nZZZZ,5\nQQQQ,5\n", "ZZZZ, QQQQ"),
    ],
)
def test_csv_errors_say_what_is_wrong(text: str, message: str) -> None:
    with pytest.raises(HoldingsError, match=message):
        parse_holdings_csv(text)


def test_csv_limits_size_and_rows() -> None:
    with pytest.raises(HoldingsError, match="too large"):
        parse_holdings_csv("ticker,value\n" + "AAPL,1\n" * (MAX_CSV_BYTES // 7))
    rows = "".join(f"{t},1\n" for t in TICKERS[:MAX_HOLDINGS])
    assert len(parse_holdings_csv("ticker,value\n" + rows)[0]) == MAX_HOLDINGS
    with pytest.raises(HoldingsError, match="at most 50"):
        parse_holdings_csv("ticker,value\n" + rows + "SPY,1\n")


def test_sample_portfolio_is_valid() -> None:
    holdings = sample_holdings()
    assert len(holdings) == 12
    assert sum(SAMPLE_WEIGHTS.values()) == pytest.approx(1.0)
    assert sum(h.weight for h in holdings) == pytest.approx(1.0)
    assert holdings[0].ticker == "NVDA"


# --- portfolio context --------------------------------------------------------------


def test_portfolio_series_on_the_tiny_history() -> None:
    portfolio = tiny_portfolio()
    assert portfolio.returns == pytest.approx([0.075, -0.075, 0.075])
    assert portfolio.betas == {"AAPL": pytest.approx(2.0), "TLT": pytest.approx(-0.5)}
    assert portfolio.sectors == {"Fixed Income": 0.5, "Technology": 0.5}
    assert portfolio.series("SPY") == pytest.approx([0.10, -0.10, 0.10])
    with pytest.raises(ValueError):
        portfolio.series("ZZZZ")
    reweighted = portfolio.reweighted({"AAPL": 0.2, "TLT": 0.6, "GLD": 0.0})
    assert {h.ticker: h.weight for h in reweighted.holdings} == {
        "TLT": pytest.approx(0.75),
        "AAPL": pytest.approx(0.25),
    }


# --- analysis bundle ----------------------------------------------------------------


def test_analysis_headline_numbers_come_straight_from_the_engine() -> None:
    portfolio = sample()
    bundle = analyze(portfolio)
    metrics = bundle["metrics"]
    returns = portfolio.returns
    assert metrics["volatility"] == pytest.approx(risk.annualized_volatility(returns), abs=1e-6)
    assert metrics["sharpe"] == pytest.approx(risk.sharpe_ratio(returns), abs=1e-6)
    assert metrics["sortino"] == pytest.approx(risk.sortino_ratio(returns), abs=1e-6)
    assert metrics["beta"] == pytest.approx(risk.beta(returns, portfolio.market), abs=1e-6)
    assert metrics["var95"] == pytest.approx(risk.historical_var(returns, 0.95), abs=1e-6)
    assert metrics["cvar99"] == pytest.approx(risk.historical_cvar(returns, 0.99), abs=1e-6)
    assert metrics["cvar95"] >= metrics["var95"] and metrics["var99"] >= metrics["var95"]
    assert bundle["dataset"]["synthetic"] is True
    assert bundle["dataset"]["tradingDays"] == 1260
    assert bundle["assumptions"] == {
        "riskFreeAnnual": 0.04,
        "tradingDaysPerYear": 252,
        "benchmark": "SPY",
    }
    assert bundle["totalValue"] == 250_000.0


def test_analysis_series_keeps_the_drawdown_turning_points() -> None:
    bundle = analyze(sample())
    series, drawdown = bundle["series"], bundle["metrics"]["maxDrawdown"]
    assert len(series["dates"]) == len(series["portfolio"]) == len(series["underwater"])
    assert len(series["dates"]) < 500  # downsampled for the chart
    assert series["portfolio"][0] == 1.0 and series["underwater"][0] == 0.0
    trough = series["dates"].index(drawdown["troughDate"])
    assert series["underwater"][trough] == pytest.approx(drawdown["depth"], abs=1e-4)
    assert min(series["underwater"]) == series["underwater"][trough]
    assert drawdown["peakDate"] in series["dates"]
    assert drawdown["recoveryDate"] in series["dates"]
    assert drawdown["peakDate"] < drawdown["troughDate"] < drawdown["recoveryDate"]


def test_analysis_tables_are_consistent() -> None:
    bundle = analyze(sample())
    holdings = bundle["holdings"]
    assert sum(h["weight"] for h in holdings) == pytest.approx(1.0)
    assert sum(h["value"] for h in holdings) == pytest.approx(250_000.0)
    assert sum(h["riskShare"] for h in holdings) == pytest.approx(1.0, abs=1e-5)
    assert sum(s["weight"] for s in bundle["sectors"]) == pytest.approx(1.0)
    assert bundle["sectors"][0] == {"sector": "Technology", "weight": 0.38}

    correlation = bundle["correlation"]
    matrix = np.array(correlation["matrix"])
    assert sorted(correlation["tickers"]) == sorted(h["ticker"] for h in holdings)
    assert correlation["tickers"][:3] == ["NVDA", "AAPL", "MSFT"]  # grouped by sector
    assert np.allclose(matrix, matrix.T) and np.allclose(np.diag(matrix), 1.0)
    assert np.all(np.abs(matrix) <= 1.0)

    simulation = bundle["monteCarlo"]
    values = list(simulation["percentiles"].values())
    assert values == sorted(values)
    assert len(simulation["bandDays"]) == len(simulation["bands"]["p50"])
    assert simulation["bandDays"][-1] == simulation["horizonDays"] == 252
    assert simulation["bands"]["p50"][-1] == pytest.approx(
        simulation["percentiles"]["p50"], abs=1e-4
    )


# --- frontier -----------------------------------------------------------------------


def test_random_weights_are_long_only_and_sum_to_one() -> None:
    weights = random_weights(500, 12, np.random.default_rng(0))
    assert weights.shape == (500, 12)
    assert np.all(weights >= 0)
    assert np.allclose(weights.sum(axis=1), 1.0)
    assert weights.max() > 0.8  # some mixes are nearly a single holding
    held = (weights > 0).sum(axis=1)
    assert held.min() >= 2 and held.max() == 12  # subsets of every size, never a lone asset
    assert len(set(held.tolist())) > 6


def test_vectorised_stats_agree_with_the_scalar_engine() -> None:
    portfolio = sample()
    rng = np.random.default_rng(1)
    weights = random_weights(5, len(portfolio.tickers), rng)
    stats = portfolio_stats(portfolio.matrix, weights)
    for row, mix in zip(stats, weights, strict=True):
        returns = risk.portfolio_returns(portfolio.matrix, mix)
        assert row[0] == pytest.approx(risk.annualized_volatility(returns))
        assert row[1] == pytest.approx(risk.annualized_return(returns))
        assert row[2] == pytest.approx(risk.sharpe_ratio(returns))
        assert row[3] == pytest.approx(risk.max_drawdown(risk.growth_curve(returns)).depth)


def test_frontier_highlights_match_the_cloud_and_the_headline_numbers() -> None:
    portfolio = sample()
    frontier = simulate_frontier(portfolio, count=400)
    points = np.array(frontier["points"])
    assert points.shape == (400, 4)
    assert frontier["maxSharpe"]["sharpe"] == pytest.approx(points[:, 2].max())
    assert frontier["minVolatility"]["volatility"] == pytest.approx(points[:, 0].min())
    metrics = analyze(portfolio)["metrics"]
    assert frontier["current"]["volatility"] == pytest.approx(metrics["volatility"], abs=1e-4)
    assert frontier["current"]["annualReturn"] == pytest.approx(metrics["annualReturn"], abs=1e-4)
    assert frontier["current"]["sharpe"] == pytest.approx(metrics["sharpe"], abs=1e-4)
    assert frontier["current"]["maxDrawdown"] == pytest.approx(
        metrics["maxDrawdown"]["depth"], abs=1e-4
    )
    assert frontier == simulate_frontier(portfolio, count=400)  # seeded
