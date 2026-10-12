"""The four analyst tools, on a price history small enough to check by hand."""

import math

import pytest

from app.claude_client import strict_tool
from app.tools import (
    METRICS,
    TOOLS,
    build_handlers,
    get_metric,
    monte_carlo,
    rebalance_to_target,
    run_stress_test,
)
from app.universe import SECTORS, TICKERS
from tests.helpers import tiny_portfolio


def metric(name: str, subject: str = "PORTFOLIO") -> dict:
    return get_metric(tiny_portfolio(), {"metric": name, "subject": subject})


def test_tool_schemas_are_strict_and_within_the_api_limits() -> None:
    assert [t["name"] for t in TOOLS] == [
        "get_metric",
        "run_stress_test",
        "rebalance_to_target",
        "monte_carlo",
    ]
    for tool in TOOLS:
        schema = tool["input_schema"]
        assert tool["strict"] is True
        assert schema["additionalProperties"] is False
        assert schema["required"] == list(schema["properties"])
        text = str(schema)
        for banned in ("minimum", "maximum", "minLength", "maxLength", "minItems", "$ref"):
            assert banned not in text
    subjects = TOOLS[0]["input_schema"]["properties"]["subject"]["enum"]
    assert subjects == ["PORTFOLIO", *TICKERS]
    assert TOOLS[1]["input_schema"]["properties"]["sector"]["enum"] == ["NONE", *SECTORS]
    assert TOOLS[0] == strict_tool("get_metric", TOOLS[0]["description"], schema_of(TOOLS[0]))


def schema_of(tool: dict) -> dict:
    return tool["input_schema"]["properties"]


def test_get_metric_scalars() -> None:
    # Portfolio returns are +7.5%, -7.5%, +7.5%: mean 2.5%, squared deviations sum to 0.015,
    # sample variance 0.0075, daily std 0.0866025, annualised 1.374773.
    assert metric("volatility")["value"] == pytest.approx(math.sqrt(0.0075 * 252), abs=1e-6)
    assert metric("volatility")["trading_days_per_year"] == 252
    assert metric("beta")["value"] == pytest.approx(0.75)  # 0.5 * 2 + 0.5 * -0.5
    assert metric("beta", "AAPL")["value"] == pytest.approx(2.0)
    assert metric("beta", "TLT")["value"] == pytest.approx(-0.5)
    assert metric("beta", "SPY")["value"] == pytest.approx(1.0)
    # Total growth 1.075 * 0.925 * 1.075 = 1.068953125 over 3 days, annualised (252 / 3 = 84).
    assert metric("annual_return")["value"] == pytest.approx(1.068953125**84 - 1, rel=1e-6)
    assert metric("sharpe")["risk_free_rate"] == 0.04


def test_get_metric_max_drawdown_reports_dates() -> None:
    result = metric("max_drawdown")
    # 1.075 -> 0.994375 is a fall of 7.5%, from day 2 to day 3, recovered... never (1.0690 < 1.075)
    assert result["value"] == pytest.approx(-0.075)
    assert (result["peak_date"], result["trough_date"]) == ("2024-01-02", "2024-01-03")
    assert result["recovery_date"] is None
    assert result["trading_days_peak_to_trough"] == 1


def test_get_metric_var_carries_confidence_horizon_and_dollars() -> None:
    result = metric("var_95")
    # Sorted returns: -7.5%, +7.5%, +7.5%. Position 2 * 0.05 = 0.1 -> -7.5% + 0.1 * 15% = -6%
    assert result["value"] == pytest.approx(0.06)
    assert result["confidence"] == 0.95
    assert result["horizon_days"] == 1
    assert result["loss_usd"] == pytest.approx(60.0)  # 6% of $1,000
    assert metric("cvar_95")["value"] == pytest.approx(0.075)
    assert metric("var_99")["confidence"] == 0.99
    assert "loss_usd" not in metric("var_95", "AAPL")  # dollars only make sense for the portfolio


