import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { ArrowRight } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { useToast } from '@/components/ui/toast-context';
import { errorMessage, isPaymentRejection, type Account } from '@/lib/api';
import { formatZec, formatZecAmount } from '@/lib/money';
import { useSend, type PaymentResult, type SendVariables } from '@/hooks/mutations';
import { paymentName, useRetainedPayments } from '@/hooks/payment-identity';
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
import { PaymentStatus, PaymentWarning } from './PaymentStatus';

export function SendDialog({
  open,
  onOpenChange,
  accounts,
  defaultAccountId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: Account[];
  defaultAccountId?: number;
}) {
  const toast = useToast();
  const send = useSend();
  const payments = useRetainedPayments('send', open);
  const fromAccountId = defaultAccountId ?? 1;

  const form = useForm<SendInput, unknown, SendValues>({
    resolver: zodResolver(sendSchema),
    defaultValues: {
      from_account: String(fromAccountId),
      to_account: String(accounts.find((account) => account.id !== fromAccountId)?.id ?? 1),
      source_pool: 'ironwood',
      destination_pool: 'ironwood',
      amount: '1',
      memo: '',
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
  const retryLabel =
    current.success &&
    payments.retained.some((item) => item.name === paymentName('send', variablesFor(current.data)))
      ? `Retry ${formatZecAmount(current.data.amount)} to Account ${current.data.to_account}`
      : null;
  const announce = ({ activity, key }: PaymentResult) => {
    if (!send.claimAnnouncement(key)) return;
    toast.success(
      `Sent to Account ${activity.to_account}`,
      `${formatZecAmount(activity.amount_zatoshi)} confirmed.`,
    );
  };
  const failed = (error: Error, variables: SendVariables) => {
    if (isPaymentRejection(error)) {
      payments.dismiss(paymentName('send', variables));
      toast.error('Payment rejected', errorMessage(error));
    } else {
      toast.error('Payment not confirmed', errorMessage(error));
    }
  };
  // A direct confirmation finishes only the submitted draft. Inputs remain
  // editable during the POST, and a later confirmation must preserve edits.
  const submitted = {
    onError: failed,
    onSuccess: (result: PaymentResult, variables: SendVariables) => {
      if (result.activity.status !== 'confirmed') return;
      announce(result);
      if (result.cleanupError) return;
      const draft = sendSchema.safeParse(form.getValues());
      if (
        !draft.success ||
        paymentName('send', variablesFor(draft.data)) !== paymentName('send', variables)
      )
        return;
      onOpenChange(false);
      form.reset();
    },
  };
  const resumed = {
    onError: failed,
    onSuccess: (result: PaymentResult) => {
      if (result.activity.status === 'confirmed') announce(result);
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

  const submit = form.handleSubmit(async (values) => {
    // Replaying retained work must not depend on the account's current balance
    // or a new proposal; it may already have spent those funds.
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
  });

  const options = accountOptions(accounts);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      eyebrow="NEW TRANSACTION"
      title="Send ZEC"
      description="Moves existing funds between development accounts or pools. One block is mined to confirm."
    >
      {open &&
        payments.displayed.map((identity) => (
          <PaymentStatus
            key={identity.key}
            identity={identity}
            pendingName={send.pendingName}
            claimAnnouncement={send.claimAnnouncement}
            onTerminal={send.clear}
            onResume={(item) => send.resume(item, resumed)}
          />
        ))}
      {payments.error && (
        <PaymentWarning role="alert" className="mb-3">
          <p>Could not read saved payments: {errorMessage(payments.error)}</p>
        </PaymentWarning>
      )}
      <form onSubmit={(event) => void submit(event)} noValidate>
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

        <Button type="submit" variant="primary" size="block" loading={send.isPending}>
          {send.isPending ? 'Submitting…' : (retryLabel ?? 'Send ZEC')}
          {!send.isPending && <ArrowRight />}
        </Button>
      </form>
    </Dialog>
  );
}
