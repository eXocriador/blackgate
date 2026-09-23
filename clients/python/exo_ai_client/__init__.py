"""Python-клієнт exo-ai — шлюзу до моделей. Контракт — README сервісу."""

from exo_ai_client.client import (
    DEFAULT_TIMEOUT_SECONDS,
    Attempt,
    Completion,
    ExoAI,
    Message,
)
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

__all__ = [
    "DEFAULT_TIMEOUT_SECONDS",
    "AllRungsFailed",
    "Attempt",
    "BadRequest",
    "BudgetExhausted",
    "Completion",
    "ExoAI",
    "ExoAIError",
    "ExoAITimeout",
    "ExoAIUnavailable",
    "Message",
    "Unauthorized",
    "UnexpectedResponse",
    "UnknownTier",
]
