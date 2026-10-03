'use client';

import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Bot, ExternalLink, Loader2, Send, Sparkles, User } from 'lucide-react';
import { useSelectedStore } from '@/hooks/useStores';
import { api, type ChatStreamHandlers } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/Button';

interface Msg {
  role: 'user' | 'assistant';
  content: string;
  products?: Array<{ id: string; title: string; price: number; url?: string }>;
}

const SUGGESTIONS = [
  'Suggest a gift under 200 SAR',
  'Show me best sellers',
  'Recommend something for a party',
];

const WELCOME: Msg = {
  role: 'assistant',
  content:
    'Hi! I’m your AI sales agent. Try asking me to recommend a product for a customer — I’ll reply with catalog-grounded suggestions.',
};

type StreamedProduct = Parameters<NonNullable<ChatStreamHandlers['onProducts']>>[0][number];

/** Keeps the id, which is the key `POST /api/attributions/click` records. */
function toCards(products: StreamedProduct[] | undefined) {
  return products?.slice(0, 3).map((p) => ({ id: p.id, title: p.title, price: p.price, url: p.url }));
}

export function QuickChat() {
  const { storeId, stores } = useSelectedStore();
  const [messages, setMessages] = useState<Msg[]>([WELCOME]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The guest token for the conversation the current recommendations came from.
  // Held in a ref rather than state: it is a credential, it changes every turn,
  // and nothing renders from it.
  const tokenRef = useRef<string | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, streaming]);

  /** Patches the trailing assistant bubble that a streaming turn appends. */
  const patchLastAssistant = (patch: (m: Msg) => Msg) => {
    setMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last && last.role === 'assistant') next[next.length - 1] = patch(last);
      return next;
    });
  };

  const sendMessage = async (text: string) => {
    const message = text.trim();
    if (!message || !storeId || streaming) return;
    setInput('');
    // Append the user turn and an empty assistant bubble that the deltas fill in.
    setMessages((prev) => [...prev, { role: 'user', content: message }, { role: 'assistant', content: '' }]);
    setStreaming(true);
    try {
      const res = await api.chatStream(storeId, message, {
        onProducts: (products) => patchLastAssistant((m) => ({ ...m, products: toCards(products) })),
        onDelta: (delta) => patchLastAssistant((m) => ({ ...m, content: m.content + delta })),
      });
      tokenRef.current = res.token;
      // The terminal `done` event is authoritative, so it replaces whatever the
      // deltas accumulated.
      patchLastAssistant(() => ({
        role: 'assistant',
        content: res.reply,
        products: toCards(res.products),
      }));
    } catch {
      patchLastAssistant((m) =>
        m.content
          ? m
          : { role: 'assistant', content: 'Sorry, I couldn’t reach the agent right now. Mind trying again?' },
      );
    } finally {
      setStreaming(false);
    }
  };

  /**
   * Records the click, then follows the product.
   *
   * Attribution is best-effort and deliberately cannot block the navigation: this
   * is a sales surface, and a failed analytics write is not a reason to stop a
   * customer reaching the product page.
   */
  const onProductClick = (product: { id: string; url?: string }) => {
    const token = tokenRef.current;
    if (token) {
      void api.attributionClick(token, product.id).catch(() => undefined);
    }
    if (product.url) window.open(product.url, '_blank', 'noopener,noreferrer');
  };

  const disabled = !storeId || stores.length === 0;

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-violet-600 to-violet-400">
          <Bot className="h-4 w-4 text-white" />
        </div>
        <div>
          <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Test your agent</p>
          <p className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse-dot" />
            Live — catalog-grounded replies
          </p>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 space-y-3 overflow-y-auto rounded-2xl border border-slate-200/70 bg-slate-50/60 p-4 dark:border-white/5 dark:bg-white/[0.02]"
      >
        {messages.map((m, i) => {
          // A streaming turn appends an empty assistant bubble up front; hide it
          // until the first token so the trader sees the typing indicator, not a
          // blank card.
          if (m.role === 'assistant' && !m.content && !m.products?.length) return null;
          return (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
              className={cn(
                'flex gap-2.5',
                m.role === 'user' ? 'justify-end' : 'justify-start',
              )}
            >
              {m.role === 'assistant' && (
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-500/15">
                  <Sparkles className="h-3.5 w-3.5 text-violet-500" />
                </div>
              )}
              <div
                className={cn(
                  'max-w-[82%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed',
                  m.role === 'user'
                    ? 'rounded-tr-sm bg-gradient-to-r from-violet-600 to-violet-500 text-white'
                    : 'rounded-tl-sm border border-slate-200/70 bg-white text-slate-700 dark:border-white/5 dark:bg-white/[0.04] dark:text-slate-200',
                )}
              >
                {m.content}
                {m.products && m.products.length > 0 && (
                  <div className="mt-2.5 space-y-1.5">
                    {m.products.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => onProductClick(p)}
                        title={p.url ? 'Open product and record the click' : 'Record the click'}
                        className="flex w-full items-center justify-between gap-3 rounded-xl border border-slate-200/60 bg-slate-50/60 px-3 py-2 text-left transition hover:border-violet-400/60 hover:bg-violet-50/60 dark:border-white/5 dark:bg-white/[0.03] dark:hover:border-violet-400/40 dark:hover:bg-violet-500/10"
                      >
                        <span className="truncate text-xs font-medium">{p.title}</span>
                        <span className="flex shrink-0 items-center gap-1 text-xs font-bold text-violet-600 dark:text-violet-300">
                          {p.price.toLocaleString()} SAR
                          {p.url && <ExternalLink className="h-3 w-3 opacity-60" />}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {m.role === 'user' && (
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-200 dark:bg-white/10">
                  <User className="h-3.5 w-3.5 text-slate-500 dark:text-slate-300" />
                </div>
              )}
            </motion.div>
          );
        })}
        {streaming && (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Agent is thinking…
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            onClick={() => sendMessage(s)}
            disabled={disabled || streaming}
            className="rounded-full border border-slate-200/70 bg-white px-3 py-1.5 text-xs text-slate-500 transition hover:border-violet-400/50 hover:text-violet-600 disabled:opacity-40 dark:border-white/10 dark:bg-white/5 dark:text-slate-400 dark:hover:text-violet-300"
          >
            {s}
          </button>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          sendMessage(input);
        }}
        className="mt-3 flex items-center gap-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={disabled ? 'Connect a store to chat' : 'Ask about products…'}
          disabled={disabled || streaming}
          className="input-base h-12"
        />
        <Button
          type="submit"
          size="icon"
          className="h-12 w-12 rounded-xl"
          loading={streaming}
          disabled={disabled || !input.trim()}
        >
          <Send className="h-5 w-5" />
        </Button>
      </form>
    </div>
  );
}
