import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { statusTone } from '@/components/ui/status-tone';
import { useToast } from '@/components/ui/toast-context';
import { usePaymentStatus, isTerminalPayment } from '@/hooks/queries';
import type { PaymentIdentity } from '@/hooks/payment-identity';
import { errorMessage } from '@/lib/api';
import { formatZecAmount } from '@/lib/money';
import { cn } from '@/lib/cn';

export function PaymentStatus({
  identity,
  pendingName,
  claimAnnouncement,
  onTerminal,
  onResume,
}: {
  identity: PaymentIdentity;
  /** The payment whose POST is in flight, if any. */
  pendingName: string | null;
  claimAnnouncement: (key: string) => boolean;
  onTerminal: (identity: PaymentIdentity) => Promise<void>;
  onResume: (identity: PaymentIdentity) => void;
}) {
  const status = usePaymentStatus(identity.key, true);
  const activity = status.data;
  const toast = useToast();
  const titleId = useId();
  const inFlight = pendingName === identity.name;
  const handled = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  useEffect(() => {
    if (!isTerminalPayment(activity) || handled.current) return;
    handled.current = true;
    if (activity?.status === 'confirmed' && claimAnnouncement(identity.key)) {
      toast.success(
        identity.kind === 'send'
          ? `Sent to Account ${activity.to_account}`
          : `Funded Account ${activity.to_account}`,
        `${formatZecAmount(activity.amount_zatoshi)} confirmed.`,
      );
    }
    void onTerminal(identity).catch((error: unknown) => {
      if (!mounted.current) return;
      setCleanupError(
        `Could not clear this saved payment: ${errorMessage(error)}. Allow site storage, then reopen this dialog. The payment itself is unaffected.`,
      );
    });
  }, [activity, claimAnnouncement, identity, onTerminal, toast]);

  const variables = identity.variables;
  const destination = 'to_account' in variables ? variables.to_account : variables.account_id;
  const terminal = isTerminalPayment(activity);
  const confirmed = activity?.status === 'confirmed';
  const failed = activity?.status === 'failed';
  const stage = activity?.status ?? (inFlight ? 'submitting' : 'unknown');
  // GET observes status but cannot broadcast prepared bytes or resume failed
  // auto-mining. Every nonterminal payment keeps an explicit same-key replay.
  const canRetry = !terminal && !inFlight;
  const warnings = [
    !terminal && activity?.last_error && `Latest execution error: ${activity.last_error}`,
    !terminal && status.isError && `Status unavailable: ${errorMessage(status.error)}`,
    cleanupError,
  ].filter((warning): warning is string => Boolean(warning));

  return (
    <div className="border-line bg-raised mb-3 rounded-xs border p-3 text-[12px] wrap-anywhere">
      <p id={titleId} className="font-semibold">
        {'from_account' in variables && `Account ${variables.from_account} → `}
        Account {destination} · {formatZecAmount(variables.amount_zatoshi)}
      </p>
      <p className="text-ink-muted mt-1">
        {'source_pool' in variables
          ? `${variables.source_pool} → ${variables.destination_pool}`
          : variables.pool}
        {'memo' in variables && ` · Memo: ${variables.memo}`}
      </p>
      <Badge tone={statusTone(stage)} className="mt-2">
        {stage}
      </Badge>
      <div role={failed ? 'alert' : 'status'} className="mt-2 space-y-1">
        <p
          className={cn(confirmed ? 'text-positive' : failed ? 'text-negative' : 'text-ink-muted')}
        >
          {confirmed
            ? 'Payment confirmed.'
            : failed
              ? `Payment failed: ${activity.last_error ?? 'The server marked this payment as failed.'}`
              : inFlight
                ? 'Submitting payment…'
                : !activity
                  ? 'Status unknown. Retry sends the same request again and cannot pay twice.'
                  : activity.status === 'preparing'
                    ? 'Not prepared yet. Retry resumes the same request and cannot pay twice.'
                    : activity.status === 'prepared'
                      ? 'Ready to broadcast. Retry sends the same prepared transaction and cannot pay twice.'
                      : 'Waiting for confirmation. Status updates automatically; you can close this dialog.'}
        </p>
        {failed && <p className="text-ink-muted">Use the form below to send a new payment.</p>}
        {warnings.map((warning) => (
          <p key={warning} className="text-warning">
            {warning}
          </p>
        ))}
      </div>
      {canRetry && (
        <Button
          type="button"
          size="sm"
          variant="subtle"
          className="mt-2"
          disabled={pendingName !== null}
          aria-describedby={titleId}
          onClick={() => onResume(identity)}
        >
          Retry
        </Button>
      )}
    </div>
  );
}

export function PaymentWarning({
  children,
  role = 'status',
  className,
}: {
  children: ReactNode;
  role?: 'alert' | 'status';
  className?: string;
}) {
  return (
    <div role={role} className={cn('text-warning text-[12px] wrap-anywhere', className)}>
      {children}
    </div>
  );
}
