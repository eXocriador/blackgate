import { cn } from '@exo/kit-ui';

/**
 * Різниця, як її пише сервер (`src/admin/diff.ts`): ` ` спільне, `-` прибрано,
 * `+` додано, `@@` — пропуск. Колір — роль, не відтінок: видалене critical,
 * додане ok; знак лишається в тексті, тож різницю видно й без кольору.
 */
export function Diff({ text, className }: { text: string; className?: string }) {
  if (!text) return <p className="text-sm text-ink-tertiary">Змін немає.</p>;
  const lines = text.replace(/\n$/, '').split('\n');
  return (
    <pre className={cn('max-h-[28rem] overflow-auto rounded-control border border-line bg-sunken py-2 font-mono text-xs leading-relaxed', className)}>
      {lines.map((line, i) => {
        const op = line.startsWith('@@') ? '@' : line[0];
        return (
          <div
            key={i}
            className={cn(
              'px-3 whitespace-pre-wrap break-words',
              op === '+' && 'bg-ok/12 text-ok',
              op === '-' && 'bg-critical/10 text-critical',
              op === '@' && 'py-0.5 text-ink-tertiary italic',
            )}
          >
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}
