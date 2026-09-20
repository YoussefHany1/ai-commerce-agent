import { test, expect, describe, vi, afterEach } from 'vitest';
import { mapSallaProduct, mapSallaOrder, SallaAdapter } from './salla.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('salla mapping', () => {
  test('maps a sale product with price and currency', () => {
    const p = mapSallaProduct({
      id: 101,
      name: 'سيروم فيتامين سي',
      status: 'sale',
      quantity: 12,
      price: { amount: '89.50', currency: 'SAR' },
      sku: 'SRM-C',
      description: 'وصف',
      url: 'https://salla.sa/p/101',
    });
    expect(p.id).toBe('101');
    expect(p.title).toBe('سيروم فيتامين سي');
    expect(p.price).toBe(89.5);
    expect(p.currency).toBe('SAR');
    expect(p.available).toBe(true);
    expect(p.sku).toBe('SRM-C');
  });

  test('marks out-of-stock products as unavailable', () => {
    const p = mapSallaProduct({ id: 1, name: 'منتج', status: 'sale', quantity: 0 });
    expect(p.available).toBe(false);
  });

  test('marks unlimited quantity as available even with zero count', () => {
    const p = mapSallaProduct({ id: 1, name: 'منتج', status: 'sale', quantity: 0, unlimited_quantity: true });
    expect(p.available).toBe(true);
  });

  test('maps hidden products as unavailable', () => {
    const p = mapSallaProduct({ id: 2, name: 'منتج', status: 'hidden' });
    expect(p.available).toBe(false);
  });

  test('maps an order with customer info', () => {
    const o = mapSallaOrder({
      id: 9001,
      status: { name: 'مكتمل', slug: 'completed' },
      payment_method: { name: 'مدى' },
      amounts: { total: { amount: '250', currency: 'SAR' } },
      currency: 'SAR',
      customer: { first_name: 'محمد', last_name: 'العتيبي', mobile: '0501234567', email: 'm@example.com' },
    });
    expect(o.id).toBe('9001');
    expect(o.status).toBe('مكتمل');
    expect(o.paymentStatus).toBe('مدى');
    expect(o.total).toBe(250);
    expect(o.currency).toBe('SAR');
    expect(o.customer?.name).toBe('محمد العتيبي');
    expect(o.customer?.phone).toBe('0501234567');
  });
});

describe('salla adapter', () => {
  test('listProducts paginates and normalizes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = new URL(url);
        const page = Number(u.searchParams.get('page') ?? '1');
        return {
          ok: true,
          async json() {
            if (page > 1) return { status: 200, success: true, data: [] };
            return {
              status: 200,
              success: true,
              data: [
                { id: 1, name: 'أ', status: 'sale', quantity: 5, price: { amount: '10', currency: 'SAR' } },
                { id: 2, name: 'ب', status: 'out', price: { amount: '20', currency: 'SAR' } },
              ],
              pagination: { currentPage: 1, totalPages: 2, totalItems: 2 },
            };
          },
        } as Response;
      }),
    );
    const adapter = new SallaAdapter('tok');
    const products = await adapter.listProducts();
    expect(products).toHaveLength(2);
    expect(products[0].available).toBe(true);
    expect(products[1].available).toBe(false);
  });

  test('searchProducts falls back to list filtering when keyword search fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    const adapter = new SallaAdapter('tok');
    (adapter as any).listProducts = async () => [
      { id: '1', title: 'Face Serum', price: 50, currency: 'SAR', available: true },
      { id: '2', title: 'Body Lotion', price: 30, currency: 'SAR', available: true },
    ];
    const res = await adapter.searchProducts('face');
    expect(res).toHaveLength(1);
    expect(res[0].title).toBe('Face Serum');
  });
});