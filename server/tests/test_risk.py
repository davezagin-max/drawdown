"""Every risk metric against a value worked out by hand.

Each test states the arithmetic in a comment so the expected number can be re-derived
with a calculator, independently of the code under test.
"""

import math

import numpy as np
import pytest

from app import risk


def test_simple_returns() -> None:
    # 110/100 - 1 = 0.10, 99/110 - 1 = -0.10, 108.9/99 - 1 = 0.10
    assert risk.simple_returns([100, 110, 99, 108.9]) == pytest.approx([0.10, -0.10, 0.10])


def test_log_returns_add_up_to_the_log_of_the_total_growth() -> None:
    logs = risk.log_returns([100, 110, 99, 108.9])
    assert logs == pytest.approx([math.log(1.1), math.log(0.9), math.log(1.1)])
    assert logs[0] == pytest.approx(0.0953101798)
    assert logs.sum() == pytest.approx(math.log(1.089))


def test_returns_reject_bad_prices() -> None:
    with pytest.raises(ValueError):
        risk.simple_returns([100, 0, 50])
    with pytest.raises(ValueError):
        risk.simple_returns([100])
    with pytest.raises(ValueError):
        risk.log_returns([100, float("nan")])


def test_growth_curve_starts_at_one() -> None:
    assert risk.growth_curve([0.10, -0.10]) == pytest.approx([1.0, 1.10, 0.99])


def test_annualized_return_is_geometric() -> None:
    # Half a year (126 days) that grows 10% in total: 1.1 ** (252/126) - 1 = 0.21
    assert risk.annualized_return([0.10] + [0.0] * 125) == pytest.approx(0.21)
    # Two years (504 days) that grow 44% in total: 1.44 ** 0.5 - 1 = 0.20
    assert risk.annualized_return([0.20, 0.20] + [0.0] * 502) == pytest.approx(0.20)
    # A total loss cannot be annualised past -100%.
    assert risk.annualized_return([-1.0, 0.5]) == -1.0


def test_annualized_volatility_uses_the_sample_estimator_and_252_days() -> None:
    # mean 0; squares sum to 0.002; sample variance 0.002/3; times 252 = 0.168
    returns = [0.01, -0.01, 0.03, -0.03]
    assert risk.annualized_volatility(returns) == pytest.approx(math.sqrt(0.168))
    assert risk.annualized_volatility(returns) == pytest.approx(0.409878, abs=1e-6)


def test_sharpe_ratio() -> None:
    returns = [0.02, 0.00, 0.01, 0.03]
    # mean 0.015; deviations 0.005, -0.015, -0.005, 0.015; squares sum to 0.0005
    # std = sqrt(0.0005/3) = 0.0129099; 0.015 / 0.0129099 * sqrt(252) = 18.4445
    assert risk.sharpe_ratio(returns, risk_free_annual=0.0) == pytest.approx(18.4445, abs=1e-4)
    # With 2.52% a year risk-free (0.0001 a day) the mean excess is 0.0149 -> 18.3216
    assert risk.sharpe_ratio(returns, risk_free_annual=0.0252) == pytest.approx(18.3216, abs=1e-4)
    assert risk.sharpe_ratio([0.01, 0.01, 0.01]) == 0.0  # no volatility: defined as zero


def test_default_risk_free_rate_is_four_percent() -> None:
    returns = [0.02, 0.00, 0.01, 0.03]
    assert risk.RISK_FREE_ANNUAL == 0.04
    assert risk.sharpe_ratio(returns) == pytest.approx(
        risk.sharpe_ratio(returns, risk_free_annual=0.04)
    )
    # mean excess = 0.015 - 0.04/252 = 0.0148413; / 0.0129099 * sqrt(252) = 18.2493
    assert risk.sharpe_ratio(returns) == pytest.approx(18.2493, abs=1e-4)


def test_downside_deviation_counts_every_day_in_the_denominator() -> None:
    # shortfalls 0, -0.01, 0, -0.02; squares sum to 0.0005; mean over 4 days = 0.000125
    assert risk.downside_deviation([0.03, -0.01, 0.02, -0.02]) == pytest.approx(math.sqrt(0.000125))


