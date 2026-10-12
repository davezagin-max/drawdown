"""The provenance checker: what counts as a figure, and when a figure is traced to a tool."""

import pytest

from app.provenance import check_provenance, clean_answer, collect_sources, extract, self_test

CALLS = [
    {
        "id": "c1",
        "name": "get_metric",
        "isError": False,
        "output": {"metric": "volatility", "subject": "PORTFOLIO", "value": 0.186872},
    },
    {
        "id": "c2",
        "name": "get_metric",
        "isError": False,
        "output": {
            "metric": "max_drawdown",
            "value": -0.299714,
            "peak_date": "2022-03-30",
            "trough_date": "2022-08-04",
            "trading_days_peak_to_trough": 91,
        },
    },
    {
        "id": "c3",
        "name": "run_stress_test",
        "isError": False,
        "output": {
            "market_shock_pct": -20.0,
            "portfolio_change": -0.253252,
            "portfolio_change_usd": -63313.05,
            "positions": [{"ticker": "NVDA", "beta": 1.71527, "change_usd": -15506.89}],
        },
    },
    {"id": "c4", "name": "get_metric", "isError": False, "output": {"value": 1.076261}},
    {
        "id": "c5",
        "name": "monte_carlo",
        "isError": True,
        "output": "horizon_days must be 1 to 504.",
    },
    {
        "id": "c6",
        "name": "get_metric",
        "isError": False,
        "output": {"value": 0.017038, "confidence": 0.95, "loss_usd": 4259.43, "flag": True},
    },
]


def statuses(text: str, question: str = "") -> list[tuple[str, str]]:
    result = check_provenance(text, CALLS, question)
    return [(n["text"], n["status"]) for n in result["numbers"]]


def source_of(text: str) -> tuple[str | None, str | None]:
    numbers = check_provenance(text, CALLS)["numbers"]
    assert len(numbers) == 1, numbers
    return numbers[0]["callId"], numbers[0]["path"]


# --- collecting sources -------------------------------------------------------------


def test_sources_are_numeric_leaves_of_successful_calls() -> None:
    sources = collect_sources(CALLS)
    paths = {(s.call_id, s.path) for s in sources}
    assert ("c2", "trading_days_peak_to_trough") in paths
    assert ("c3", "positions[0].beta") in paths
    assert all(s.call_id != "c5" for s in sources)  # a failed call is not evidence
    assert ("c6", "flag") not in paths  # booleans are not numbers
    assert all(isinstance(s.value, float) for s in sources)
    assert next(s for s in sources if s.path == "positions[0].change_usd").field == "change_usd"


# --- rounding -----------------------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    ["18.7%", "18.69%", "18.687%", "19%", "18.7 percent", "0.187", "0.19", "0.186872"],
)
def test_a_faithful_rounding_matches(text: str) -> None:
    assert source_of(f"Volatility is {text}.") == ("c1", "value")


@pytest.mark.parametrize("text", ["18%", "18.6%", "18.8%", "18.70%", "0.18", "20.1%", "187%"])
def test_a_wrong_or_truncated_figure_does_not_match(text: str) -> None:
    assert statuses(f"Volatility is {text}.") == [(text, "unmatched")]


def test_half_a_unit_in_the_last_place_is_the_limit() -> None:
    calls = [{"id": "a", "name": "t", "isError": False, "output": {"value": 0.12345}}]
    assert check_provenance("12.3%", calls)["matched"] == 1  # 12.345 -> 12.3
    assert check_provenance("12.35%", calls)["matched"] == 1  # a tie may round either way
    assert check_provenance("12.34%", calls)["matched"] == 1
    assert check_provenance("12.4%", calls)["matched"] == 0
    assert check_provenance("12.36%", calls)["matched"] == 0


# --- percent and decimal ------------------------------------------------------------


def test_percent_fields_are_matched_as_they_are() -> None:
    assert source_of("a 20% fall in the market") == ("c3", "market_shock_pct")
    assert source_of("a 20 percent fall") == ("c3", "market_shock_pct")
    assert source_of("a shock of 20 to the market") == ("c3", "market_shock_pct")


