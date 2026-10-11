import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, useWatch } from 'react-hook-form';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { useToast } from '@/components/ui/toast-context';
import { errorMessage, isPaymentRejection, type Account } from '@/lib/api';
import { formatZecAmount } from '@/lib/money';
import { useFaucet, type FaucetVariables, type PaymentResult } from '@/hooks/mutations';
import { paymentName, useRetainedPayments } from '@/hooks/payment-identity';
import { faucetSchema, type FaucetInput, type FaucetValues } from './schemas';
import { controlStyles } from '@/components/ui/control-styles';
import { SelectField } from './fields';
import { POOL_OPTIONS, accountOptions } from './field-options';
import { PaymentStatus, PaymentWarning } from './PaymentStatus';

export function FaucetDialog({
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
  const faucet = useFaucet();
  const payments = useRetainedPayments('faucet', open);

  const form = useForm<FaucetInput, unknown, FaucetValues>({
    resolver: zodResolver(faucetSchema),
    mode: 'onChange',
    // Defaults to 1 ZEC rather than the 5 ZEC ceiling: the treasury is funded
    // from block rewards, and requests at the maximum are the first to fail
    // once the subsidy has halved.
    defaultValues: { account_id: String(defaultAccountId ?? 1), pool: 'ironwood', amount: '1' },
  });
  const variablesFor = (values: FaucetValues) => ({
    account_id: values.account_id,
    pool: values.pool,
    amount_zatoshi: values.amount,
  });
  const current = faucetSchema.safeParse(useWatch({ control: form.control }));
  const retryLabel =
    current.success &&
    payments.retained.some(
      (item) => item.name === paymentName('faucet', variablesFor(current.data)),
    )
      ? `Retry ${formatZecAmount(current.data.amount)} to Account ${current.data.account_id}`
      : null;
  const announce = ({ activity, key }: PaymentResult) => {
    if (!faucet.claimAnnouncement(key)) return;
    toast.success(
      `Funded Account ${activity.to_account}`,
      `${formatZecAmount(activity.amount_zatoshi)} confirmed.`,
    );
  };
  const failed = (error: Error, variables: FaucetVariables) => {
    if (isPaymentRejection(error)) {
      payments.dismiss(paymentName('faucet', variables));
      toast.error('Payment rejected', errorMessage(error));
    } else {
      toast.error('Payment not confirmed', errorMessage(error));
    }
  };

  const submit = form.handleSubmit((values) => {
    const variables = variablesFor(values);
    const retained = payments.retained.find(
      (item) => item.name === paymentName('faucet', variables),
    );
    const submitted = {
      onError: failed,
      // Finish only the submitted draft; inputs can change during the POST.
      onSuccess: (result: PaymentResult, variables: FaucetVariables) => {
        if (result.activity.status !== 'confirmed') return;
        announce(result);
        if (result.cleanupError) return;
        const draft = faucetSchema.safeParse(form.getValues());
        if (
          !draft.success ||
          paymentName('faucet', variablesFor(draft.data)) !== paymentName('faucet', variables)
        )
          return;
        onOpenChange(false);
        form.reset();
      },
    };
    if (retained) faucet.resume(retained, submitted);
    else faucet.mutate(variables, submitted);
  });
  const resumed = {
    onError: failed,
    onSuccess: (result: PaymentResult) => {
      if (result.activity.status === 'confirmed') announce(result);
    },
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      eyebrow="DEV TOOLS"
      title="Fund an account"
      description="Creates new test funds from the mining treasury and mines a block to confirm."
    >
      {open &&
        payments.displayed.map((identity) => (
          <PaymentStatus
            key={identity.key}
            identity={identity}
            pendingName={faucet.pendingName}
            claimAnnouncement={faucet.claimAnnouncement}
            onTerminal={faucet.clear}
            onResume={(item) => faucet.resume(item, resumed)}
          />
        ))}
      {payments.error && (
        <PaymentWarning role="alert" className="mb-3">
          <p>Could not read saved payments: {errorMessage(payments.error)}</p>
        </PaymentWarning>
      )}
      <form onSubmit={(event) => void submit(event)} noValidate>
        <SelectField
          control={form.control}
          name="account_id"
          label="Destination account"
          options={accountOptions(accounts)}
          error={form.formState.errors.account_id?.message}
        />
        <SelectField
          control={form.control}
          name="pool"
          label="Destination pool"
          options={POOL_OPTIONS}
          error={form.formState.errors.pool?.message}
        />
        <Field
          label="Amount (ZEC)"
          hint="Maximum 5 ZEC per request."
          error={form.formState.errors.amount?.message}
        >
          {(aria) => (
            <input
              {...aria}
              {...form.register('amount')}
              inputMode="decimal"
              autoComplete="off"
              className={controlStyles}
            />
          )}
        </Field>

        <Button
          type="submit"
          variant="primary"
          size="block"
          loading={faucet.isPending}
          disabled={!form.formState.isValid || faucet.isPending}
        >
          {faucet.isPending ? 'Requesting…' : (retryLabel ?? 'Add funds')}
        </Button>
      </form>
    </Dialog>
  );
}
