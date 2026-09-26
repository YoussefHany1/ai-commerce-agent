import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import { Providers } from '@/app/providers';
import '@/app/globals.css';

const INTER_FONT =
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Cairo:wght@400;500;600;700&display=swap';

export const metadata: Metadata = {
  title: {
    default: 'AI Commerce Agent — Dashboard',
    template: '%s · AI Commerce Agent',
  },
  description:
    'AI sales agent for Shopify, Salla and Zid stores. Conversations, attribution, automation and billing in one dashboard.',
  applicationName: 'AI Commerce Agent',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0A0A0F',
};

const INIT_SCRIPT = `(function () {
  try {
    var theme = localStorage.getItem('aca.theme') || 'dark';
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
    var locale = localStorage.getItem('aca.locale');
    if (!locale) {
      locale = (navigator.language || 'en').toLowerCase().indexOf('ar') === 0 ? 'ar' : 'en';
      localStorage.setItem('aca.locale', locale);
    }
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
  } catch (e) {}
})();`;

/**
 * Reads the CSP nonce minted in `proxy.ts`.
 *
 * Next stamps it on the scripts it emits automatically; this bootstrap script is
 * ours, so it has to carry the same nonce or `script-src` blocks it. Reading
 * `headers()` here is what makes the layout dynamic, which is the correct
 * rendering mode for an operator-only surface that must never serve a cached
 * shell to a signed-out visitor.
 */
async function nonce(): Promise<string> {
  return (await headers()).get('x-nonce') ?? '';
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const cspNonce = await nonce();
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href={INTER_FONT} rel="stylesheet" />
        <script nonce={cspNonce} dangerouslySetInnerHTML={{ __html: INIT_SCRIPT }} />
      </head>
      <body className="font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}