def test_get_metric_portfolio_views() -> None:
    holdings = metric("holdings")
    assert holdings["count"] == 2
    assert holdings["total_value_usd"] == 1000.0
    assert [p["value_usd"] for p in holdings["positions"]] == [500.0, 500.0]
    sectors = metric("sector_exposure")["sectors"]
    assert {s["sector"]: s["weight"] for s in sectors} == {"Technology": 0.5, "Fixed Income": 0.5}
    shares = metric("risk_contribution")["positions"]
    assert sum(p["risk_share"] for p in shares) == pytest.approx(1.0)
    assert shares[0]["ticker"] == "AAPL"  # the volatile half carries the risk
    assert shares[0]["risk_share"] > 1.0 and shares[1]["risk_share"] < 0  # TLT hedges
    correlation = metric("correlation")
    assert correlation["average_pairwise"] == pytest.approx(-1.0)
    assert correlation["lowest"]["pair"] == ["AAPL", "TLT"]
    with_holdings = metric("correlation", "SPY")["with_holdings"]
    assert {c["ticker"]: c["value"] for c in with_holdings} == {
        "AAPL": pytest.approx(1.0),
        "TLT": pytest.approx(-1.0),
    }


def test_get_metric_rejects_bad_requests() -> None:
    with pytest.raises(ValueError, match="Unknown metric"):
        metric("alpha")
    with pytest.raises(ValueError, match="Unknown subject"):
        metric("beta", "ZZZZ")
    with pytest.raises(ValueError, match="whole portfolio"):
        metric("holdings", "AAPL")
    with pytest.raises(ValueError, match="must be text"):
        get_metric(tiny_portfolio(), {"metric": 5, "subject": "PORTFOLIO"})


def stress(market: float, sector: str = "NONE", extra: float = 0.0) -> dict:
    return run_stress_test(
        tiny_portfolio(),
        {"market_shock_pct": market, "sector": sector, "sector_shock_pct": extra},
    )


def test_stress_test_scales_each_holding_by_its_beta() -> None:
    result = stress(-20)
    # AAPL: 2 * -20% = -40%. TLT: -0.5 * -20% = +10%. Portfolio: half of each = -15%.
    assert result["portfolio_change"] == pytest.approx(-0.15)
    assert result["portfolio_change_usd"] == pytest.approx(-150.0)
    assert result["portfolio_value_after_usd"] == pytest.approx(850.0)
    assert [(p["ticker"], p["change"]) for p in result["positions"]] == [
        ("AAPL", pytest.approx(-0.40)),
        ("TLT", pytest.approx(0.10)),
    ]
    assert result["market_shock_pct"] == -20  # inputs are echoed for the provenance checker


def test_stress_test_adds_the_sector_shock_and_caps_losses_at_everything() -> None:
    result = stress(-20, "Technology", -10)
    # AAPL: -40% - 10% = -50%. Portfolio: 0.5 * -50% + 0.5 * +10% = -20%.
    assert result["portfolio_change"] == pytest.approx(-0.20)
    assert result["sector_weight"] == 0.5
    assert stress(-20, "Energy", -30)["portfolio_change"] == pytest.approx(-0.15)  # none held
    wipeout = stress(-60)
    assert wipeout["positions"][0]["change"] == -1.0  # 2 * -60% is capped at -100%
    assert wipeout["positions"][0]["change_usd"] == -500.0


def test_stress_test_validates_inputs() -> None:
    with pytest.raises(ValueError, match="between -90 and 90"):
        stress(-95)
    with pytest.raises(ValueError, match="Unknown sector"):
        stress(-10, "Crypto", -10)
    with pytest.raises(ValueError, match="needs a sector"):
        stress(-10, "NONE", -5)
    with pytest.raises(ValueError, match="must be a number"):
        run_stress_test(
            tiny_portfolio(),
            {"market_shock_pct": "-20", "sector": "NONE", "sector_shock_pct": 0},
        )


def rebalance(scope: str, name: str, target: float) -> dict:
    return rebalance_to_target(
        tiny_portfolio(), {"scope": scope, "name": name, "target_weight_pct": target}
    )


