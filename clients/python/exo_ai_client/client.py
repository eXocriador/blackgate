"""Асинхронний клієнт ``POST /v1/complete`` і довідкових маршрутів exo-ai.

Тонкий навмисно: драбина, пули, стелі й облік живуть у сервісі, а клієнт лише
перекладає HTTP на типи Python — щоб продукт розрізняв «передай людині» (429),
«fail-safe» (503) і «помилка інтеграції» (400) класом винятку, а не розбором
тіла в кожному місці виклику.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from types import TracebackType
from typing import Any, Literal, Self

import httpx

from exo_ai_client.errors import (
    AllRungsFailed,
    BadRequest,
    BudgetExhausted,
    ExoAIError,
    ExoAITimeout,
    ExoAIUnavailable,
    Unauthorized,
    UnexpectedResponse,
    UnknownTier,
)

Role = Literal["system", "user", "assistant"]

#: Сервіс сам не пускає тіло важче за мегабайт; пакетна генерація йде довго,
#: а драбина з трьох сходинок із таймаутом до 120 с на модель — ще довше.
DEFAULT_TIMEOUT_SECONDS = 180.0


@dataclass(frozen=True)
class Message:
    """Репліка: ``system`` тут звичайна роль, як у контракті сервісу."""

    role: Role
    content: str


@dataclass(frozen=True)
class Attempt:
    """Одна спроба драбини — так, як її віддає сервіс."""

    rung: int
    model: str
    pool: str
    outcome: str
    """``ok``, ``exhausted``, ``rejected``, ``retired``, ``error``, ``timeout``,
    ``unauthorized`` або ``skipped``."""
    http_status: int | None
    latency_ms: int
    tries: int
    prompt_tokens: int | None
    completion_tokens: int | None
    total_tokens: int | None
    detail: str | None

    @classmethod
    def from_json(cls, raw: Mapping[str, Any]) -> Attempt:
        return cls(
            rung=int(raw.get("rung", 0)),
            model=str(raw.get("model", "")),
            pool=str(raw.get("pool", "")),
            outcome=str(raw.get("outcome", "")),
            http_status=_opt_int(raw.get("httpStatus")),
            latency_ms=int(raw.get("latencyMs") or 0),
            tries=int(raw.get("tries") or 1),
            prompt_tokens=_opt_int(raw.get("promptTokens")),
            completion_tokens=_opt_int(raw.get("completionTokens")),
            total_tokens=_opt_int(raw.get("totalTokens")),
            detail=raw.get("detail"),
        )


@dataclass(frozen=True)
class Completion:
    """Відповідь 200.

    ``rung`` і ``attempts`` віддаються навмисно: ``rung > 0`` означає, що
    відповіла НЕ основна модель тиру, і продукт має це бачити.
    """

    content: str
    model: str
    pool: str
    rung: int
    tier: str
    attempts: tuple[Attempt, ...] = field(default_factory=tuple)
    total_latency_ms: int = 0

    @property
    def answered(self) -> Attempt | None:
        """Спроба, що дала відповідь (з токенами)."""
        return next((a for a in reversed(self.attempts) if a.outcome == "ok"), None)

    @property
    def prompt_tokens(self) -> int | None:
        return self.answered.prompt_tokens if self.answered else None

    @property
    def completion_tokens(self) -> int | None:
        return self.answered.completion_tokens if self.answered else None


class ExoAI:
    """Клієнт exo-ai.

    Приклад::

        async with ExoAI("http://exo-ai-web:3000", key) as ai:
            done = await ai.complete(
                "fast", [Message("user", "…")], subject="exopost:bot:moderator"
            )

    ``client`` — готовий ``httpx.AsyncClient`` (його життям керує той, хто
    передав; так тести підмінюють транспорт, а не мережу). Без нього клієнт
    створює власний і закриває його в ``aclose``.
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        if not api_key:
            raise ValueError("exo-ai: порожній ключ продукту")
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._headers = {"Authorization": f"Bearer {api_key}"}
        self._own = client is None
        self._client = client or httpx.AsyncClient(timeout=timeout)

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._own:
            await self._client.aclose()

    async def complete(
        self,
        tier: str,
        messages: Sequence[Message | Mapping[str, str]],
        *,
        max_tokens: int | None = None,
        temperature: float | None = None,
        subject: str | None = None,
        request_id: str | None = None,
        timeout: float | None = None,
    ) -> Completion:
        """Один виклик тиру.

        ``subject`` — гаманець кінцевого клієнта для стелі на суб'єкта
        (``<продукт>:<що>:<хто>``); без нього рахується лише стеля продукту.
        ``max_tokens`` і ``temperature`` сервіс обрізає до своїх меж (1…32000,
        0…2) і підставляє 512 і 0.3, якщо їх немає.

        Raises:
            BudgetExhausted: 429 — передати людині.
            AllRungsFailed: 503 — жодна сходинка не відповіла.
            UnknownTier, BadRequest: 400 — помилка інтеграції.
            Unauthorized: 401.
            ExoAITimeout, ExoAIUnavailable: до сервісу не дійшли.
            UnexpectedResponse: усе, чого контракт не описує.
        """
        payload: dict[str, Any] = {
            "tier": tier,
            "messages": [_message_json(item) for item in messages],
        }
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens
        if temperature is not None:
            payload["temperature"] = temperature
        if subject:
            payload["subject"] = subject
        if request_id:
            payload["request_id"] = request_id

        body = await self._request("POST", "/v1/complete", json=payload, timeout=timeout)
        try:
            return Completion(
                content=str(body["content"]),
                model=str(body["model"]),
                pool=str(body["pool"]),
                rung=int(body["rung"]),
                tier=str(body.get("tier") or tier),
                attempts=tuple(Attempt.from_json(a) for a in body.get("attempts") or []),
                total_latency_ms=int(body.get("totalLatencyMs") or 0),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise UnexpectedResponse(
                f"exo-ai: 200 без полів відповіді ({exc})", status=200, body=body
            ) from exc

    async def pools(self) -> list[dict[str, Any]]:
        """Стан пулів (``GET /v1/pools``)."""
        return list((await self._request("GET", "/v1/pools")).get("pools") or [])

    async def tiers(self) -> list[dict[str, Any]]:
        """Розгорнуті драбини (``GET /v1/tiers``)."""
        return list((await self._request("GET", "/v1/tiers")).get("tiers") or [])

    async def usage(self) -> dict[str, Any]:
        """Скільки цей продукт спалив сьогодні (``GET /v1/usage``)."""
        return await self._request("GET", "/v1/usage")

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        try:
            response = await self._client.request(
                method,
                f"{self.base_url}{path}",
                json=json,
                headers=self._headers,
                timeout=timeout if timeout is not None else self.timeout,
            )
        except httpx.TimeoutException as exc:
            raise ExoAITimeout(f"exo-ai: таймаут {method} {path}") from exc
        except httpx.TransportError as exc:
            raise ExoAIUnavailable(f"exo-ai: недосяжний ({type(exc).__name__}: {exc})") from exc

        body = _body(response)
        if response.status_code == 200 and isinstance(body, dict):
            return body
        raise _error_for(response.status_code, body)


def _error_for(status: int, body: Any) -> ExoAIError:
    fields = body if isinstance(body, dict) else {}
    code = fields.get("error")
    detail = fields.get("detail")
    suffix = f": {detail}" if detail else ""

    if status == 429 and code == "budget_exhausted":
        return BudgetExhausted(
            f"exo-ai: стеля {fields.get('scope')} {fields.get('used')}/{fields.get('cap')}",
            body=fields,
        )
    if status == 503 and code == "all_rungs_failed":
        return AllRungsFailed(
            f"exo-ai: тир {fields.get('tier')!r} — жодна сходинка не відповіла", body=fields
        )
    if status == 400 and code == "unknown_tier":
        return UnknownTier(f"exo-ai: невідомий тир{suffix}", body=fields)
    if status == 400:
        return BadRequest(f"exo-ai: запит не тієї форми{suffix}", body=body)
    if status == 401:
        return Unauthorized("exo-ai: ключ продукту не прийнято", body=body)
    return UnexpectedResponse(
        f"exo-ai: {status} {code or ''}{suffix}".rstrip(), status=status, body=body
    )


def _body(response: httpx.Response) -> Any:
    try:
        return response.json()
    except ValueError:
        return response.text[:500]


def _message_json(item: Message | Mapping[str, str]) -> dict[str, str]:
    if isinstance(item, Message):
        return {"role": item.role, "content": item.content}
    return {"role": str(item["role"]), "content": str(item["content"])}


def _opt_int(value: Any) -> int | None:
    return int(value) if isinstance(value, int | float) else None
