import { describe, expect, it } from 'vitest';
import { compact, ms, relative, statusLabel, statusTone } from './format';
import { parseRoute, pathOf } from './router';
import { densify } from './series';
import { formOf, overridesOf } from './settingsForm';

describe('маршрути', () => {
  it('сторінки, деталь журналу, невідоме — огляд', () => {
    expect(parseRoute('/', '').page).toBe('overview');
    expect(parseRoute('/journal/42', '?back=%2Fjournal').id).toBe(42);
    expect(parseRoute('/journal/', '').page).toBe('journal');
    expect(parseRoute('/nope', '').page).toBe('overview');
  });
  it('шлях з фільтрами — порожні не пишуться', () => {
    expect(pathOf('journal', null, { product: 'exopost', status: '', q: null })).toBe('/journal?product=exopost');
    expect(pathOf('journal', 7)).toBe('/journal/7');
  });
});

describe('формат', () => {
  it('числа, мілісекунди, статуси', () => {
    expect(compact(1_234_567)).toMatch(/1,2 млн/);
    expect(ms(950)).toBe('950 мс');
    expect(ms(2500)).toMatch(/2,5 с/);
    expect(statusLabel(429, 'budget_exhausted')).toBe('стеля');
    expect(statusTone(503)).toBe('critical');
    expect(relative(new Date(10_000 + 120_000).toISOString(), 10_000)).toBe('через 2 хв');
  });
});

describe('densify', () => {
  it('щільна вісь годин: пропуски — undefined, наявні на місці', () => {
    const now = Date.UTC(2026, 8, 25, 12, 30);
    const { x, at } = densify([{ t: '2026-09-25T10:00:00Z', v: 1 }], 'hour', 4, now);
    expect(x).toHaveLength(4);
    expect(new Date(x.at(-1)! * 1000).toISOString()).toBe('2026-09-25T12:00:00.000Z');
    expect(at(1)).toMatchObject({ v: 1 });
    expect(at(0)).toBeUndefined();
  });
});

describe('форма налаштувань ↔ перекриття', () => {
  it('порожнє поле не пишеться; туди й назад без втрат', () => {
    const o = { caps: { subject: 50, products: { exopost: { product: 10 } } }, journal: { storeContent: false } };
    const f = formOf(o, ['exopost', 'teamself']);
    expect(f.products['teamself']).toEqual({ product: '', subject: '' });
    expect(overridesOf(f)).toEqual(o);
    expect(overridesOf(formOf({}, ['exopost']))).toEqual({});
  });
});
