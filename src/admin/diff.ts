/**
 * Різниця двох текстів порядково — для аудиту дій і для «перевірити» в панелі.
 *
 * Власна, а не бібліотека: файли тут — реєстр моделей і заглушка, сотні рядків,
 * і LCS на таблиці n×m для них — мілісекунди. Формат — як в `diff -u` без
 * заголовків: ` ` спільний рядок, `-` прибрано, `+` додано, `@@` — пропуск
 * незмінених рядків, щоб різниця в один рядок не тягла за собою весь файл.
 */

/** Більше — порівнювати не по рядках, а «файл замінено цілком»: таблиця n×m росте квадратом. */
const MAX_CELLS = 4_000_000;

export type DiffOp = { op: ' ' | '-' | '+'; line: string };

export function diffLines(before: string, after: string): DiffOp[] {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length * b.length > MAX_CELLS) {
    return [...a.map((line) => ({ op: '-' as const, line })), ...b.map((line) => ({ op: '+' as const, line }))];
  }

  // Спільні голова й хвіст — поза таблицею: типова правка міняє кілька рядків
  // посередині, і таблиця тоді крихітна.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  const n = am.length;
  const m = bm.length;
  // lcs[i][j] — довжина спільної підпослідовності am[i..] і bm[j..].
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = am[i] === bm[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const out: DiffOp[] = a.slice(0, head).map((line) => ({ op: ' ', line }));
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (am[i] === bm[j]) {
      out.push({ op: ' ', line: am[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ op: '-', line: am[i++]! });
    } else {
      out.push({ op: '+', line: bm[j++]! });
    }
  }
  while (i < n) out.push({ op: '-', line: am[i++]! });
  while (j < m) out.push({ op: '+', line: bm[j++]! });
  for (const line of a.slice(a.length - tail)) out.push({ op: ' ', line });
  return out;
}

/** Текст різниці з контекстом `context` рядків навколо змін. Порожній рядок — змін немає. */
export function unifiedDiff(before: string, after: string, context = 3): string {
  const ops = diffLines(before, after);
  if (!ops.some((o) => o.op !== ' ')) return '';

  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, idx) => {
    if (o.op === ' ') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++) keep[k] = true;
  });

  const lines: string[] = [];
  let skipped = 0;
  ops.forEach((o, idx) => {
    if (!keep[idx]) {
      skipped++;
      return;
    }
    if (skipped > 0) {
      lines.push(`@@ пропущено ${skipped} незмінених рядків @@`);
      skipped = 0;
    }
    lines.push(`${o.op}${o.line}`);
  });
  if (skipped > 0) lines.push(`@@ пропущено ${skipped} незмінених рядків @@`);
  return `${lines.join('\n')}\n`;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  // Останній перевід рядка — кінець файла, а не порожній рядок після нього.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}
