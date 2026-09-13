import { timingSafeEqual } from 'node:crypto';

/**
 * Ключ на продукт.
 *
 * Розвідка сесії стверджувала, що ключ один на два продукти і розділити
 * витрату за ним неможливо. Пряма звірка 2026-09-13 це спростувала: ключі
 * РІЗНІ (`exointel-…` і `teamself-…`, по 57 символів). Але вони різні лише на
 * вході в шлюз, а шлюз їх не розрізняє, нічого за ними не рахує і не пише —
 * тож наслідок був той самий, що й від спільного ключа. Ключ тут не просто
 * пускає, а НАЗИВАЄ продукт, і саме це ім'я їде в облік.
 */
export interface ProductKeys {
  /** Ім'я продукту за ключем, або null. */
  resolve(key: string | null): string | null;
  readonly products: readonly string[];
}

export class KeyConfigError extends Error {}

/** Розібрати `PRODUCT_KEYS`: "exointel:SECRET,teamself:SECRET". */
export function parseProductKeys(raw: string): ProductKeys {
  const byKey = new Map<string, string>();
  const products: string[] = [];

  for (const piece of raw.split(',')) {
    const entry = piece.trim();
    if (!entry) continue;
    const at = entry.indexOf(':');
    if (at <= 0 || at === entry.length - 1) {
      throw new KeyConfigError(`PRODUCT_KEYS: запис "${entry.slice(0, 12)}…" не має вигляду продукт:секрет`);
    }
    const product = entry.slice(0, at).trim();
    const secret = entry.slice(at + 1).trim();
    if (secret.length < 16) {
      // Довжина, а не значення: повідомлення про ключі не має містити ключів.
      throw new KeyConfigError(`PRODUCT_KEYS: секрет продукту "${product}" коротший за 16 символів`);
    }
    if (byKey.has(secret)) {
      throw new KeyConfigError(`PRODUCT_KEYS: один секрет виданий двом продуктам — облік не розділився б`);
    }
    byKey.set(secret, product);
    products.push(product);
  }

  if (byKey.size === 0) throw new KeyConfigError('PRODUCT_KEYS порожній — сервіс нікого не обслужив би');

  return {
    products,
    resolve(key) {
      if (!key) return null;
      // Порівняння сталого часу по всіх кандидатах: наївний Map.get(key)
      // порівнює рядки достроково і зливає префікс ключа по таймінгу.
      let found: string | null = null;
      for (const [secret, product] of byKey) {
        if (constantTimeEqual(secret, key)) found = product;
      }
      return found;
    },
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // timingSafeEqual вимагає однакової довжини і кидає інакше. Різна довжина
  // сама по собі не секрет — довжину видно і з мережевого пакета.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** `Authorization: Bearer <key>`, або `X-Api-Key: <key>`. */
export function readKey(headers: Record<string, string | string[] | undefined>): string | null {
  const auth = first(headers['authorization']);
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1]!.trim();
  }
  const direct = first(headers['x-api-key']);
  return direct ? direct.trim() : null;
}

function first(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}