def test_sortino_ratio() -> None:
    # mean 0.005; downside deviation sqrt(0.000125) = 0.0111803
    # 0.005 / 0.0111803 * sqrt(252) = 7.0993
    returns = [0.03, -0.01, 0.02, -0.02]
    assert risk.sortino_ratio(returns, risk_free_annual=0.0) == pytest.approx(7.0993, abs=1e-4)
    assert risk.sortino_ratio([0.01, 0.02, 0.03], risk_free_annual=0.0) == 0.0  # no bad days


def test_drawdown_series() -> None:
    # running highs: 100, 120, 120, 120, 130, 130
    values = [100, 120, 90, 96, 130, 117]
    assert risk.drawdown_series(values) == pytest.approx([0, 0, -0.25, -0.20, 0, -0.10])


def test_max_drawdown_reports_peak_trough_and_recovery() -> None:
    result = risk.max_drawdown([100, 120, 90, 96, 130, 117])
    assert result.depth == pytest.approx(-0.25)  # 90 / 120 - 1
    assert (result.peak, result.trough, result.recovery) == (1, 2, 4)


def test_max_drawdown_edge_cases() -> None:
    unrecovered = risk.max_drawdown([100, 80, 90])
    assert unrecovered.depth == pytest.approx(-0.20)
    assert (unrecovered.peak, unrecovered.trough, unrecovered.recovery) == (0, 1, None)

    rising = risk.max_drawdown([1, 2, 3])
    assert (rising.depth, rising.peak, rising.trough, rising.recovery) == (0.0, 0, 0, None)

    # Two equal highs: the peak is the first time the high was reached.
    assert risk.max_drawdown([100, 100, 50]).peak == 0


def test_beta() -> None:
    market = [0.01, 0.02, -0.01, 0.02]  # mean 0.01
    asset = [0.02, 0.01, -0.02, 0.03]  # mean 0.01
    # market deviations 0, 0.01, -0.02, 0.01 (squares sum to 0.0006)
    # asset deviations 0.01, 0, -0.03, 0.02; cross products sum to 0.0008
    assert risk.beta(asset, market) == pytest.approx(0.0008 / 0.0006)
    doubled = [2 * m + 0.001 for m in market]
    assert risk.beta(doubled, market) == pytest.approx(2.0)
    assert risk.beta(market, market) == pytest.approx(1.0)
    with pytest.raises(ValueError):
        risk.beta([0.01, 0.02], [0.01, 0.01])  # a market that never moves


def test_correlation_matrix() -> None:
    x = [1.0, 2.0, 3.0, 4.0]
    table = np.column_stack([x, [2.0, 4.0, 6.0, 8.0], [4.0, 3.0, 2.0, 1.0], [1.0, 3.0, 2.0, 4.0]])
    matrix = risk.correlation_matrix(table)
    assert matrix[0, 1] == pytest.approx(1.0)  # a multiple of x
    assert matrix[0, 2] == pytest.approx(-1.0)  # x reversed
    # deviations (-1.5,-0.5,0.5,1.5) and (-1.5,0.5,-0.5,1.5): products sum to 4, squares to 5
    assert matrix[0, 3] == pytest.approx(0.8)
    assert np.allclose(matrix, matrix.T)
    assert np.allclose(np.diag(matrix), 1.0)


def test_covariance_matrix_matches_numpy() -> None:
    rng = np.random.default_rng(1)
    table = rng.normal(size=(40, 3))
    assert np.allclose(risk.covariance_matrix(table), np.cov(table, rowvar=False, ddof=1))


def test_portfolio_returns_are_the_weighted_sum() -> None:
    table = np.array([[0.10, -0.02], [0.00, 0.04]])
    # day 1: 0.6*0.10 + 0.4*-0.02 = 0.052; day 2: 0.4*0.04 = 0.016
    assert risk.portfolio_returns(table, [0.6, 0.4]) == pytest.approx([0.052, 0.016])
    with pytest.raises(ValueError):
        risk.portfolio_returns(table, [1.0])


def test_sector_exposure_sums_weights_and_sorts() -> None:
    exposure = risk.sector_exposure(
        {"A": 0.5, "B": 0.3, "C": 0.2}, {"A": "Tech", "B": "Energy", "C": "Tech"}
    )
    assert list(exposure.items()) == [("Tech", pytest.approx(0.7)), ("Energy", pytest.approx(0.3))]


