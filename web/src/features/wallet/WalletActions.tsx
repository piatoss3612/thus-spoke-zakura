import { useMemo, useRef, useState, type ReactNode } from 'react';
import { WalletActionsContext, type WalletActionsApi } from './wallet-actions-context';
import { useAccounts, useMiningJob } from '@/hooks/queries';
import { SendDialog } from './SendDialog';
import { FaucetDialog } from './FaucetDialog';
import { MineDialog } from './MineDialog';
import { MiningStatus } from './MiningStatus';
import { Button } from '@/components/ui/Button';
import { useSend, useFaucet } from '@/hooks/mutations';
import { useRetainedPayments, type PaymentIdentity } from '@/hooks/payment-identity';
import { WalletPaymentsContext } from './payment-context';

type OpenDialog = 'send' | 'faucet' | 'mine' | null;

/**
 * Owns the transaction dialogs so the header and the account cards can trigger
 * them without threading state through the tree.
 */
export function WalletActionsProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [faucetAccount, setFaucetAccount] = useState<number | undefined>(undefined);
  const [sendAccount, setSendAccount] = useState<number | undefined>(undefined);
  const [sendDraft, setSendDraft] = useState<PaymentIdentity | undefined>();
  const [faucetDraft, setFaucetDraft] = useState<PaymentIdentity | undefined>();
  const savedSend = useRetainedPayments('send');
  const savedFaucet = useRetainedPayments('faucet');
  const liveKeys = useRef(new Set<string>());
  const lifecycle = {
    onRetained: (identity: PaymentIdentity) => {
      liveKeys.current.add(identity.key);
      (identity.kind === 'send' ? savedSend : savedFaucet).show(identity);
    },
    onRejected: (identity: PaymentIdentity) => {
      (identity.kind === 'send' ? savedSend : savedFaucet).dismissKey(identity.key);
    },
  };
  const send = useSend(lifecycle);
  const faucet = useFaucet(lifecycle);
  const { data: accounts = [] } = useAccounts();
  const { data: mining } = useMiningJob();
  const job = mining?.job;

  const api = useMemo<WalletActionsApi>(
    () => ({
      openSend: (accountId, draft) => {
        setSendAccount(accountId);
        setSendDraft(draft);
        setDialog('send');
      },
      openFaucet: (accountId, draft) => {
        setFaucetAccount(accountId);
        setFaucetDraft(draft);
        setDialog('faucet');
      },
      openMine: () => setDialog('mine'),
    }),
    [],
  );

  const close = (open: boolean) => {
    if (!open) setDialog(null);
  };

  return (
    <WalletActionsContext value={api}>
      <WalletPaymentsContext
        value={{
          send,
          faucet,
          savedSend,
          savedFaucet,
          isRestored: (key) => !liveKeys.current.has(key),
        }}
      >
        {children}
        {job && job.state !== 'completed' && (
          <section
            aria-label="Mining job"
            className="xp-raised bg-panel fixed right-4 bottom-20 z-20 w-[min(380px,calc(100vw-32px))] space-y-3 rounded-xs p-4 shadow-(--shadow-float) md:right-6 md:bottom-6"
          >
            <MiningStatus job={job} />
            <Button size="sm" onClick={() => setDialog('mine')}>
              View mining
            </Button>
          </section>
        )}
        {/* Keyed so each dialog remounts with fresh defaults per open. */}
        {dialog === 'send' && (
          <SendDialog
            key={`send-${sendAccount ?? 'any'}`}
            open
            onOpenChange={close}
            accounts={accounts}
            draft={sendDraft}
            {...(sendAccount === undefined ? {} : { defaultAccountId: sendAccount })}
          />
        )}
        {dialog === 'faucet' && (
          <FaucetDialog
            key={`faucet-${faucetAccount ?? 'any'}`}
            open
            onOpenChange={close}
            accounts={accounts}
            draft={faucetDraft}
            {...(faucetAccount === undefined ? {} : { defaultAccountId: faucetAccount })}
          />
        )}
        {dialog === 'mine' && <MineDialog key="mine" open onOpenChange={close} />}
      </WalletPaymentsContext>
    </WalletActionsContext>
  );
}
