/**
 * Basic-автентифікація панелі — ДРУГА, у самому застосунку.
 *
 * Перша стоїть у Traefik. Але порт 3001 досяжний і повз Traefik: будь-який
 * контейнер мереж `proxy` чи `internal` дістане `blackgate-web:3001` напряму, і
 * без перевірки тут панель керування шлюзом до моделей була б відкрита всім
 * сусідам. Тому застосунок сам перевіряє той самий рядок htpasswd
 * (`ADMIN_HTPASSWD`), що й Traefik: власник логіниться раз, обидва шари
 * пропускають.
 *
 * Формати: bcrypt (`$2a$`/`$2b$`/`$2y$`) і apr1 (`$apr1$`, `openssl passwd
 * -apr1`) — другий, бо саме ним записаний пароль `traefik-auth`
 * (infrastructure/traefik/.env), і той самий рядок має підходити тут.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';

export interface HtpasswdEntry {
  user: string;
  hash: string;
}

export class HtpasswdError extends Error {}

/**
 * `user:hash` через кому або з нового рядка — як у мітці Traefik
 * (`basicauth.users`) і як у файлі htpasswd. Лапки навколо значення — з `.env`,
 * якщо його прочитали не через compose.
 */
export function parseHtpasswd(raw: string): HtpasswdEntry[] {
  const text = raw.trim().replace(/^'(.*)'$/s, '$1').replace(/^"(.*)"$/s, '$1');
  const out: HtpasswdEntry[] = [];
  for (const piece of text.split(/[,\n]/)) {
    const line = piece.trim();
    if (!line) continue;
    const at = line.indexOf(':');
    if (at <= 0) throw new HtpasswdError('ADMIN_HTPASSWD: запис не має вигляду user:hash');
    const user = line.slice(0, at);
    const hash = line.slice(at + 1);
    if (!/^\$(2[aby]|apr1)\$/.test(hash)) {
      // Формат, а не значення: повідомлення про секрети не має містити секретів.
      throw new HtpasswdError(`ADMIN_HTPASSWD: хеш користувача "${user}" не bcrypt і не apr1`);
    }
    out.push({ user, hash });
  }
  if (out.length === 0) throw new HtpasswdError('ADMIN_HTPASSWD порожній');
  return out;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (hash.startsWith('$apr1$')) {
    const salt = hash.slice(6).split('$')[0] ?? '';
    return safeEqual(apr1(password, salt), hash);
  }
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * Apache MD5-crypt (`$apr1$`) — алгоритм Поула-Хеннінга Кампа з магією `$apr1$`.
 * Перевірено векторами `openssl passwd -apr1` (test/admin.test.ts).
 */
export function apr1(password: string, rawSalt: string): string {
  const magic = '$apr1$';
  const pw = Buffer.from(password, 'utf8');
  const salt = Buffer.from(rawSalt.slice(0, 8), 'utf8');
  const md5 = () => createHash('md5');

  let final = md5().update(pw).update(salt).update(pw).digest();
  const ctx = md5().update(pw).update(magic).update(salt);
  for (let pl = pw.length; pl > 0; pl -= 16) ctx.update(final.subarray(0, Math.min(16, pl)));
  for (let i = pw.length; i; i >>= 1) ctx.update(i & 1 ? Buffer.from([0]) : pw.subarray(0, 1));
  final = ctx.digest();

  for (let i = 0; i < 1000; i++) {
    const c = md5();
    c.update(i & 1 ? pw : final);
    if (i % 3) c.update(salt);
    if (i % 7) c.update(pw);
    c.update(i & 1 ? final : pw);
    final = c.digest();
  }

  const to64 = (v: number, n: number) => {
    let s = '';
    for (let k = 0; k < n; k++) {
      s += ITOA64[v & 0x3f];
      v >>= 6;
    }
    return s;
  };
  const f = final;
  const encoded =
    to64((f[0]! << 16) | (f[6]! << 8) | f[12]!, 4) +
    to64((f[1]! << 16) | (f[7]! << 8) | f[13]!, 4) +
    to64((f[2]! << 16) | (f[8]! << 8) | f[14]!, 4) +
    to64((f[3]! << 16) | (f[9]! << 8) | f[15]!, 4) +
    to64((f[4]! << 16) | (f[10]! << 8) | f[5]!, 4) +
    to64(f[11]!, 2);
  return `${magic}${salt.toString('utf8')}$${encoded}`;
}

export interface BasicAuthConfig {
  entries: HtpasswdEntry[];
  /** Скільки пам'ятати вдалу перевірку: bcrypt свідомо повільний, а SPA шле десятки запитів. */
  cacheMs?: number;
  /** Невдач на джерело за вікно — далі 429 до кінця вікна. */
  maxFailures?: number;
  windowMs?: number;
  now?: () => number;
}

export type AuthVerdict =
  | { ok: true; user: string }
  | { ok: false; reason: 'missing' | 'invalid' | 'locked' };

export function createBasicAuth(config: BasicAuthConfig) {
  const cacheMs = config.cacheMs ?? 5 * 60_000;
  const maxFailures = config.maxFailures ?? 20;
  const windowMs = config.windowMs ?? 5 * 60_000;
  const now = config.now ?? (() => Date.now());
  const byUser = new Map(config.entries.map((e) => [e.user, e.hash]));

  /** Ключ кешу — хеш заголовка, не сам заголовок: пароль у пам'яті відкритим текстом не лежить. */
  const cache = new Map<string, { user: string; until: number }>();
  const failures = new Map<string, { count: number; since: number }>();

  async function check(header: string | undefined, source: string): Promise<AuthVerdict> {
    const f = failures.get(source);
    if (f && now() - f.since < windowMs && f.count >= maxFailures) return { ok: false, reason: 'locked' };

    const m = header ? /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header) : null;
    if (!m) return { ok: false, reason: 'missing' };

    const key = createHash('sha256').update(m[1]!).digest('hex');
    const hit = cache.get(key);
    if (hit && hit.until > now()) return { ok: true, user: hit.user };

    const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
    const at = decoded.indexOf(':');
    const user = at >= 0 ? decoded.slice(0, at) : decoded;
    const password = at >= 0 ? decoded.slice(at + 1) : '';
    const hash = byUser.get(user);
    // Невідомий користувач проходить ту саму роботу, що й відомий: інакше
    // час відповіді казав би, які імена існують.
    const ok = await verifyPassword(password, hash ?? config.entries[0]!.hash);
    if (ok && hash) {
      if (cache.size > 200) cache.clear();
      cache.set(key, { user, until: now() + cacheMs });
      failures.delete(source);
      return { ok: true, user };
    }

    const prev = failures.get(source);
    if (!prev || now() - prev.since >= windowMs) failures.set(source, { count: 1, since: now() });
    else prev.count++;
    if (failures.size > 1000) failures.clear();
    return { ok: false, reason: 'invalid' };
  }

  return { check };
}

export type BasicAuth = ReturnType<typeof createBasicAuth>;
