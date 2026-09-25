import { cn } from '@exo/kit-ui';
import { useEffect } from 'react';
import { api, type Me } from './api';
import { ErrorBox, useLoad } from './components/ui';
import { PAGES, go, pathOf, useRoute, type Page } from './router';
import { Overview } from './pages/Overview';
import { Usage } from './pages/Usage';
import { Journal } from './pages/Journal';
import { Sandbox } from './pages/Sandbox';
import { DocEditor } from './pages/DocEditor';
import { Upstream } from './pages/Upstream';
import { Settings } from './pages/Settings';
import { Audit } from './pages/Audit';

export function App() {
  const route = useRoute();
  const me = useLoad(() => api<Me>('/me'), []);
  const title = PAGES.find((p) => p.page === route.page)?.label ?? '';
  useEffect(() => {
    document.title = `${title} · blackgate`;
  }, [title]);

  return (
    <div className="grid min-h-screen grid-cols-1 md:grid-cols-[13rem_1fr]">
      <aside className="border-b border-line bg-sunken md:border-r md:border-b-0">
        <div className="flex items-center gap-2 px-4 py-3 md:py-4">
          <strong className="font-semibold tracking-tight">blackgate</strong>
          <span className="truncate text-xs text-ink-tertiary">{me.data ? `${me.data.version} · ${me.data.user}` : ''}</span>
        </div>
        <nav aria-label="Розділи" className="flex gap-1 overflow-x-auto px-2 pb-2 md:grid md:overflow-visible md:pb-4">
          {PAGES.map((p) => (
            <NavLink key={p.page} page={p.page} label={p.label} active={route.page === p.page} />
          ))}
        </nav>
      </aside>
      <main className="min-w-0 px-4 pt-5 pb-16 md:px-8">
        <div className="mx-auto grid w-full max-w-6xl content-start gap-6">
          <h1 className="text-2xl font-semibold">{title}</h1>
          <ErrorBox error={me.error} title="Панель не відповідає" />
          {route.page === 'overview' && <Overview />}
          {route.page === 'usage' && <Usage params={route.params} />}
          {route.page === 'journal' && <Journal params={route.params} id={route.id} />}
          {route.page === 'sandbox' && <Sandbox params={route.params} />}
          {route.page === 'catalog' && <DocEditor kind="catalog" />}
          {route.page === 'stub' && <DocEditor kind="stub" />}
          {route.page === 'upstream' && <Upstream />}
          {route.page === 'settings' && <Settings />}
          {route.page === 'audit' && <Audit params={route.params} />}
        </div>
      </main>
    </div>
  );
}

function NavLink({ page, label, active }: { page: Page; label: string; active: boolean }) {
  const href = pathOf(page);
  return (
    <a
      href={href}
      onClick={(e) => go(e, href)}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'shrink-0 rounded-control px-3 py-1.5 text-sm whitespace-nowrap transition-colors',
        active ? 'bg-accent/15 font-medium text-ink' : 'text-ink-secondary hover:bg-lift hover:text-ink',
      )}
    >
      {label}
    </a>
  );
}