def test_risk_contributions() -> None:
    # Two uncorrelated assets with variances 0.04 and 0.01, half the money in each.
    # Cov w = (0.02, 0.005); portfolio variance = 0.5*0.02 + 0.5*0.005 = 0.0125
    # shares = 0.5*0.02/0.0125 = 0.8 and 0.5*0.005/0.0125 = 0.2
    shares = risk.risk_contributions(np.diag([0.04, 0.01]), [0.5, 0.5])
    assert shares == pytest.approx([0.8, 0.2])
    assert shares.sum() == pytest.approx(1.0)


def test_historical_var_and_cvar_are_positive_losses() -> None:
    # 21 returns: -10%, -9%, ..., +10%, shuffled so order cannot matter.
    returns = np.arange(-10, 11) / 100
    np.random.default_rng(0).shuffle(returns)
    # 5th percentile sits at position 20 * 0.05 = 1, the second-worst day: -9%
    assert risk.historical_var(returns, 0.95) == pytest.approx(0.09)
    # the days at or below -9% are -10% and -9%: average -9.5%
    assert risk.historical_cvar(returns, 0.95) == pytest.approx(0.095)
    # 1st percentile sits at position 0.2: -10% + 0.2 * 1% = -9.8%
    assert risk.historical_var(returns, 0.99) == pytest.approx(0.098)
    assert risk.historical_cvar(returns, 0.99) == pytest.approx(0.10)


def test_var_interpolates_between_observations() -> None:
    returns = np.arange(-5, 6) / 100  # 11 returns: -5% ... +5%
    # position 10 * 0.05 = 0.5: halfway between -5% and -4%
    assert risk.historical_var(returns, 0.95) == pytest.approx(0.045)
    assert risk.historical_cvar(returns, 0.95) == pytest.approx(0.05)
    with pytest.raises(ValueError):
        risk.historical_var(returns, 1.5)


def test_cvar_is_never_smaller_than_var() -> None:
    returns = np.random.default_rng(3).standard_t(4, size=500) * 0.01
    for level in (0.95, 0.99):
        assert risk.historical_cvar(returns, level) >= risk.historical_var(returns, level)


def test_monte_carlo_with_constant_returns_has_one_outcome() -> None:
    result = risk.monte_carlo([0.01, 0.01, 0.01], horizon_days=10, simulations=50, seed=1)
    assert result.terminal == pytest.approx(np.full(50, 1.01**10 - 1))
    assert result.probability_of_loss == 0.0
    assert result.bands.shape == (5, 10)
    assert result.bands[:, 0] == pytest.approx(np.full(5, 0.01))


def test_monte_carlo_matches_an_independent_replay_of_the_same_draws() -> None:
    history = [0.02, -0.01, 0.005, -0.03]
    result = risk.monte_carlo(history, horizon_days=3, simulations=4, seed=42)
    # Re-draw the same indices and compound them with plain Python.
    picks = np.random.default_rng(42).integers(0, 4, size=(4, 3))
    expected = []
    for row in picks:
        value = 1.0
        for index in row:
            value *= 1 + history[index]
        expected.append(value - 1)
    assert result.terminal == pytest.approx(expected)
    assert result.percentile(50) == pytest.approx(float(np.median(expected)))
    assert result.mean == pytest.approx(sum(expected) / 4)


def test_monte_carlo_is_reproducible_and_seed_dependent() -> None:
    history = np.random.default_rng(5).normal(0.0005, 0.01, size=250)
    first = risk.monte_carlo(history, 60, 200, seed=7)
    again = risk.monte_carlo(history, 60, 200, seed=7)
    other = risk.monte_carlo(history, 60, 200, seed=8)
    assert np.array_equal(first.terminal, again.terminal)
    assert not np.array_equal(first.terminal, other.terminal)


def test_monte_carlo_mean_converges_to_compounded_average_return() -> None:
    history = np.array([0.02, -0.01, 0.0, 0.01])  # mean 0.5% a day
    result = risk.monte_carlo(history, horizon_days=20, simulations=20_000, seed=11)
    # Independent draws: E[prod(1 + r)] = (1 + mean) ** horizon
    assert result.mean == pytest.approx(1.005**20 - 1, abs=0.003)
    assert 0 < result.probability_of_loss < 0.5
    assert np.all(np.diff(result.bands[:, -1]) >= 0)  # percentile bands are ordered