def test_a_fraction_is_not_mistaken_for_a_percentage() -> None:
    # beta is 1.076261: "1.1" is a faithful rounding, "1.1%" is a different quantity.
    assert source_of("a beta of 1.1") == ("c4", "value")
    assert source_of("a beta of 1.08x the market") == ("c4", "value")
    assert statuses("a move of 1.1%") == [("1.1%", "unmatched")]
    # ...and a percent field is not read as a fraction of 100.
    assert statuses("a fall of 2000%") == [("2000%", "unmatched")]


def test_confidence_levels_and_basis_points() -> None:
    assert source_of("the 95% level") == ("c6", "confidence")
    assert source_of("about 170 bps a day") == ("c6", "value")  # 0.017038 -> 170.38 bps
    assert source_of("about 170 basis points") == ("c6", "value")
    assert source_of("1.7 percentage points") == ("c6", "value")


# --- negatives ----------------------------------------------------------------------


@pytest.mark.parametrize(
    "text", ["-30.0%", "−30.0%", "30.0%", "(30.0%)", "a 30.0% drawdown", "-0.2997", "–30.0%"]
)
def test_sign_is_carried_by_the_words_so_magnitudes_are_compared(text: str) -> None:
    numbers = check_provenance(f"The portfolio fell {text} at worst.", CALLS)["numbers"]
    assert [(n["status"], n["callId"]) for n in numbers] == [("matched", "c2")]


def test_a_leading_minus_is_part_of_the_figure_but_a_range_dash_is_not() -> None:
    mentions, _ = extract("It lost -4.2% then a 5-10% range, mid-2022, and -$1,200 or $-900.")
    assert [(m.text, m.negative) for m in mentions] == [
        ("-4.2%", True),
        ("5", False),
        ("10%", False),
        ("-$1,200", True),
        ("$-900", True),
    ]
    assert mentions[0].value == 4.2


# --- currency -----------------------------------------------------------------------


@pytest.mark.parametrize("text", ["$63,313", "$63,313.05", "-$63,313", "$63.3k", "$63k", "$0.06M"])
def test_dollar_amounts_match_dollar_fields(text: str) -> None:
    assert source_of(f"The scenario costs {text}.") == ("c3", "portfolio_change_usd")


def test_round_dollar_figures_are_approximate_matches() -> None:
    number = check_provenance("roughly $63,000", CALLS)["numbers"][0]
    assert (number["status"], number["approximate"], number["path"]) == (
        "matched",
        True,
        "portfolio_change_usd",
    )
    exact = check_provenance("$63,313", CALLS)["numbers"][0]
    assert exact["approximate"] is False
    # One significant digit is too vague to round against: $60,000 could be anything.
    assert statuses("about $60,000") == [("$60,000", "unmatched")]
    assert statuses("about $64,000") == [("$64,000", "unmatched")]


def test_a_dollar_amount_must_come_from_a_dollar_field() -> None:
    # 91 trading days exists, but "$91" would be an invented price.
    assert source_of("91 trading days") == ("c2", "trading_days_peak_to_trough")
    assert statuses("a price of $91") == [("$91", "unmatched")]


def test_thousands_separators_and_scale_words() -> None:
    mentions, _ = extract("1,234,567 and 2.5 million and $3B and 4 thousand and .5")
    assert [m.value for m in mentions] == [1234567.0, 2.5e6, 3e9, 4000.0, 0.5]
    assert mentions[1].tolerance == pytest.approx(0.05e6)


# --- things that are not figures ----------------------------------------------------


def test_dates_and_years_are_not_metrics() -> None:
    text = (
        "From 2022-03-30 to 2022-08-04, about 91 trading days, the fall ran through "
        "March 30 and August 4, 2022. It recovered in March 2023, on 17 March 2023, "
        "over 2022-23 and by 3/17/2023. In 2022 the slide was 30.0%."
    )
    result = check_provenance(text, CALLS)
    assert [(n["text"], n["status"]) for n in result["numbers"]] == [
        ("91", "matched"),
        ("30.0%", "matched"),
    ]
    reasons = {(i["text"], i["reason"]) for i in result["ignored"]}
    assert ("2022-03-30", "date") in reasons
    assert ("August 4, 2022", "date") in reasons
    assert ("March 2023", "date") in reasons
    assert ("17 March 2023", "date") in reasons
    assert ("2022-23", "date") in reasons
    assert ("3/17/2023", "date") in reasons
    assert ("2022", "year") in reasons


