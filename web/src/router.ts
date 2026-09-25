/**
 * Маршрути панелі без бібліотеки: `pathname` вирішує сторінку, `pushState` +
 * `popstate` — переходи, фільтри живуть у `?…`, тож посилання на відфільтрований
 * журнал можна переслати. Той самий підхід, що у filebrowser.
 */
import { useEffect, useState, type MouseEvent } from 'react';

export type Page =
  | 'overview' | 'usage' | 'journal' | 'sandbox' | 'catalog' | 'stub' | 'upstream' | 'settings' | 'audit';

export interface Route {
  page: Page;
  /** `/journal/42` → 42. */
  id: number | null;
  params: URLSearchParams;
}

export const PAGES: ReadonlyArray<{ page: Page; path: string; label: string }> = [
  { page: 'overview', path: '/', label: 'Огляд' },
  { page: 'usage', path: '/usage', label: 'Облік' },
  { page: 'journal', path: '/journal', label: 'Журнал' },
  { page: 'sandbox', path: '/sandbox', label: 'Пісочниця' },
  { page: 'catalog', path: '/catalog', label: 'Реєстр' },
  { page: 'stub', path: '/stub', label: 'Заглушка' },
  { page: 'upstream', path: '/upstream', label: 'Підписки' },
  { page: 'settings', path: '/settings', label: 'Налаштування' },
  { page: 'audit', path: '/audit', label: 'Аудит дій' },
];

export function parseRoute(pathname: string, search: string): Route {
  const clean = pathname.replace(/\/+$/, '') || '/';
  const params = new URLSearchParams(search);
  const m = /^\/journal\/(\d+)$/.exec(clean);
  if (m) return { page: 'journal', id: Number(m[1]), params };
  const hit = PAGES.find((p) => p.path === clean);
  // Невідомий шлях — огляд: сервер віддає index.html на будь-що поза /admin/api.
  return { page: hit?.page ?? 'overview', id: null, params };
}

export function pathOf(page: Page, id: number | null = null, params?: Record<string, string | null | undefined>): string {
  const base = PAGES.find((p) => p.page === page)!.path;
  const path = id !== null ? `${base}/${id}` : base;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

const EVENT = 'blackgate:navigate';

export function navigate(to: string, replace = false): void {
  if (replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  window.dispatchEvent(new Event(EVENT));
}

/** Посилання всередині панелі — без перезавантаження; Ctrl/⌘-клік лишається браузеру. */
export function go(e: MouseEvent, to: string): void {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigate(to);
}

export function useRoute(): Route {
  const read = () => parseRoute(window.location.pathname, window.location.search);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('popstate', on);
    window.addEventListener(EVENT, on);
    return () => {
      window.removeEventListener('popstate', on);
      window.removeEventListener(EVENT, on);
    };
  }, []);
  return route;
}
