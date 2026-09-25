/** Щільна вісь: пропущені години/дні — нулі для лічильників, розриви для латентності. */
export function densify<T extends { t: string }>(
  rows: T[], unit: 'hour' | 'day', hours: number, now = Date.now(),
): { x: number[]; at: (i: number) => T | undefined } {
  const step = unit === 'hour' ? 3600 : 86400;
  const end = Math.floor(now / 1000 / step) * step;
  const start = end - Math.ceil((hours * 3600) / step) * step + step;
  const byT = new Map(rows.map((r) => [Math.floor(new Date(r.t).getTime() / 1000 / step) * step, r]));
  const x: number[] = [];
  for (let t = start; t <= end; t += step) x.push(t);
  return { x, at: (i) => byT.get(x[i]!) };
}
