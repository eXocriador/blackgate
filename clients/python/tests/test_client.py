"""Клієнт проти ``httpx.MockTransport`` — без мережі й без сервісу.

Тіла відповідей скопійовані з форми, яку віддає ``src/http/server.ts``: якщо
сервіс її змінить, ці тести мають упасти першими.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from typing import Any

import httpx
import pytest

from exo_ai_client import (
    AllRungsFailed,
    BadRequest,
    BudgetExhausted,
    ExoAI,
    ExoAIError,
    ExoAITimeout,
    ExoAIUnavailable,
    Message,
    Unauthorized,
    UnexpectedResponse,
    UnknownTier,
)

KEY = "exoai-test-0123456789abcdef"

OK_BODY: dict[str, Any] = {
    "content": "привіт",
    "model": "gemini-3.1-flash-lite",
    "pool": "gemini-lite",
    "rung": 1,
    "tier": "fast",
    "attempts": [
        {
            "rung": 0,
            "model": "gemini-3-flash-preview",
            "pool": "gemini-premium",
            "outcome": "skipped",
            "httpStatus": None,
            "latencyMs": 0,
            "tries": 0,
            "promptTokens": None,
            "completionTokens": None,
            "totalTokens": None,
            "detail": "пул відомо вичерпаний",
        },
        {
            "rung": 1,
            "model": "gemini-3.1-flash-lite",
            "pool": "gemini-lite",
            "outcome": "ok",
            "httpStatus": 200,
            "latencyMs": 812,
            "tries": 1,
            "promptTokens": 11,
            "completionTokens": 3,
            "totalTokens": 14,
            "detail": None,
        },
    ],
    "totalLatencyMs": 815,
}


def run(
    handler: Callable[[httpx.Request], httpx.Response],
    call: Callable[[ExoAI], Any],
) -> Any:
    async def go() -> Any:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            ai = ExoAI("http://exo-ai-web:3000/", KEY, client=http)
            return await call(ai)

    return asyncio.run(go())


def reply(status: int, body: Any) -> Callable[[httpx.Request], httpx.Response]:
    return lambda _request: httpx.Response(status, json=body)


def complete(ai: ExoAI) -> Any:
    return ai.complete("fast", [Message("user", "ping")])


def test_request_shape() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers["authorization"]
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json=OK_BODY)

    run(
        handler,
        lambda ai: ai.complete(
            "capable",
            [Message("system", "будь коротким"), {"role": "user", "content": "ping"}],
            max_tokens=64,
            temperature=0.1,
            subject="exopost:bot:moderator",
            request_id="r-1",
        ),
    )
    assert seen["url"] == "http://exo-ai-web:3000/v1/complete"
    assert seen["auth"] == f"Bearer {KEY}"
    assert seen["body"] == {
        "tier": "capable",
        "messages": [
            {"role": "system", "content": "будь коротким"},
            {"role": "user", "content": "ping"},
        ],
        "max_tokens": 64,
        "temperature": 0.1,
        "subject": "exopost:bot:moderator",
        "request_id": "r-1",
    }


def test_optional_fields_are_left_to_the_service() -> None:
    """Дефолти max_tokens/temperature — справа сервісу, клієнт їх не вигадує."""
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        return httpx.Response(200, json=OK_BODY)

    run(handler, complete)
    assert set(seen) == {"tier", "messages"}


def test_ok_parses_rung_attempts_and_tokens() -> None:
    done = run(reply(200, OK_BODY), complete)
    assert done.content == "привіт"
    assert (done.model, done.pool, done.rung, done.tier) == (
        "gemini-3.1-flash-lite",
        "gemini-lite",
        1,
        "fast",
    )
    assert [a.outcome for a in done.attempts] == ["skipped", "ok"]
    assert done.total_latency_ms == 815
    assert (done.prompt_tokens, done.completion_tokens) == (11, 3)


def test_429_budget_exhausted() -> None:
    body = {
        "error": "budget_exhausted",
        "scope": "subject",
        "used": 301,
        "cap": 300,
        "degrade": "human_handoff",
    }
    with pytest.raises(BudgetExhausted) as caught:
        run(reply(429, body), complete)
    err = caught.value
    assert (err.status, err.code, err.scope, err.used, err.cap) == (
        429,
        "budget_exhausted",
        "subject",
        301,
        300,
    )
    assert err.retryable is False


def test_503_all_rungs_failed() -> None:
    body = {
        "error": "all_rungs_failed",
        "tier": "fast",
        "attempts": OK_BODY["attempts"][:1],
        "totalLatencyMs": 3,
    }
    with pytest.raises(AllRungsFailed) as caught:
        run(reply(503, body), complete)
    assert caught.value.attempts[0]["pool"] == "gemini-premium"
    assert caught.value.retryable is True


def test_400_unknown_tier() -> None:
    body = {"error": "unknown_tier", "detail": "тиру nope немає", "tiers": ["fast", "capable"]}
    with pytest.raises(UnknownTier) as caught:
        run(reply(400, body), lambda ai: ai.complete("nope", [Message("user", "x")]))
    assert caught.value.tiers == ["fast", "capable"]
    assert caught.value.retryable is False


def test_400_bad_request() -> None:
    with pytest.raises(BadRequest) as caught:
        run(reply(400, {"error": "bad_request", "detail": "потрібен tier"}), complete)
    assert "потрібен tier" in str(caught.value)


def test_401() -> None:
    with pytest.raises(Unauthorized):
        run(reply(401, {"error": "unauthorized"}), complete)


def test_500_is_unexpected_but_retryable() -> None:
    with pytest.raises(UnexpectedResponse) as caught:
        run(reply(500, {"error": "internal"}), complete)
    assert caught.value.retryable is True
    assert caught.value.code == "internal"


def test_non_json_body() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(502, text="<html>Bad Gateway</html>")

    with pytest.raises(UnexpectedResponse) as caught:
        run(handler, complete)
    assert caught.value.body == "<html>Bad Gateway</html>"


def test_200_without_content_is_not_an_answer() -> None:
    with pytest.raises(UnexpectedResponse):
        run(reply(200, {"model": "x"}), complete)


def test_timeout() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    with pytest.raises(ExoAITimeout) as caught:
        run(handler, complete)
    assert caught.value.retryable is True


def test_timeout_is_passed_per_call() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(request.extensions["timeout"])
        return httpx.Response(200, json=OK_BODY)

    run(handler, lambda ai: ai.complete("fast", [Message("user", "x")], timeout=7.5))
    assert seen["read"] == 7.5


def test_unreachable() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    with pytest.raises(ExoAIUnavailable):
        run(handler, complete)


def test_every_error_is_an_exoai_error() -> None:
    for cls in (
        AllRungsFailed,
        BadRequest,
        BudgetExhausted,
        ExoAITimeout,
        ExoAIUnavailable,
        UnexpectedResponse,
        Unauthorized,
        UnknownTier,
    ):
        assert issubclass(cls, ExoAIError)


def test_reference_routes() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return {
            "/v1/pools": httpx.Response(
                200, json={"pools": [{"pool": "gemini-lite", "state": "healthy"}]}
            ),
            "/v1/tiers": httpx.Response(200, json={"tiers": [{"tier": "fast", "rungs": []}]}),
            "/v1/usage": httpx.Response(
                200, json={"product": "exopost", "usedToday": 3, "cap": 2000}
            ),
        }[request.url.path]

    async def call(ai: ExoAI) -> Any:
        return await ai.pools(), await ai.tiers(), await ai.usage()

    pools, tiers, usage = run(handler, call)
    assert pools[0]["state"] == "healthy"
    assert tiers[0]["tier"] == "fast"
    assert usage["usedToday"] == 3


def test_empty_key_is_refused() -> None:
    with pytest.raises(ValueError):
        ExoAI("http://x", "")