def test_a_year_shaped_number_with_a_unit_is_still_a_figure() -> None:
    assert statuses("It cost $2022.") == [("$2022", "unmatched")]
    assert statuses("up 2022%") == [("2022%", "unmatched")]
    assert statuses("across 2000 simulations") == [("2000", "unmatched")]
    assert statuses("a level of 2,024") == [("2,024", "unmatched")]
    assert statuses("back in 1999") == []


def test_a_percentage_after_a_month_name_is_a_figure() -> None:
    assert statuses("In May 20% of the fall was done.") == [("20%", "matched")]


def test_identifiers_ordinals_names_and_list_markers_are_skipped() -> None:
    text = (
        "1. In Q3 the S&P 500 and the Russell 2000 fell.\n"
        "2) The 2nd worst day hit the p95 band, var_95, COVID-19 style, in 3D.\n"
        "The beta is 1.08."
    )
    result = check_provenance(text, CALLS)
    assert [(n["text"], n["status"]) for n in result["numbers"]] == [("1.08", "matched")]
    reasons = [(i["text"], i["reason"]) for i in result["ignored"]]
    assert ("S&P 500", "name") in reasons
    assert ("Russell 2000", "name") in reasons
    assert ("2", "ordinal") in reasons
    assert ("1", "list marker") in reasons and ("2", "list marker") in reasons
    assert ("3", "identifier") in reasons and ("19", "identifier") in reasons


def test_words_are_not_numbers() -> None:
    assert statuses("One holding carries a quarter of the risk, twice its weight.") == []


# --- zero, invention, and the question ----------------------------------------------


def test_zero_only_matches_an_exact_zero() -> None:
    assert statuses("a 0% chance") == [("0%", "unmatched")]
    calls = [{"id": "z", "name": "t", "isError": False, "output": {"sector_shock_pct": 0.0}}]
    assert check_provenance("a 0% sector shock", calls)["matched"] == 1


def test_an_invented_number_is_flagged() -> None:
    result = check_provenance("Volatility is 18.7%, well above the 12.4% average.", CALLS)
    assert [(n["text"], n["status"]) for n in result["numbers"]] == [
        ("18.7%", "matched"),
        ("12.4%", "unmatched"),
    ]
    assert (result["matched"], result["unmatched"]) == (1, 1)


def test_a_failed_tool_call_is_not_a_source() -> None:
    assert statuses("The limit is 504 days.") == [("504", "unmatched")]


def test_a_number_restated_from_the_question_is_labelled_not_flagged() -> None:
    question = "What if I add $5,000 and the market drops 35%?"
    result = check_provenance("A 35% drop on the extra $5,000 costs 42%.", CALLS, question)
    assert [(n["text"], n["status"]) for n in result["numbers"]] == [
        ("35%", "question"),
        ("$5,000", "question"),
        ("42%", "unmatched"),
    ]
    assert result["fromQuestion"] == 2
    # A tool source wins over the question when both have the figure.
    assert statuses("a 20% fall", "what about a 20% fall?") == [("20%", "matched")]


def test_no_tool_calls_means_nothing_is_traced() -> None:
    result = check_provenance("Volatility is 18.7% and beta is 1.08.", [])
    assert (result["matched"], result["unmatched"]) == (0, 2)


# --- segments and ties --------------------------------------------------------------


def test_segments_rebuild_the_answer_and_point_at_their_numbers() -> None:
    answer = "Volatility is 18.7%.\n\nA 20% fall costs -$63,313 (beta 1.08)."
    result = check_provenance(answer, CALLS)
    assert "".join(s["text"] for s in result["segments"]) == answer
    marked = [s for s in result["segments"] if "number" in s]
    assert [s["text"] for s in marked] == ["18.7%", "20%", "-$63,313", "1.08"]
    assert [s["number"] for s in marked] == [0, 1, 2, 3]
    assert [result["numbers"][s["number"]]["text"] for s in marked] == [s["text"] for s in marked]
    assert result["numbers"][2]["value"] == -63313.0
    assert result["numbers"][2]["sourceValue"] == -63313.05


def test_the_closest_source_wins_and_ties_go_to_the_earliest_call() -> None:
    calls = [
        {"id": "a", "name": "t", "isError": False, "output": {"value": 0.2531}},
        {"id": "b", "name": "t", "isError": False, "output": {"value": 0.2502}},
        {"id": "c", "name": "t", "isError": False, "output": {"value": 0.2502}},
    ]
    assert check_provenance("25%", calls)["numbers"][0]["callId"] == "b"
    assert check_provenance("25.3%", calls)["numbers"][0]["callId"] == "a"


