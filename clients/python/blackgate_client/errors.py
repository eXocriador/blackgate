"""Помилки клієнта — по класу на кожну відповідь сервісу, яку продукт має розрізняти.

Розрізняти тут означає ДІЯТИ по-різному (таблиця кодів у README сервісу):

* ``BudgetExhausted`` (429) — добова стеля. Передати людині, не показувати
  помилку і не повторювати: до кінця доби UTC відповідь та сама;
* ``AllRungsFailed`` (503) — жодна сходинка драбини не відповіла. Fail-safe
  продукту; повтор згодом має сенс;
* ``UnknownTier`` / ``BadRequest`` (400) — помилка інтеграції, повтор нічого не
  змінить;
* ``Unauthorized`` (401) — ключ продукту не той;
* ``BlackgateTimeout`` / ``BlackgateUnavailable`` — до сервісу не дійшли або не дочекались.

``retryable`` — підказка для черги продукту, а не наказ: чи має сенс та сама
спроба трохи згодом. Бюджет — ні: він скидається лише з новою добою.
"""

from __future__ import annotations

from typing import Any


class BlackgateError(Exception):
    """Будь-яка невдача виклику blackgate."""

    retryable: bool = False

    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        code: str | None = None,
        body: Any = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        """HTTP-код, якщо відповідь була."""
        self.code = code
        """Поле ``error`` тіла: ``budget_exhausted``, ``all_rungs_failed``…"""
        self.body = body
        """Розібране тіло відповіді (або сирий текст, якщо це не JSON)."""


class BudgetExhausted(BlackgateError):
    """429 ``budget_exhausted``: добова стеля продукту чи кінцевого клієнта.

    Не білінг і не збій: сервіс просить деградувати в передачу людині
    (``degrade: human_handoff``).
    """

    retryable = False

    def __init__(self, message: str, *, body: dict[str, Any]) -> None:
        super().__init__(message, status=429, code="budget_exhausted", body=body)
        self.scope: str | None = body.get("scope")
        """``product`` або ``subject`` — чия стеля скінчилась."""
        self.used: int | None = body.get("used")
        self.cap: int | None = body.get("cap")


class AllRungsFailed(BlackgateError):
    """503 ``all_rungs_failed``: драбина тиру вичерпана."""

    retryable = True

    def __init__(self, message: str, *, body: dict[str, Any]) -> None:
        super().__init__(message, status=503, code="all_rungs_failed", body=body)
        self.attempts: list[dict[str, Any]] = list(body.get("attempts") or [])
        """Кожна спроба драбини — видно, котрий пул чим відповів."""


class UnknownTier(BlackgateError):
    """400 ``unknown_tier``: тиру немає в реєстрі сервісу."""

    def __init__(self, message: str, *, body: dict[str, Any]) -> None:
        super().__init__(message, status=400, code="unknown_tier", body=body)
        self.tiers: list[str] = list(body.get("tiers") or [])
        """Які тири реєстр знає зараз."""


class BadRequest(BlackgateError):
    """400 ``bad_request``: тіло запиту не тієї форми."""

    def __init__(self, message: str, *, body: Any) -> None:
        super().__init__(message, status=400, code="bad_request", body=body)


class Unauthorized(BlackgateError):
    """401: ключа немає або він не виданий жодному продукту."""

    def __init__(self, message: str, *, body: Any) -> None:
        super().__init__(message, status=401, code="unauthorized", body=body)


class BlackgateTimeout(BlackgateError):
    """Відповіді не дочекались за таймаут клієнта.

    Сервіс при цьому міг і відповісти, і списати виклик зі стелі — він рахує
    ПЕРЕД викликом моделі.
    """

    retryable = True


class BlackgateUnavailable(BlackgateError):
    """До сервісу не дійшли: DNS, відмова з'єднання, обрив."""

    retryable = True


class UnexpectedResponse(BlackgateError):
    """Код чи тіло, яких контракт не описує (500 сервісу, не-JSON, 404 шляху).

    5xx вважаються тимчасовими, решта — ні.
    """

    def __init__(self, message: str, *, status: int | None, body: Any) -> None:
        code = body.get("error") if isinstance(body, dict) else None
        super().__init__(message, status=status, code=code, body=body)
        self.retryable = status is not None and status >= 500
