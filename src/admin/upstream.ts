/**
 * Підписки апстріму — лише ЧИТАННЯ з Management API `cli-proxy-api-plus` (двигун
 * під VibeConduit, MIT).
 *
 * Вхід в Antigravity / Claude / Codex blackgate не пише і не повторює: у двигуні
 * є свій Management Center (`/management.html`) з OAuth і вставкою адреси
 * повернення на віддаленому сервері. Панель blackgate показує стан акаунтів і
 * веде туди.
 *
 * Management API вмикає лише власник (`remote-management` у конфігу VibeConduit
 * під `/home/exo`, агентові недоступний) — доти він віддає 404, і розділ каже
 * «не ввімкнено» з інструкцією. Ключ — `UPSTREAM_MANAGEMENT_KEY`.
 *
 * ЗАПОБІЖНИК: двигун банить IP на ~30 хв після 5 невдалих ключів. Панель
 * оновлюється кожні кілька секунд, тож відхилений ключ за хвилину забанив би
 * адресу контейнера — разом із самим blackgate, який ходить у той самий порт.
 * Тому 401/403 один раз — і 35 хв тиші, а не повтор.
 */

export type UpstreamAdminState =
  | { state: 'no_key' }
  | { state: 'disabled'; detail: string }
  | { state: 'key_rejected'; until: string }
  | { state: 'error'; detail: string }
  | { state: 'ok'; authFiles: unknown; usage: unknown };

export interface UpstreamAdminConfig {
  baseUrl: string;
  key: string | null | undefined;
  fetchImpl?: typeof fetch;
  cacheMs?: number;
  lockMs?: number;
  now?: () => number;
}

export function createUpstreamAdmin(config: UpstreamAdminConfig) {
  const f = config.fetchImpl ?? fetch;
  const cacheMs = config.cacheMs ?? 60_000;
  const lockMs = config.lockMs ?? 35 * 60_000;
  const now = config.now ?? (() => Date.now());
  let cached: { at: number; value: UpstreamAdminState } | null = null;
  let lockedUntil = 0;
  let inflight: Promise<UpstreamAdminState> | null = null;

  async function get(path: string): Promise<{ status: number; body: unknown }> {
    const res = await f(new URL(path, config.baseUrl), {
      headers: { Authorization: `Bearer ${config.key}` },
      signal: AbortSignal.timeout(5_000),
    });
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* текст як є */ }
    return { status: res.status, body };
  }

  async function load(): Promise<UpstreamAdminState> {
    if (!config.key) return { state: 'no_key' };
    if (now() < lockedUntil) return { state: 'key_rejected', until: new Date(lockedUntil).toISOString() };
    try {
      const files = await get('/v0/management/auth-files');
      if (files.status === 401 || files.status === 403) {
        lockedUntil = now() + lockMs;
        return { state: 'key_rejected', until: new Date(lockedUntil).toISOString() };
      }
      if (files.status === 404) {
        return { state: 'disabled', detail: 'Management API вимкнений (404 на /v0/management/*)' };
      }
      if (files.status !== 200) return { state: 'error', detail: `auth-files: HTTP ${files.status}` };
      // Облік двигуна — необов'язковий: у деяких версіях його немає.
      const usage = await get('/v0/management/usage').catch(() => null);
      return { state: 'ok', authFiles: files.body, usage: usage && usage.status === 200 ? usage.body : null };
    } catch (err) {
      return { state: 'error', detail: (err as Error).message };
    }
  }

  async function status(): Promise<UpstreamAdminState> {
    if (cached && now() - cached.at < cacheMs) return cached.value;
    // Кілька вкладок панелі одночасно — один запит до двигуна, не кілька.
    inflight ??= load().finally(() => { inflight = null; });
    const value = await inflight;
    cached = { at: now(), value };
    return value;
  }

  return { status };
}

export type UpstreamAdmin = ReturnType<typeof createUpstreamAdmin>;
