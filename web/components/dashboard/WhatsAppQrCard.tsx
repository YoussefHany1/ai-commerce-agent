'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, QrCode, ShieldAlert, Smartphone, Unlink } from 'lucide-react';
import { api, type QrStatus } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/Button';

/**
 * WhatsApp Web (QR) pairing.
 *
 * `tos` is the first state and gates everything else: the merchant reads the
 * unofficial-protocol warning and accepts before any QR is requested. That ordering is
 * deliberate — a checkbox inside the card would be scanned past, and the party whose
 * number can be banned is the one who has to consent to it.
 *
 * The API enforces the same gate on `qr-connect` (403 `tos_not_acknowledged`), so
 * hiding the button here is courtesy rather than the control.
 */

type Phase =
  | 'loading'
  | 'tos'
  | 'idle'
  | 'connecting'
  | 'qr'
  | 'open'
  | 'needsRescan'
  | 'limitReached'
  | 'error';

const TOS_POINTS = [
  'This uses WhatsApp Web, an unofficial protocol Meta does not support.',
  'Meta can temporarily or permanently ban a number used this way.',
  'Reconnecting frequently is a known trigger for that action.',
  'Use a number you can afford to lose, and prefer the official Cloud API where you can.',
];

export function WhatsAppQrCard({ storeId }: { storeId: string }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [qr, setQr] = useState<string | null>(null);
  const [phone, setPhone] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);

  /** Live status arrives by SSE; this maps it onto the card's phases. */
  const applyStatus = useCallback((status: QrStatus['status']) => {
    switch (status) {
      case 'open':
        setPhase('open');
        break;
      case 'qr':
        setPhase('qr');
        break;
      case 'connecting':
        setPhase('connecting');
        break;
      case 'logged_out':
        // Terminal and not an error: the number was unlinked and only a re-scan helps.
        setPhase('needsRescan');
        break;
      case 'replaced':
        // The merchant moved the session to another device. Not a failure either.
        setPhase('needsRescan');
        break;
      case 'error':
        setPhase('error');
        break;
      default:
        setPhase('idle');
    }
  }, []);

  /**
   * Loads persisted state on mount rather than trusting live events alone.
   *
   * After a redeploy the socket is briefly absent, so a card that only listened for
   * events would show "idle" for a number that is actually paired.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await api.whatsappQrStatus(storeId);
        if (cancelled) return;
        setPhone(status.phone);
        // The warning comes first, even for a store that is already paired: the terms
        // gate exists before access, and a re-pair is reachable from the same card.
        setPhase(status.tosAcknowledged ? 'idle' : 'tos');
        if (status.tosAcknowledged) applyStatus(status.status);
      } catch (err) {
        if (cancelled) return;
        setMessage((err as Error).message);
        // A 404 here means WHATSAPP_BAILEYS_ENABLED is off on the API. Say so plainly
        // rather than offering a Connect button that cannot work.
        setPhase('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storeId, applyStatus]);

  /**
   * Subscribes to pairing events once, for the life of the card.
   *
   * Deliberately NOT keyed on `phase`: a QR is emitted once and rotates only every ~20s,
   * so re-subscribing on each status change (logging out, connecting, …) closed the
   * stream right before the QR frame and forced a ~20s wait for the next rotation. It was
   * invisible locally, where the stream reconnects instantly, and only bit in production.
   */
  useEffect(() => {
    const source = new EventSource(`/api/whatsapp/qr-stream?storeId=${encodeURIComponent(storeId)}`);
    sourceRef.current = source;

    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { type?: string; status?: QrStatus['status']; qr?: string };
        if (data.type === 'qr' && data.qr) {
          setQr(data.qr);
          setPhase('qr');
          return;
        }
        if (data.type === 'status' && data.status) {
          if (data.status !== 'qr') setQr(null);
          applyStatus(data.status);
        }
      } catch {
        // A malformed frame is not worth surfacing; the next one will carry state.
      }
    };

    // EventSource retries on its own, so this only surfaces a total failure.
    source.onerror = () => setMessage('Lost the connection to the pairing stream. Retrying…');

    return () => {
      source.close();
      sourceRef.current = null;
    };
  }, [storeId, applyStatus]);

  const run = async (fn: () => Promise<unknown>, failMessage: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.message.includes('tos_not_acknowledged')) {
        setPhase('tos');
        return;
      }
      if (e.message.includes('session_limit_reached')) {
        setMessage('This instance supports one WhatsApp number, and the limit is already in use.');
        setPhase('limitReached');
        return;
      }
      setMessage(e.message || failMessage);
      setPhase('error');
    } finally {
      setBusy(false);
    }
  };

  const accept = () =>
    run(async () => {
      await api.whatsappQrAcknowledge(storeId);
      setPhase('connecting');
    }, 'Could not record your acceptance.');

  // Force a genuinely new handshake rather than reusing the live socket: startSession
  // otherwise answers `resumed: true`, so clicking Reconnect while the backend is stuck
  // in a reconnect loop changes nothing and looks like a dead button.
  const connect = () =>
    run(async () => {
      await api.whatsappQrDisconnect(storeId).catch(() => undefined);
      await api.whatsappQrConnect(storeId);
    }, 'Could not start pairing.');

  const disconnect = () =>
    run(async () => {
      await api.whatsappQrDisconnect(storeId);
      setQr(null);
      setPhone(null);
      setPhase('idle');
    }, 'Could not disconnect.');

  if (phase === 'tos') {
    return (
      <section className="rounded-2xl border border-amber-200 bg-amber-50/60 p-6 dark:border-amber-500/30 dark:bg-amber-500/[0.07]">
        <div className="mb-4 flex items-start gap-3">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div>
            <h3 className="font-semibold text-slate-900 dark:text-white">Before you connect a number</h3>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
              Please read this before using the WhatsApp connection.
            </p>
          </div>
        </div>
        <ul className="mb-5 space-y-2 text-sm text-slate-700 dark:text-slate-300">
          {TOS_POINTS.map((point) => (
            <li key={point} className="flex gap-2">
              <span aria-hidden className="text-amber-600">
                •
              </span>
              <span>{point}</span>
            </li>
          ))}
        </ul>
        <Button onClick={accept} loading={busy} leftIcon={<CheckCircle2 className="h-4 w-4" />}>
          I understand, continue
        </Button>
        {message && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{message}</p>}
      </section>
    );
  }

  if (phase === 'loading') {
    return (
      <section className="rounded-2xl border border-slate-200 p-6 dark:border-white/10">
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading WhatsApp status…
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-slate-200 p-6 dark:border-white/10">
      <header className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h3 className="flex items-center gap-2 font-semibold text-slate-900 dark:text-white">
            <QrCode className="h-4 w-4" />
            Connect a WhatsApp number
          </h3>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Pair by scanning a QR code from your phone. One number per store.
          </p>
        </div>
        {phase === 'open' && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Connected
          </span>
        )}
      </header>

      {phone && (
        <p className="mb-4 inline-flex items-center gap-2 rounded-lg bg-slate-100 px-3 py-1.5 text-sm dark:bg-white/5">
          <Smartphone className="h-3.5 w-3.5 text-slate-500" />
          {phone}
        </p>
      )}

      {/* Rendered as an <img> from a server-rendered data URL, so no QR library is
          pulled into the dashboard bundle. CSP already allows data: images. */}
      {phase === 'qr' && qr && (
        <div className="mb-4 flex flex-col items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- next/image would
              recompress the image, and any lossy pass makes a QR unscannable. The QR
              also rotates every ~20s, so there is nothing to cache or optimize. */}
          <img
            src={qr}
            alt="WhatsApp pairing QR code"
            className="h-64 w-64 rounded-xl bg-white p-2"
          />
          <p className="text-sm text-slate-500">
            Open WhatsApp → Linked devices → Link a device, then scan. This code refreshes every ~20
            seconds.
          </p>
        </div>
      )}

      {phase === 'connecting' && (
        <div className="mb-4 flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          Connecting…
        </div>
      )}

      {phase === 'needsRescan' && (
        <div
          className={cn(
            'mb-4 rounded-xl border border-amber-200 bg-amber-50/60 p-4 text-sm text-slate-700',
            'dark:border-amber-500/30 dark:bg-amber-500/[0.07] dark:text-slate-300',
          )}
        >
          <p className="flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            This number needs to be paired again
          </p>
          <p className="mt-1">
            The connection was closed on WhatsApp&rsquo;s side — either it was unlinked, or the
            session moved to another device. Scan a fresh code to reconnect.
          </p>
        </div>
      )}

      {phase === 'limitReached' && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50/60 p-4 text-sm text-slate-700 dark:border-amber-500/30 dark:bg-amber-500/[0.07] dark:text-slate-300">
          <p className="flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            One number per store
          </p>
          <p className="mt-1">
            This instance already has a number connected. Disconnect it first to pair a different
            one.
          </p>
        </div>
      )}

      {message && phase === 'error' && (
        <p className="mb-4 text-sm text-red-600 dark:text-red-400">{message}</p>
      )}

      <div className="flex flex-wrap gap-3">
        {phase === 'open' ? (
          <Button
            variant="danger"
            onClick={disconnect}
            loading={busy}
            leftIcon={<Unlink className="h-4 w-4" />}
          >
            Disconnect
          </Button>
        ) : (
          <Button onClick={connect} loading={busy} leftIcon={<QrCode className="h-4 w-4" />}>
            {phase === 'qr' || phase === 'connecting' ? 'Reconnect' : 'Show QR code'}
          </Button>
        )}
      </div>
    </section>
  );
}