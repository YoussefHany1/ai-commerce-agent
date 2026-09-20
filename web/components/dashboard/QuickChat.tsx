'use client';

import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Bot, Loader2, Send, Sparkles, User } from 'lucide-react';
import { useChatMutation } from '@/hooks/useChat';
import { useSelectedStore } from '@/hooks/useStores';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/Button';

interface Msg {
  role: 'user' | 'assistant';
  content: string;
  products?: Array<{ title: string; price: number }>;
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

export function QuickChat() {
  const { storeId, stores } = useSelectedStore();
  const chat = useChatMutation();
  const [messages, setMessages] = useState<Msg[]>([WELCOME]);
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, chat.isPending]);

  const sendMessage = async (text: string) => {
    const message = text.trim();
    if (!message || !storeId || chat.isPending) return;
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: message }]);
    try {
      const res = await chat.mutateAsync({ storeId, message });
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: res.reply,
          products: res.products?.slice(0, 3).map((p) => ({ title: p.title, price: p.price })),
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: 'Sorry, I couldn’t reach the agent right now. Mind trying again?',
        },
      ]);
    }
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
        {messages.map((m, i) => (
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
                  {m.products.map((p, j) => (
                    <div
                      key={j}
                      className="flex items-center justify-between gap-3 rounded-xl border border-slate-200/60 bg-slate-50/60 px-3 py-2 dark:border-white/5 dark:bg-white/[0.03]"
                    >
                      <span className="truncate text-xs font-medium">{p.title}</span>
                      <span className="shrink-0 text-xs font-bold text-violet-600 dark:text-violet-300">
                        {p.price.toLocaleString()} SAR
                      </span>
                    </div>
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
        ))}
        {chat.isPending && (
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
            disabled={disabled || chat.isPending}
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
          disabled={disabled || chat.isPending}
          className="input-base h-12"
        />
        <Button
          type="submit"
          size="icon"
          className="h-12 w-12 rounded-xl"
          loading={chat.isPending}
          disabled={disabled || !input.trim()}
        >
          <Send className="h-5 w-5" />
        </Button>
      </form>
    </div>
  );
}