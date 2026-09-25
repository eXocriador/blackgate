import type { Overrides } from './api';

/** Поле форми: рядок; порожньо — «як у .env». */
export interface Form {
  capProduct: string;
  capSubject: string;
  products: Record<string, { product: string; subject: string }>;
  storeContent: '' | 'true' | 'false';
  contentDays: string;
  retentionDays: string;
}

export function formOf(o: Overrides, products: string[]): Form {
  const s = (v: number | undefined) => (v === undefined ? '' : String(v));
  const per: Form['products'] = {};
  for (const p of new Set([...products, ...Object.keys(o.caps?.products ?? {})])) {
    per[p] = { product: s(o.caps?.products?.[p]?.product), subject: s(o.caps?.products?.[p]?.subject) };
  }
  return {
    capProduct: s(o.caps?.product),
    capSubject: s(o.caps?.subject),
    products: per,
    storeContent: o.journal?.storeContent === undefined ? '' : o.journal.storeContent ? 'true' : 'false',
    contentDays: s(o.journal?.contentDays),
    retentionDays: s(o.journal?.retentionDays),
  };
}

/** Форма → перекриття: порожнє поле не пишеться зовсім (діє .env). */
export function overridesOf(f: Form): Overrides {
  const num = (v: string) => (v.trim() === '' ? undefined : Number(v));
  const o: Overrides = {};
  const caps: NonNullable<Overrides['caps']> = {};
  if (num(f.capProduct) !== undefined) caps.product = num(f.capProduct)!;
  if (num(f.capSubject) !== undefined) caps.subject = num(f.capSubject)!;
  const products: Record<string, { product?: number; subject?: number }> = {};
  for (const [p, v] of Object.entries(f.products)) {
    const e: { product?: number; subject?: number } = {};
    if (num(v.product) !== undefined) e.product = num(v.product)!;
    if (num(v.subject) !== undefined) e.subject = num(v.subject)!;
    if (Object.keys(e).length) products[p] = e;
  }
  if (Object.keys(products).length) caps.products = products;
  if (Object.keys(caps).length) o.caps = caps;
  const journal: NonNullable<Overrides['journal']> = {};
  if (f.storeContent) journal.storeContent = f.storeContent === 'true';
  if (num(f.contentDays) !== undefined) journal.contentDays = num(f.contentDays)!;
  if (num(f.retentionDays) !== undefined) journal.retentionDays = num(f.retentionDays)!;
  if (Object.keys(journal).length) o.journal = journal;
  return o;
}
