import { useEffect, useRef } from 'react';
import uPlot, { type AlignedData, type Options } from 'uplot';

/**
 * Часовий ряд на uPlot. Кольори — ролі теми (`--accent`, `--ok`…), але canvas
 * не читає CSS-змінних, а `light-dark()` у змінній не обчислюється через
 * getPropertyValue. Тож колір розв'язується пробою: елемент із `color:
 * var(--роль)` і його обчислений `color`. Зміна теми ОС — перемалювати.
 */
export type Role = 'accent' | 'ok' | 'caution' | 'critical' | 'ink-tertiary';

export interface Series {
  label: string;
  values: Array<number | null>;
  role: Role;
  bars?: boolean;
  dash?: boolean;
}

const VAR: Record<Role, string> = {
  accent: '--accent', ok: '--ok', caution: '--caution', critical: '--critical', 'ink-tertiary': '--text-tertiary',
};

function resolve(cssVar: string, host: HTMLElement): string {
  const probe = document.createElement('span');
  probe.style.color = `var(${cssVar})`;
  probe.style.display = 'none';
  host.appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  return c || '#888';
}

function withAlpha(rgb: string, a: number): string {
  const m = /rgba?\(([^)]+)\)/.exec(rgb);
  if (!m) return rgb;
  const [r, g, b] = m[1]!.split(',').map((x) => x.trim());
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export function Chart({
  x, series, height = 200, format = (v: number) => String(v), unit,
}: {
  /** Секунди Unix. */
  x: number[];
  series: Series[];
  height?: number;
  format?: (v: number) => string;
  unit: 'hour' | 'day';
}) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let plot: uPlot | null = null;

    const draw = () => {
      plot?.destroy();
      const axis = resolve('--text-tertiary', el);
      const grid = resolve('--line', el);
      const opts: Options = {
        width: el.clientWidth || 600,
        height,
        legend: { show: true },
        cursor: { points: { size: 6 } },
        scales: { x: { time: true } },
        axes: [
          {
            stroke: axis, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid },
            values: (_u, splits) => splits.map((s) => {
              const d = new Date(s * 1000);
              return unit === 'day'
                ? d.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' })
                : d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
            }),
          },
          { stroke: axis, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, size: 56, values: (_u, s) => s.map(format) },
        ],
        series: [
          { value: (_u, v) => (v === null ? '—' : new Date(v * 1000).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' })) },
          ...series.map((s) => {
            const color = resolve(VAR[s.role], el);
            return {
              label: s.label,
              stroke: color,
              width: s.bars ? 0 : 1.5,
              fill: s.bars ? withAlpha(color, 0.55) : undefined,
              dash: s.dash ? [4, 4] : undefined,
              points: { show: false },
              spanGaps: false,
              paths: s.bars ? uPlot.paths.bars!({ size: [0.7, 40] }) : undefined,
              value: (_u: uPlot, v: number | null) => (v === null ? '—' : format(v)),
            };
          }),
        ],
      };
      const data = [x, ...series.map((s) => s.values)] as AlignedData;
      plot = new uPlot(opts, data, el);
    };

    draw();
    const ro = new ResizeObserver(() => plot?.setSize({ width: el.clientWidth, height }));
    ro.observe(el);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', draw);
    return () => {
      ro.disconnect();
      mq.removeEventListener('change', draw);
      plot?.destroy();
    };
  }, [x, series, height, format, unit]);

  return <div ref={host} className="w-full min-w-0" />;
}