def test_rebalance_reports_risk_before_after_and_the_difference() -> None:
    result = rebalance("sector", "technology", 40)
    assert result["name"] == "Technology"
    assert result["current_weight_pct"] == 50.0
    assert {w["ticker"]: w["weight"] for w in result["weights_after"]} == {"TLT": 0.6, "AAPL": 0.4}
    # After: 0.4 * 20% - 0.6 * 5% = 5% a day in size, two thirds of the 7.5% before.
    assert result["before"]["volatility"] == pytest.approx(1.374773, abs=1e-6)
    assert result["after"]["volatility"] == pytest.approx(1.374773 * 2 / 3, abs=1e-6)
    assert result["after"]["beta"] == pytest.approx(0.5)  # 0.4 * 2 + 0.6 * -0.5
    assert result["after"]["max_drawdown"] == pytest.approx(-0.05)
    assert result["change"]["beta"] == pytest.approx(-0.25)
    assert result["change"]["max_drawdown"] == pytest.approx(0.025)
    assert result["turnover"] == pytest.approx(0.1)  # 10% of the money changes hands
    assert result["turnover_usd"] == pytest.approx(100.0)
    assert set(result["before"]) == {"volatility", "max_drawdown", "beta", "var_95", "cvar_95"}
    assert "annual_return" not in str(result)  # risk numbers only, nothing to chase


def test_rebalance_can_add_a_new_ticker_and_scales_the_rest() -> None:
    result = rebalance("ticker", "gld", 20)
    weights = {w["ticker"]: w["weight"] for w in result["weights_after"]}
    assert weights == {"AAPL": 0.4, "TLT": 0.4, "GLD": 0.2}
    assert result["current_weight_pct"] == 0.0
    assert result["turnover"] == pytest.approx(0.2)


def test_rebalance_handles_the_edges() -> None:
    assert [w["ticker"] for w in rebalance("ticker", "AAPL", 0)["weights_after"]] == ["TLT"]
    assert [w["ticker"] for w in rebalance("ticker", "AAPL", 100)["weights_after"]] == ["AAPL"]
    hedged = rebalance("sector", "Technology", 20)  # 0.2 * 20% - 0.8 * 5% = 0: no risk left
    assert hedged["after"] == {
        "volatility": 0.0,
        "max_drawdown": 0.0,
        "beta": 0.0,
        "var_95": 0.0,
        "cvar_95": 0.0,
    }
    with pytest.raises(ValueError, match="holds nothing in Energy"):
        rebalance("sector", "Energy", 10)
    with pytest.raises(ValueError, match="Unknown sector"):
        rebalance("sector", "Crypto", 10)
    with pytest.raises(ValueError, match="Unknown ticker"):
        rebalance("ticker", "ZZZZ", 10)
    with pytest.raises(ValueError, match="between 0 and 100"):
        rebalance("ticker", "AAPL", 120)
    with pytest.raises(ValueError, match="scope must be"):
        rebalance("fund", "AAPL", 10)


def test_monte_carlo_tool_reports_returns_and_dollars() -> None:
    result = monte_carlo(tiny_portfolio(), {"horizon_days": 10, "simulations": 500})
    assert (result["horizon_days"], result["simulations"]) == (10, 500)
    percentiles = result["return_percentiles"]
    assert list(percentiles) == ["p5", "p25", "p50", "p75", "p95"]
    assert list(percentiles.values()) == sorted(percentiles.values())
    for key, value in percentiles.items():
        assert result["value_usd_percentiles"][key] == pytest.approx(1000 * (1 + value), abs=0.01)
    assert 0 <= result["probability_of_loss"] <= 1
    assert result == monte_carlo(tiny_portfolio(), {"horizon_days": 10, "simulations": 500})
    assert "seed" not in result  # no incidental numbers for prose to match by accident


def test_monte_carlo_tool_enforces_the_limits_the_schema_cannot() -> None:
    portfolio = tiny_portfolio()
    with pytest.raises(ValueError, match="between 1 and 504"):
        monte_carlo(portfolio, {"horizon_days": 5000, "simulations": 500})
    with pytest.raises(ValueError, match="between 100 and 10000"):
        monte_carlo(portfolio, {"horizon_days": 10, "simulations": 5})
    with pytest.raises(ValueError, match="too much to simulate"):
        monte_carlo(portfolio, {"horizon_days": 504, "simulations": 10_000})
    with pytest.raises(ValueError, match="whole number"):
        monte_carlo(portfolio, {"horizon_days": 10.5, "simulations": 500})
    with pytest.raises(ValueError, match="whole number"):
        monte_carlo(portfolio, {"horizon_days": True, "simulations": 500})


def test_handlers_cover_every_tool() -> None:
    handlers = build_handlers(tiny_portfolio())
    assert set(handlers) == {t["name"] for t in TOOLS}
    assert handlers["get_metric"]({"metric": "beta", "subject": "PORTFOLIO"})["value"] == 0.75
    assert len(METRICS) == 14
