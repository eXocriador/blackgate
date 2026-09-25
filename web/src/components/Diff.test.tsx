import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Diff } from './Diff';

describe('Diff', () => {
  it('знак лишається в тексті — різницю видно й без кольору', () => {
    const { container } = render(<Diff text={'@@ пропущено 3 незмінених рядків @@\n a\n-b\n+c\n'} />);
    const lines = [...container.querySelectorAll('pre > div')].map((d) => d.textContent);
    expect(lines).toEqual(['@@ пропущено 3 незмінених рядків @@', ' a', '-b', '+c']);
  });
  it('порожня різниця — «змін немає»', () => {
    const { container } = render(<Diff text="" />);
    expect(container.textContent).toContain('Змін немає');
  });
});
