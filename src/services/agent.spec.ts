import { test, expect, describe, vi } from 'vitest';

vi.mock('../db/repos.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/repos.js')>();
  return {
    ...(actual as object),
    catalogRepo: { list: vi.fn() },
    customerRepo: { findByContact: vi.fn() },
    orderRepo: { byPlatformId: vi.fn(), listByCustomer: vi.fn() },
  };
});
vi.mock('./retrieval.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./retrieval.js')>();
  return {
    ...(actual as object),
    retrieve: vi.fn(),
  };
});
vi.mock('../integrations/factory.js', () => ({
  getCommerceAdapter: vi.fn().mockResolvedValue(null),
}));

describe('agent tool loop', () => {
  test('returns reply immediately when model makes no tool calls', async () => {
    const { runToolLoop } = await import('./agent.js');
    const create = vi.fn().mockResolvedValue({ output_text: 'مرحباً، كيف أساعدك؟', output: [] });
    const res = await runToolLoop('store-1', 'السلام عليكم', create);
    expect(res.reply).toBe('مرحباً، كيف أساعدك؟');
    expect(res.toolRuns).toHaveLength(0);
    expect(create).toHaveBeenCalledTimes(1);
  });

  test('executes a search_products call and feeds the result back to the model', async () => {
    const { runToolLoop } = await import('./agent.js');
    const catalogRepo = (await import('../db/repos.js')).catalogRepo;
    const retrieval = (await import('./retrieval.js')).retrieve;
    vi.mocked(retrieval).mockResolvedValueOnce([
      {
        product: { id: 'p1', title: 'سيروم', price: 50, currency: 'SAR', available: true },
        score: 1,
        source: 'fts',
      },
    ]);

    const create = vi
      .fn()
      .mockResolvedValueOnce({
        output_text: undefined,
        output: [
          {
            type: 'function_call',
            call_id: 'call-1',
            name: 'search_products',
            arguments: JSON.stringify({ query: 'سيروم', limit: 5 }),
          },
        ],
      })
      .mockResolvedValueOnce({
        output_text: 'لدينا سيروم بسعر 50 ريال',
        output: [],
      });

    const res = await runToolLoop('store-1', 'عندك سيروم؟', create);
    expect(res.toolRuns).toHaveLength(1);
    expect(res.toolRuns[0].name).toBe('search_products');
    expect(res.toolRuns[0].output).toContain('سيروم');
    expect(res.reply).toContain('سيروم');
    expect(create).toHaveBeenCalledTimes(2);
    expect(catalogRepo.list).not.toHaveBeenCalled();
  });

  test('stops after MAX_TOOL_ROUNDS and returns fallback', async () => {
    const { runToolLoop } = await import('./agent.js');
    const create = vi.fn().mockResolvedValue({
      output_text: undefined,
      output: [
        {
          type: 'function_call',
          call_id: 'call-x',
          name: 'list_products',
          arguments: '{}',
        },
      ],
    });
    const catalogRepo = (await import('../db/repos.js')).catalogRepo;
    vi.mocked(catalogRepo.list).mockResolvedValue([
      { id: 'p1', title: 'منتج', price: 10, currency: 'SAR', available: true },
    ]);

    const res = await runToolLoop('store-1', 'أرني منتجاتك', create);
    expect(create).toHaveBeenCalledTimes(3);
    expect(res.toolRuns.length).toBeGreaterThanOrEqual(1);
    expect(res.reply).toContain('توضيح');
  });

  test('rejects unknown tools with an error payload', async () => {
    const { runToolLoop } = await import('./agent.js');
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        output_text: undefined,
        output: [
          { type: 'function_call', call_id: 'call-bad', name: 'delete_store', arguments: '{}' },
        ],
      })
      .mockResolvedValueOnce({ output_text: 'لا يمكن تنفيذ هذا', output: [] });

    const res = await runToolLoop('store-1', 'احذف المتجر', create);
    expect(res.toolRuns.find((r) => r.name === 'delete_store')).toBeUndefined();
    expect(res.reply).toBe('لا يمكن تنفيذ هذا');
  });

  test('get_order_status returns local order when adapter is null', async () => {
    const { runToolLoop } = await import('./agent.js');
    const orderRepo = (await import('../db/repos.js')).orderRepo;
    vi.mocked(orderRepo.byPlatformId).mockResolvedValueOnce({
      id: 'ORD-1',
      status: 'shipped',
      paymentStatus: 'paid',
      total: 120,
      currency: 'SAR',
    });
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        output_text: undefined,
        output: [
          {
            type: 'function_call',
            call_id: 'call-o',
            name: 'get_order_status',
            arguments: JSON.stringify({ platform_order_id: 'ORD-1' }),
          },
        ],
      })
      .mockResolvedValueOnce({ output_text: 'طلبك شُحن', output: [] });

    const res = await runToolLoop('store-1', 'حالة طلبي ORD-1؟', create);
    expect(res.toolRuns[0].output).toContain('shipped');
    expect(res.reply).toContain('شُحن');
  });

  test('get_customer masks PII', async () => {
    const { runToolLoop } = await import('./agent.js');
    const customerRepo = (await import('../db/repos.js')).customerRepo;
    const orderRepo = (await import('../db/repos.js')).orderRepo;
    vi.mocked(customerRepo.findByContact).mockResolvedValueOnce([
      { id: 'c1', platformCustomerId: 'pc1', name: 'محمد', phone: '0501234567', email: 'm@example.com' },
    ]);
    vi.mocked(orderRepo.listByCustomer).mockResolvedValueOnce([
      { id: 'ORD-9', status: 'processing', total: 99, currency: 'SAR' },
    ]);

    const create = vi
      .fn()
      .mockResolvedValueOnce({
        output_text: undefined,
        output: [
          {
            type: 'function_call',
            call_id: 'call-c',
            name: 'get_customer',
            arguments: JSON.stringify({ identifier: '0501234567' }),
          },
        ],
      })
      .mockResolvedValueOnce({ output_text: 'تم العثور على العميل', output: [] });

    const res = await runToolLoop('store-1', 'معلوماتي', create);
    expect(res.toolRuns[0].output).toContain('05****67');
    expect(res.toolRuns[0].output).toContain('m***@example.com');
    expect(res.toolRuns[0].output).not.toContain('0501234567');
  });

  test('runs multiple tool calls in one round and feeds both outputs back', async () => {
    const { runToolLoop } = await import('./agent.js');
    const catalogRepo = (await import('../db/repos.js')).catalogRepo;
    const retrieval = (await import('./retrieval.js')).retrieve;
    vi.mocked(retrieval).mockResolvedValueOnce([
      {
        product: { id: 'p1', title: 'سيروم', price: 50, currency: 'SAR', available: true },
        score: 1,
        source: 'fts',
      },
    ]);
    vi.mocked(catalogRepo.list).mockResolvedValueOnce([
      { id: 'p2', title: 'كريم', price: 30, currency: 'SAR', available: true },
    ]);

    const create = vi
      .fn()
      .mockResolvedValueOnce({
        output_text: undefined,
        output: [
          {
            type: 'function_call',
            call_id: 'c1',
            name: 'search_products',
            arguments: JSON.stringify({ query: 'سيروم' }),
          },
          { type: 'function_call', call_id: 'c2', name: 'list_products', arguments: '{}' },
        ],
      })
      .mockResolvedValueOnce({ output_text: 'تفضل', output: [] });

    const res = await runToolLoop('store-1', 'أرني منتجات', create);
    expect(res.toolRuns.map((r) => r.name)).toEqual(['search_products', 'list_products']);
    expect(res.toolRuns[0].output).toContain('سيروم');
    expect(res.toolRuns[1].output).toContain('كريم');
    const secondInput = create.mock.calls[1][0] as Array<{ type?: string; call_id?: string }>;
    const outputs = secondInput.filter((i) => i.type === 'function_call_output');
    expect(outputs.map((o) => o.call_id)).toEqual(['c1', 'c2']);
  });

  test('search_products drops heavy fields so results stay under the size cap', async () => {
    const { runToolLoop } = await import('./agent.js');
    const retrieval = (await import('./retrieval.js')).retrieve;
    vi.mocked(retrieval).mockResolvedValueOnce([
      {
        product: {
          id: 'p1',
          title: 'سيروم',
          description: 'x'.repeat(5000),
          price: 50,
          currency: 'SAR',
          available: true,
          sku: 'SKU-1',
        },
        score: 1,
        source: 'fts',
      },
    ]);
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        output_text: undefined,
        output: [
          {
            type: 'function_call',
            call_id: 'c1',
            name: 'search_products',
            arguments: JSON.stringify({ query: 'سيروم' }),
          },
        ],
      })
      .mockResolvedValueOnce({ output_text: 'تم', output: [] });

    const res = await runToolLoop('store-1', 'سيروم', create);
    const output = res.toolRuns[0].output;
    expect(output).not.toContain('xxxx');
    expect(output.length).toBeLessThan(3000);
    expect(JSON.parse(output)[0]).toMatchObject({ id: 'p1', title: 'سيروم', price: 50, currency: 'SAR' });
  });
});