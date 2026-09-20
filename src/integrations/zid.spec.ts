import { test, expect, describe, vi, afterEach } from 'vitest';
import { mapZidProduct, mapZidOrder, ZidAdapter } from './zid.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('zid mapping', () => {
  test('maps a product with localized name object', () => {
    const p = mapZidProduct({
      id: 'P-1',
      name: { ar: 'شنطة جلدية', en: 'Leather Bag' },
      price: '199.00',
      currency: 'SAR',
      quantity: '4',
      is_published: true,
      is_draft: false,
      html_url: 'https://zid.sa/p/P-1',
      sku: 'BAG-1',
      short_description: { ar: 'وصف', en: 'desc' },
    });
    expect(p.id).toBe('P-1');
    expect(p.title).toBe('Leather Bag');
    expect(p.description).toBe('desc');
    expect(p.price).toBe(199);
    expect(p.currency).toBe('SAR');
    expect(p.available).toBe(true);
    expect(p.sku).toBe('BAG-1');
  });

  test('marks draft or unpublished products as unavailable', () => {
    expect(mapZidProduct({ id: 1, name: 'أ', price: 5, is_draft: true }).available).toBe(false);
    expect(mapZidProduct({ id: 2, name: 'ب', price: 5, is_published: false }).available).toBe(false);
  });

  test('treats infinite stock as available with zero quantity', () => {
    const p = mapZidProduct({ id: 3, name: 'ج', price: 5, quantity: 0, is_infinite: true });
    expect(p.available).toBe(true);
  });

  test('maps an order with display status and customer', () => {
    const o = mapZidOrder({
      id: 'O-77',
      invoice_number: 'INV-77',
      display_status: { code: 'delivered', name: 'تم التوصيل' },
      order_status: { code: 5, name: 'delivered' },
      payment_status: { code: 'paid', name: 'مدفوع' },
      order_total: '450.50',
      currency_code: 'SAR',
      customer: { name: 'سارة', email: 's@example.com', mobile: '0551234567' },
    });
    expect(o.id).toBe('O-77');
    expect(o.status).toBe('تم التوصيل');
    expect(o.paymentStatus).toBe('مدفوع');
    expect(o.total).toBe(450.5);
    expect(o.currency).toBe('SAR');
    expect(o.customer?.name).toBe('سارة');
  });
});

describe('zid adapter', () => {
  test('listProducts unwraps paginated data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = new URL(url);
        const page = Number(u.searchParams.get('page') ?? '1');
        return {
          ok: true,
          async json() {
            if (page > 1) return { success: true, data: { count: 1, results: [] } };
            return {
              success: true,
              data: {
                count: 1,
                results: [
                  { id: '1', name: 'منتج أ', price: '30', quantity: '2', is_published: true },
                ],
              },
            };
          },
        } as Response;
      }),
    );
    const adapter = new ZidAdapter('access', 'auth');
    const products = await adapter.listProducts();
    expect(products).toHaveLength(1);
    expect(products[0].title).toBe('منتج أ');
    expect(products[0].available).toBe(true);
  });

  test('sends both authorization headers', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        capturedHeaders = init?.headers as Record<string, string>;
        return {
          ok: true,
          async json() {
            return { success: true, data: { results: [] } };
          },
        } as Response;
      }),
    );
    const adapter = new ZidAdapter('ACCESS_TOKEN', 'JWT_AUTH');
    await adapter.listProducts();
    expect(capturedHeaders?.['X-Manager-Token']).toBe('ACCESS_TOKEN');
    expect(capturedHeaders?.['Authorization']).toBe('Bearer JWT_AUTH');
  });
});