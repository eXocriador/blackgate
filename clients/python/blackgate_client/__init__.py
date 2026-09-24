"""Python-клієнт blackgate — шлюзу до моделей. Контракт — README сервісу."""

from blackgate_client.client import (
    DEFAULT_TIMEOUT_SECONDS,
    Attempt,
    Blackgate,
    Completion,
    Message,
)
from blackgate_client.errors import (
    AllRungsFailed,
    BadRequest,
    BlackgateError,
    BlackgateTimeout,
    BlackgateUnavailable,
    BudgetExhausted,
    Unauthorized,
    UnexpectedResponse,
    UnknownTier,
)

__all__ = [
    "DEFAULT_TIMEOUT_SECONDS",
    "AllRungsFailed",
    "Attempt",
    "BadRequest",
    "Blackgate",
    "BlackgateError",
    "BlackgateTimeout",
    "BlackgateUnavailable",
    "BudgetExhausted",
    "Completion",
    "Message",
    "Unauthorized",
    "UnexpectedResponse",
    "UnknownTier",
]
