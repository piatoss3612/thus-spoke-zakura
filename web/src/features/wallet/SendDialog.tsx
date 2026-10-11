import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { ArrowRight } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { useToast } from '@/components/ui/toast-context';
import { errorMessage, type Account } from '@/lib/api';
import { formatZec, formatZecAmount } from '@/lib/money';
import { type PaymentResult, type SendVariables } from '@/hooks/mutations';
import { paymentName, type PaymentIdentity } from '@/hooks/payment-identity';
import { isTerminalPayment, usePaymentStatus } from '@/hooks/queries';
import { useWalletPayments } from './payment-context';
import { useSendQuote } from '@/hooks/queries';
import {
  MEMO_MAX_BYTES,
  memoByteLength,
  sendSchema,
  type SendInput,
  type SendValues,
} from './schemas';
import { controlStyles } from '@/components/ui/control-styles';
import { cn } from '@/lib/cn';
import { SelectField } from './fields';
import { POOL_OPTIONS, accountOptions } from './field-options';
import { PaymentWarning } from './PaymentStatus';

export function SendDialog({
  open,
  onOpenChange,
  accounts,
  defaultAccountId,
  draft,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: Account[];
  defaultAccountId?: number;
  draft?: PaymentIdentity | undefined;
}) {
  const toast = useToast();
  const {
    send,
    savedSend: payments,
    send: sendOperation,
    faucet: faucetOperation,
    viewPayment,
  } = useWalletPayments();
  const busy = sendOperation.isPending || faucetOperation.isPending;
  const mounted = useRef(true);
  const [submittedHere, setSubmittedHere] = useState(false);
  const [receipt, setReceipt] = useState<{
    text: string;
    kind: 'accepted' | 'error';
    key?: string | undefined;
  } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const previous = draft?.kind === 'send' ? draft.variables : undefined;
  const fromAccountId = previous?.from_account ?? defaultAccountId ?? 1;

  const form = useForm<SendInput, unknown, SendValues>({
    resolver: zodResolver(sendSchema),
    defaultValues: {
      from_account: String(fromAccountId),
      to_account: String(
        previous?.to_account ?? accounts.find((account) => account.id !== fromAccountId)?.id ?? 1,
      ),
      source_pool: previous?.source_pool ?? 'ironwood',
      destination_pool: previous?.destination_pool ?? 'ironwood',
      amount: previous ? formatZec(previous.amount_zatoshi, { grouping: false }) : '1',
      memo: previous?.memo ?? '',
    },
  });

  const current = sendSchema.safeParse(useWatch({ control: form.control }));
  const variablesFor = (values: SendValues) => ({
    from_account: values.from_account,
    to_account: values.to_account,
    source_pool: values.source_pool,
    destination_pool: values.destination_pool,
    amount_zatoshi: values.amount,
    ...(values.memo === '' ? {} : { memo: values.memo }),
  });
  const match = current.success
    ? payments.retained.find(
        (item) => item.name === paymentName('send', variablesFor(current.data)),
      )
    : undefined;
  const matchStatus = usePaymentStatus(match?.key ?? '', Boolean(match));
  const matchTerminal = isTerminalPayment(matchStatus.data);
  const retryLabel = match && !matchTerminal ? `Resume payment` : null;
  const announce = ({ activity, key }: PaymentResult) => {
    if (!send.claimAnnouncement(key)) return;
    toast.success(
      `Sent to Account ${activity.to_account}`,
      `${formatZecAmount(activity.amount_zatoshi)} confirmed.`,
    );
  };
  const failed = (error: Error, _variables: SendVariables, key: string | undefined) => {
    if (!mounted.current) return;
    setReceipt({ text: errorMessage(error), kind: 'error', key });
  };
  // A direct confirmation finishes only the submitted draft. Inputs remain
  // editable during the POST, and a later confirmation must preserve edits.
  const submitted = {
    onError: failed,
    onSuccess: (result: PaymentResult, variables: SendVariables) => {
      if (!mounted.current) return;
      if (result.activity.status === 'confirmed') announce(result);
      if (result.activity.status === 'failed') {
        setReceipt({
          text: `Payment failed: ${result.activity.last_error ?? 'The server rejected this payment.'}`,
          kind: 'error',
          key: result.key,
        });
        return;
      }
      if (result.cleanupError) return;
      const draft = sendSchema.safeParse(form.getValues());
      if (
        !draft.success ||
        paymentName('send', variablesFor(draft.data)) !== paymentName('send', variables)
      ) {
        setReceipt({
          text: `Payment ${result.activity.status === 'confirmed' ? 'confirmed' : 'accepted'}. Your draft is unchanged. View status in Payments.`,
          kind: 'accepted',
        });
        return;
      }
      onOpenChange(false);
      form.reset();
    },
  };

  const fromAccount = useWatch({ control: form.control, name: 'from_account' });
  const sourcePool = useWatch({ control: form.control, name: 'source_pool' });
  const destinationPool = useWatch({ control: form.control, name: 'destination_pool' });
  const memo = useWatch({ control: form.control, name: 'memo' }) ?? '';
  const memoEnabled = destinationPool === 'ironwood';

  // A memo typed for an ironwood output must not linger (hidden) once the
  // destination switches to transparent, where it can never be sent.
  useEffect(() => {
    if (!memoEnabled) {
      form.setValue('memo', '');
      form.clearErrors('memo');
    }
  }, [memoEnabled, form]);

  const source = accounts.find((account) => account.id === Number(fromAccount));
  const available =
    source === undefined
      ? 0n
      : sourcePool === 'ironwood'
        ? source.ironwood_zatoshi
        : source.transparent_zatoshi;

  // The quote is a dry-run proposal, so its fee reflects real input selection.
  const quote = useSendQuote({
    from_account: Number(fromAccount),
    source_pool: sourcePool,
    destination_pool: destinationPool,
  });

  const submit = async (values: SendValues) => {
    // Replaying retained work must not depend on the account's current balance
    // or a new proposal; it may already have spent those funds.
    if (busy || matchTerminal) return;
    setSubmittedHere(true);
    setReceipt(null);
    const variables = variablesFor(values);
    const retained = payments.retained.find((item) => item.name === paymentName('send', variables));
    if (retained) {
      send.resume(retained, submitted);
      return;
    }
    if (values.amount > available) {
      form.setError('amount', {
        message: `Account ${values.from_account} holds ${formatZecAmount(available)} in the ${values.source_pool} pool.`,
      });
      return;
    }
    const quoted = quote.data ?? (await quote.refetch()).data;
    if (quoted !== undefined && values.amount > quoted.max_zatoshi) {
      form.setError('amount', {
        message: `The ${formatZecAmount(quoted.fee_zatoshi)} network fee leaves at most ${formatZecAmount(quoted.max_zatoshi)} spendable — Account ${values.from_account} holds ${formatZecAmount(quoted.available_zatoshi)} in the ${values.source_pool} pool.`,
      });
      return;
    }

    send.mutate(variables, submitted);
  };

  const options = accountOptions(accounts);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      eyebrow="NEW TRANSACTION"
      title="Send ZEC"
      description="Moves existing funds between development accounts or pools."
    >
      {payments.error && (
        <PaymentWarning role="alert" className="mb-3">
          <p>Could not load saved payments: {errorMessage(payments.error)}</p>
          <p>Allow site storage and reload before submitting.</p>
        </PaymentWarning>
      )}
      {receipt &&
        (receipt.kind === 'accepted' ? (
          <p role="status" className="text-ink-muted mb-3 text-[12px]">
            {receipt.text}
          </p>
        ) : (
          <PaymentWarning role="alert" className="mb-3">
            <p>{receipt.text}</p>
            {receipt.key && (
              <Button size="sm" className="mt-2" onClick={() => viewPayment(receipt.key)}>
                View payment
              </Button>
            )}
          </PaymentWarning>
        ))}
      {match && (
        <p className="text-ink-muted mb-3 text-[12px]" role="status">
          {matchTerminal
            ? 'Previous payment finished. Clear its saved request in Payments before sending these details again.'
            : `A saved payment has these details (${matchStatus.data?.status ?? 'status unknown'}). Resume it, or change the details for a new payment.`}
        </p>
      )}
      <form onSubmit={(event) => void form.handleSubmit(submit)(event)} noValidate>
        <div className="grid gap-x-3 sm:grid-cols-2">
          <SelectField
            control={form.control}
            name="from_account"
            label="From account"
            options={options}
            error={form.formState.errors.from_account?.message}
          />
          <SelectField
            control={form.control}
            name="source_pool"
            label="Source pool"
            options={POOL_OPTIONS}
            error={form.formState.errors.source_pool?.message}
          />
          <SelectField
            control={form.control}
            name="to_account"
            label="Destination account"
            options={options}
            error={form.formState.errors.to_account?.message}
          />
          <SelectField
            control={form.control}
            name="destination_pool"
            label="Destination pool"
            options={POOL_OPTIONS}
            error={form.formState.errors.destination_pool?.message}
          />
        </div>

        <Field
          label="Amount (ZEC)"
          hint={
            quote.data !== undefined
              ? `${formatZecAmount(quote.data.max_zatoshi)} spendable after a ${formatZecAmount(quote.data.fee_zatoshi)} network fee.`
              : `${formatZecAmount(available)} available in the ${sourcePool} pool.`
          }
          error={form.formState.errors.amount?.message}
        >
          {(aria) => (
            <div className="flex items-stretch gap-2">
              <input
                {...aria}
                {...form.register('amount')}
                inputMode="decimal"
                autoComplete="off"
                className={controlStyles}
              />
              <Button
                type="button"
                variant="subtle"
                size="sm"
                disabled={quote.data === undefined || quote.data.max_zatoshi === 0n}
                onClick={() => {
                  const max = quote.data?.max_zatoshi;
                  if (max === undefined) return;
                  form.setValue('amount', formatZec(max, { grouping: false }), {
                    shouldDirty: true,
                    shouldValidate: true,
                  });
                  form.clearErrors('amount');
                }}
              >
                Max
              </Button>
            </div>
          )}
        </Field>

        <Field
          label="Memo (optional)"
          hint={
            memoEnabled
              ? `${memoByteLength(memo)}/${MEMO_MAX_BYTES} bytes, encrypted to the recipient.`
              : 'Memos are only available for ironwood destinations.'
          }
          error={form.formState.errors.memo?.message}
        >
          {(aria) => (
            <textarea
              {...aria}
              {...form.register('memo')}
              disabled={!memoEnabled}
              placeholder={memoEnabled ? 'Add a private note for the recipient' : undefined}
              rows={2}
              autoComplete="off"
              className={cn(controlStyles, 'disabled:cursor-not-allowed disabled:opacity-50')}
            />
          )}
        </Field>

        <Button
          type="submit"
          variant="primary"
          size="block"
          loading={busy}
          disabled={busy || matchTerminal || Boolean(payments.error)}
        >
          {busy
            ? send.isPending && submittedHere
              ? 'Submitting payment…'
              : 'Another payment is submitting…'
            : (retryLabel ?? 'Send ZEC')}
          {!send.isPending && <ArrowRight />}
        </Button>
      </form>
    </Dialog>
  );
}
