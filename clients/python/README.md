# exo-ai-client (Python)

Асинхронний клієнт [exo-ai](../../README.md) на `httpx`. Один на портфель:
продукти на Python ставлять його звідси, а не пишуть власний.

```toml
# pyproject.toml продукту (uv)
dependencies = ["exo-ai-client"]

[tool.uv.sources]
exo-ai-client = { git = "https://github.com/eXocriador/exo-ai", subdirectory = "clients/python", rev = "<коміт>" }
```

Лок запам'ятовує коміт, тож образ продукту не зміниться сам від пушу в exo-ai.
Оновити — змінити `rev` і `uv lock`.

```python
from exo_ai_client import BudgetExhausted, AllRungsFailed, ExoAI, Message

async with ExoAI("http://exo-ai-web:3000", key) as ai:
    try:
        done = await ai.complete(
            "fast",
            [Message("system", "…"), Message("user", "…")],
            max_tokens=512,
            temperature=0.2,
            subject="exopost:bot:moderator",
        )
    except BudgetExhausted:
        ...  # передати людині
    except AllRungsFailed:
        ...  # fail-safe продукту

done.content, done.model, done.pool, done.rung, done.attempts
```

`rung > 0` означає, що відповіла не основна модель тиру, — продукт має це
бачити, а не ховати.

| відповідь | виняток | `retryable` | що робити |
|---|---|---|---|
| 429 `budget_exhausted` | `BudgetExhausted` (`scope`, `used`, `cap`) | ні | передати людині; до нової доби UTC відповідь та сама |
| 503 `all_rungs_failed` | `AllRungsFailed` (`attempts`) | так | fail-safe продукту |
| 400 `unknown_tier` | `UnknownTier` (`tiers`) | ні | помилка інтеграції |
| 400 `bad_request` | `BadRequest` | ні | помилка інтеграції |
| 401 | `Unauthorized` | ні | ключ продукту не той |
| таймаут клієнта | `ExoAITimeout` | так | сервіс міг уже списати виклик зі стелі |
| мережа | `ExoAIUnavailable` | так | |
| решта (5xx, не-JSON) | `UnexpectedResponse` | так для 5xx | |

Усі — нащадки `ExoAIError`. `subject` — гаманець кінцевого клієнта
(`<продукт>:<що>:<хто>`) для стелі на суб'єкта; без нього рахується лише стеля
продукту. `max_tokens`/`temperature`, яких не передали, сервіс підставляє сам
(512 і 0.3).

Режиму JSON-схеми, картинок і ембедингів у сервісі поки немає — лише текст.
Структурований вивід продукт просить промптом і валідує сам.

## Розробка

```bash
cd clients/python && uv run --with pytest pytest -q
```

Тести ходять у `httpx.MockTransport` з тілами тієї форми, яку віддає
`src/http/server.ts`: якщо сервіс її змінить, вони мають упасти першими.
