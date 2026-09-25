/** Числа, час і тривалість — українською, у часовому поясі браузера. */

const int = new Intl.NumberFormat('uk-UA');

export function n(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : int.format(v);
}

/** 1 234 567 → «1,2 млн»; для підписів осей і плиток. */
export function compact(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toLocaleString('uk-UA', { maximumFractionDigits: 1 })} млн`;
  if (abs >= 10_000) return `${(v / 1000).toLocaleString('uk-UA', { maximumFractionDigits: 0 })} тис.`;
  return int.format(Math.round(v));
}

export function ms(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  if (v < 1000) return `${Math.round(v)} мс`;
  if (v < 60_000) return `${(v / 1000).toLocaleString('uk-UA', { maximumFractionDigits: 1 })} с`;
  return `${(v / 60_000).toLocaleString('uk-UA', { maximumFractionDigits: 1 })} хв`;
}

const dt = new Intl.DateTimeFormat('uk-UA', {
  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const dtShort = new Intl.DateTimeFormat('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export function when(iso: string | null | undefined, short = false): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : (short ? dtShort : dt).format(d);
}

/** «5 хв тому», «через 3 хв» — для охолодження пулів і штрафів. */
export function relative(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—';
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  const unit = abs < 60_000 ? `${Math.round(abs / 1000)} с` : abs < 3_600_000 ? `${Math.round(abs / 60_000)} хв` : `${Math.round(abs / 3_600_000)} год`;
  return diff >= 0 ? `через ${unit}` : `${unit} тому`;
}

/** Статус відповіді людською мовою — для журналу. */
export function statusLabel(status: number, error: string | null): string {
  if (status === 200) return 'відповідь';
  if (status === 429) return 'стеля';
  if (status === 401) return 'ключ';
  if (status === 400) return error === 'unknown_tier' ? 'тир' : 'запит';
  if (status === 503) return 'драбина';
  return error ?? String(status);
}

export type Tone = 'neutral' | 'accent' | 'ok' | 'caution' | 'critical';

export function statusTone(status: number): Tone {
  if (status === 200) return 'ok';
  if (status === 429 || status === 400) return 'caution';
  if (status >= 500 || status === 401) return 'critical';
  return 'neutral';
}

export function poolTone(state: string): Tone {
  if (state === 'healthy' || state === 'ok') return 'ok';
  if (state === 'exhausted' || state === 'unknown' || state === 'skip') return 'caution';
  if (state === 'down' || state === 'expired' || state === 'fail') return 'critical';
  return 'neutral';
}

export const POOL_STATE: Record<string, string> = {
  healthy: 'здоровий',
  exhausted: 'вичерпаний',
  down: 'лежить',
  unknown: 'невідомо',
};

export const UPSTREAM_STATE: Record<string, string> = {
  ok: 'вхід живий',
  expired: 'вхід протух',
  down: 'шлюз недосяжний',
  unknown: 'ще невідомо',
};

export const OUTCOME: Record<string, string> = {
  ok: 'відповідь',
  exhausted: '429 пул',
  rejected: '400 форма',
  retired: 'надгробок',
  error: '5xx/мережа',
  timeout: 'таймаут',
  unauthorized: '401/403',
  skipped: 'пропущено',
};
