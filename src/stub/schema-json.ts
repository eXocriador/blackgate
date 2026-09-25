/**
 * JSON-відповідь заглушки, побудована з JSON Schema у системному промпті.
 *
 * Структурована стадія продукту (exopost `classify`, `generate`, `lesson`)
 * кладе схему відповіді просто в промпт — `schema_hint` у `exopost_ai`, дамп
 * `model_json_schema()` pydantic окремим рядком шаблону. blackgate про схеми
 * нічого не знає і знати не мусить, але заглушка, що на таку стадію
 * відповідає текстом, зупиняє конвеєр на першому ж кроці: `parse_json` падає,
 * повтор-лагодження отримує той самий текст, стадія — `AIResponseError`.
 *
 * Тому заглушка шукає схему в промпті й будує з неї найменший екземпляр, що
 * її задовольняє: обов'язкові поля, перше значення `enum`, нижня межа чисел,
 * `minItems` елементів масиву. Рядки несуть `[stub]`, щоб підробку було видно
 * й у готовому пості. Валідаторів поверх схеми (pydantic `field_validator`)
 * звідси не видно — для такої стадії є готові відповіді в `stub.yaml`.
 */

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Schema = Record<string, unknown>;

const MAX_DEPTH = 8;
/** Скільки кандидатів на схему пробувати в одному промпті. Промпт — чужий текст. */
const MAX_CANDIDATES = 200;

/**
 * Остання JSON Schema в текстах, або `null`.
 *
 * Остання, а не перша: `_system_text` у exopost дописує схему в КІНЕЦЬ
 * промпту, а приклади в тілі шаблону теж бувають схожими на JSON. Кандидат —
 * `{` на початку рядка (так його кладе `{{ schema }}` і `json.dumps(indent=2)`);
 * схема — об'єкт із `properties`, `$defs` або `type: "object"`.
 */
export function findSchema(texts: readonly string[]): Schema | null {
  let found: Schema | null = null;
  let tried = 0;
  for (const text of texts) {
    for (let i = 0; i < text.length && tried < MAX_CANDIDATES; i++) {
      if (text[i] !== '{' || (i > 0 && text[i - 1] !== '\n')) continue;
      tried++;
      const end = matchingBrace(text, i);
      if (end === -1) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text.slice(i, end + 1));
      } catch {
        continue;
      }
      if (isSchema(parsed)) {
        found = parsed;
        i = end;
      }
    }
  }
  return found;
}

function isSchema(v: unknown): v is Schema {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const s = v as Schema;
  return typeof s['properties'] === 'object' || typeof s['$defs'] === 'object' || s['type'] === 'object';
}

/** Індекс `}`, що закриває `{` на `start`, з урахуванням рядків JSON. */
function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Найменший екземпляр схеми. `now` — щоб тести не залежали від годинника. */
export function instanceOf(root: Schema, now: Date = new Date()): Json {
  return build(root, root, 'value', 0, now);
}

function build(s: Schema, root: Schema, name: string, depth: number, now: Date): Json {
  if (depth > MAX_DEPTH) return null;

  const ref = s['$ref'];
  if (typeof ref === 'string') {
    const target = resolveRef(root, ref);
    return target ? build(target, root, name, depth + 1, now) : null;
  }
  if ('const' in s) return s['const'] as Json;
  if (Array.isArray(s['enum']) && s['enum'].length > 0) return s['enum'][0] as Json;

  // `Optional[X]` у pydantic — `anyOf: [X, {type: null}]`. Беремо X: порожнє
  // поле підробку не показує, а заповнене — показує.
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const options = s[key];
    if (Array.isArray(options) && options.length > 0) {
      const branch = (options as Schema[]).find((o) => o['type'] !== 'null') ?? options[0];
      return build(branch as Schema, root, name, depth + 1, now);
    }
  }

  const type = pickType(s['type']);
  switch (type) {
    case 'object': return objectOf(s, root, depth, now);
    case 'array': return arrayOf(s, root, name, depth, now);
    case 'string': return stringOf(s, name, now);
    case 'integer': return numberOf(s, true);
    case 'number': return numberOf(s, false);
    case 'boolean': return false;
    case 'null': return null;
    default:
      // Без типу, але з полями — теж об'єкт (так буває в `$defs`).
      return typeof s['properties'] === 'object' ? objectOf(s, root, depth, now) : null;
  }
}

function pickType(t: unknown): string | null {
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) return (t.find((x) => x !== 'null') as string | undefined) ?? 'null';
  return null;
}

function resolveRef(root: Schema, ref: string): Schema | null {
  if (!ref.startsWith('#/')) return null;
  let node: unknown = root;
  for (const part of ref.slice(2).split('/')) {
    if (typeof node !== 'object' || node === null) return null;
    node = (node as Schema)[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return typeof node === 'object' && node !== null ? (node as Schema) : null;
}

function objectOf(s: Schema, root: Schema, depth: number, now: Date): Json {
  const props = (s['properties'] ?? {}) as Record<string, Schema>;
  const out: Record<string, Json> = {};
  // Усі поля, а не лише `required`: необов'язкове поле з дефолтом pydantic
  // заповнив би сам, але тоді підробку в ньому не видно.
  for (const [key, sub] of Object.entries(props)) {
    out[key] = build(sub, root, key, depth + 1, now);
  }
  return out;
}

function arrayOf(s: Schema, root: Schema, name: string, depth: number, now: Date): Json {
  const min = typeof s['minItems'] === 'number' ? s['minItems'] : 1;
  const max = typeof s['maxItems'] === 'number' ? s['maxItems'] : Infinity;
  const count = Math.min(Math.max(min, 1), max);
  const items = s['items'];
  if (Array.isArray(items)) {
    return (items as Schema[]).map((it) => build(it, root, name, depth + 1, now));
  }
  if (typeof items !== 'object' || items === null) return [];
  return Array.from({ length: count }, () => build(items as Schema, root, name, depth + 1, now));
}

function stringOf(s: Schema, name: string, now: Date): string {
  switch (s['format']) {
    case 'date-time': return now.toISOString();
    case 'date': return now.toISOString().slice(0, 10);
    case 'time': return now.toISOString().slice(11, 19);
    case 'uri': case 'url': return 'https://example.com/stub';
    case 'email': return 'stub@example.com';
    case 'uuid': return '00000000-0000-4000-8000-000000000000';
  }
  let v = `[stub] ${name}`;
  const min = typeof s['minLength'] === 'number' ? s['minLength'] : 0;
  while (v.length < min) v += ' stub';
  const max = typeof s['maxLength'] === 'number' ? s['maxLength'] : Infinity;
  return v.slice(0, max);
}

function numberOf(s: Schema, integer: boolean): number {
  const step = integer ? 1 : 0.5;
  let v = 0;
  if (typeof s['minimum'] === 'number') v = s['minimum'];
  else if (typeof s['exclusiveMinimum'] === 'number') v = s['exclusiveMinimum'] + step;
  if (typeof s['maximum'] === 'number') v = Math.min(v, s['maximum']);
  else if (typeof s['exclusiveMaximum'] === 'number') v = Math.min(v, s['exclusiveMaximum'] - step);
  return integer ? Math.ceil(v) : v;
}