def test_the_sentence_decides_between_sources_that_round_to_the_same_figure() -> None:
    calls = [
        {
            "id": "stress",
            "name": "run_stress_test",
            "isError": False,
            "input": {"sector": "Technology"},
            "output": {
                "method": "each holding moves by its beta times the market shock",
                "positions": [
                    {"ticker": "JPM", "beta": 1.079943, "change_usd": -4319.77},
                    {"ticker": "NVDA", "beta": 1.71527, "change_usd": -15506.89},
                ],
            },
        },
        {
            "id": "beta",
            "name": "get_metric",
            "isError": False,
            "input": {"metric": "beta", "subject": "PORTFOLIO"},
            "output": {"metric": "beta", "subject": "PORTFOLIO", "value": 1.076261},
        },
    ]

    def source(text: str) -> tuple[str, str, int]:
        number = check_provenance(text, calls)["numbers"][0]
        return number["callId"], number["path"], number["alternatives"]

    # 1.08 is a faithful rounding of both betas; JPM's is numerically closer.
    assert source("The portfolio's beta is 1.08.") == ("beta", "value", 1)
    assert source("JPM has a beta of 1.08.") == ("stress", "positions[0].beta", 1)
    # With no words to go on, the least nested field wins.
    assert source("1.08") == ("beta", "value", 1)
    # Context is the figure's own sentence, not the whole answer.
    assert source("JPM fell. The portfolio's beta is 1.08.") == ("beta", "value", 1)
    # A long prose field ("method") lends no words to the numbers beside it.
    sources = collect_sources(calls)
    assert "shock" not in next(s for s in sources if s.path == "positions[0].beta").words
    assert {"jpm", "technology", "beta", "positions"} <= next(
        s for s in sources if s.path == "positions[0].beta"
    ).words
    assert source("NVDA loses $15,507.") == ("stress", "positions[1].change_usd", 0)


def test_a_value_reproduced_exactly_beats_one_that_only_rounds_to_the_figure() -> None:
    calls = [
        {
            "id": "mc",
            "name": "monte_carlo",
            "isError": False,
            "input": {},
            "output": {"mean_return": 0.195796},
        },
        {
            "id": "rebalance",
            "name": "rebalance_to_target",
            "isError": False,
            "input": {"scope": "sector", "name": "Technology"},
            "output": {"target_weight_pct": 20.0},
        },
    ]
    # "mean" appears in the sentence and in `mean_return`, but 20.0 is exactly 20%.
    number = check_provenance("Moving it to 20% would mean trading more.", calls)["numbers"][0]
    assert (number["callId"], number["path"], number["alternatives"]) == (
        "rebalance",
        "target_weight_pct",
        1,
    )
    assert check_provenance("a mean return of 19.6%", calls)["numbers"][0]["callId"] == "mc"


def test_markdown_is_stripped_before_checking() -> None:
    assert clean_answer("## Summary\n**Volatility** is `18.7%`\n* one\n") == (
        "Summary\nVolatility is 18.7%\n- one"
    )


# --- self-test ----------------------------------------------------------------------


def test_self_test_alters_one_figure_and_the_checker_catches_it() -> None:
    answer = "Volatility is 18.7% and a 20% fall costs $63,313."
    altered = self_test(answer, CALLS)
    assert altered is not None
    assert altered["original"] == "18.7%"
    assert altered["altered"] != "18.7%" and altered["altered"].endswith("%")
    assert altered["answer"] == answer.replace("18.7%", altered["altered"])
    before = check_provenance(answer, CALLS)
    assert before["unmatched"] == 0
    assert altered["provenance"]["unmatched"] == 1
    assert altered["provenance"]["matched"] == before["matched"] - 1
    flagged = [n for n in altered["provenance"]["numbers"] if n["status"] == "unmatched"]
    assert [n["text"] for n in flagged] == [altered["altered"]]


def test_self_test_is_none_when_nothing_is_traced() -> None:
    assert self_test("No figures here.", CALLS) is None
    assert self_test("An invented 12.4%.", CALLS) is None
