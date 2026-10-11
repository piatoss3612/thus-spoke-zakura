import { useRef, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { AlertTriangle, Clock3, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast-context';
import { api, errorMessage, isPaymentRejection } from '@/lib/api';
import { queryKeys, isTerminalPayment } from '@/hooks/queries';
import type { PaymentIdentity } from '@/hooks/payment-identity';
import { useWalletPayments } from './payment-context';
import { useWalletActions } from './wallet-actions-context';
import { PaymentStatus, PaymentWarning } from './PaymentStatus';

export function PaymentUpdates() {
  const { send, faucet, savedSend, savedFaucet, isRestored } = useWalletPayments();
  const { openSend, openFaucet } = useWalletActions();
  const toast = useToast();
  const identities = [...savedSend.displayed, ...savedFaucet.displayed];
  const [open, setOpen] = useState(false);
  const [visibleKeys, setVisibleKeys] = useState<string[]>([]);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // Observe the same Query snapshots for counts, without starting extra reads.
  const statuses = useQueries({
    queries: identities.map(({ key }) => ({
      queryKey: queryKeys.payment(key),
      queryFn: () => api.payment(key),
      enabled: false,
    })),
  });
  // Prioritize unresolved work when opening, then keep rows stable while the
  // panel is in use so a background confirmation cannot move focused controls.
  const visible = [...identities].sort((a, b) => {
    const first = visibleKeys.indexOf(a.key);
    const second = visibleKeys.indexOf(b.key);
    return (first < 0 ? identities.length : first) - (second < 0 ? identities.length : second);
  });
  const counts = { unresolved: 0, confirmed: 0, failed: 0 };
  for (const status of statuses) {
    if (status.data?.status === 'confirmed') counts.confirmed++;
    else if (status.data?.status === 'failed') counts.failed++;
    else counts.unresolved++;
  }
  const summary = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([state, count]) => `${count} ${state}`)
    .join(' · ');
  const errors = [savedSend.error, savedFaucet.error].filter((error) => error !== null);
  const finished = identities.filter(
    (identity, index) =>
      isTerminalPayment(statuses[index]?.data) &&
      !(identity.kind === 'send' ? savedSend : savedFaucet).retained.some(
        ({ key }) => key === identity.key,
      ),
  );
  const attention = errors.length > 0 || counts.failed > 0;
  const active = send.isPending || faucet.isPending;
  const StatusIcon = attention ? AlertTriangle : active ? Loader2 : Clock3;
  const dismiss = (identity: PaymentIdentity) => {
    const headings = [...(container?.querySelectorAll<HTMLHeadingElement>('h3') ?? [])];
    const index = visible.findIndex((item) => item.key === identity.key);
    const next = headings[index + 1] ?? headings[index - 1];
    (identity.kind === 'send' ? savedSend : savedFaucet).dismissKey(identity.key);
    requestAnimationFrame(() => {
      const target = next?.isConnected ? next : container;
      target?.focus();
    });
  };
  const startNew = (identity: PaymentIdentity) => {
    setOpen(false);
    // Use a connected opener so closing the next form returns focus to the
    // summary rather than the row removed when this panel closes.
    requestAnimationFrame(() => {
      trigger.current?.focus();
      if (identity.kind === 'send') openSend(identity.variables.from_account, identity);
      else openFaucet(identity.variables.account_id, identity);
    });
  };
  if (!identities.length && !errors.length && !open) return null;
  return (
    <>
      <Button
        ref={trigger}
        variant="ghost"
        aria-label={`View payments: ${summary || 'Storage unavailable'}`}
        aria-haspopup="dialog"
        onClick={() => {
          const priority = (status: string | undefined) =>
            status === 'confirmed' ? 2 : status === 'failed' ? 1 : 0;
          setVisibleKeys(
            identities
              .map((identity, index) => ({ identity, status: statuses[index]?.data?.status }))
              .sort((a, b) => priority(a.status) - priority(b.status))
              .map(({ identity }) => identity.key),
          );
          setOpen(true);
        }}
      >
        <StatusIcon
          aria-hidden
          className={attention ? 'text-warning' : active ? 'motion-safe:animate-spin' : undefined}
        />
        Payments
        {identities.length > 0 && (
          <span className="bg-accent-soft text-accent-strong rounded-xs px-1.5 text-[11px]">
            {identities.length}
          </span>
        )}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next && !identities.length && !errors.length) {
            requestAnimationFrame(() => {
              const heading = document.querySelector<HTMLElement>('main h1');
              if (heading) {
                heading.tabIndex = -1;
                heading.focus();
              }
            });
          }
        }}
        title="Payments"
        description={summary || (errors.length ? 'Storage unavailable' : 'No payment updates')}
        className="w-[min(540px,calc(100vw-36px))]"
      >
        {errors.length > 0 && (
          <PaymentWarning role="alert" className="mb-3">
            <p>Couldn’t load saved payments: {errors.map(errorMessage).join('; ')}</p>
            <p>Allow site storage and reload.</p>
          </PaymentWarning>
        )}
        {identities.length > 0 && (
          <p className="text-ink-muted mb-3 text-[12px]">
            Status checks are automatic. Resume repeats the saved request.
          </p>
        )}
        <div
          ref={setContainer}
          role="region"
          aria-label="Payment updates"
          tabIndex={-1}
          className="border-line max-h-[min(55dvh,440px)] overflow-y-auto overscroll-contain rounded-xs border empty:border-0"
        />
        {finished.length > 0 && (
          <div className="mt-3 flex justify-end">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                for (const identity of finished) {
                  (identity.kind === 'send' ? savedSend : savedFaucet).dismissKey(identity.key);
                }
                container?.focus();
              }}
            >
              Clear finished
            </Button>
          </div>
        )}
      </Dialog>
      {visible.map((identity) => {
        const operation = identity.kind === 'send' ? send : faucet;
        return (
          <PaymentStatus
            key={identity.key}
            container={container}
            identity={identity}
            restored={isRestored(identity.key)}
            pendingKey={operation.pendingKey}
            busy={send.isPending || faucet.isPending}
            claimAnnouncement={operation.claimAnnouncement}
            onTerminal={operation.clear}
            onResume={(item) =>
              operation.resume(item, {
                onError: (error) =>
                  toast.error(
                    isPaymentRejection(error) ? 'Payment rejected' : 'Payment not confirmed',
                    errorMessage(error),
                  ),
              })
            }
            onDismiss={() => dismiss(identity)}
            onNew={() => startNew(identity)}
          />
        );
      })}
    </>
  );
}
