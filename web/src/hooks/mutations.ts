import { useCallback, useRef } from 'react';
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import {
  api,
  errorMessage,
  idempotencyKey,
  isPaymentRejection,
  type Activity,
  type MiningJob,
} from '@/lib/api';
import { isTerminalPayment, queryKeys } from './queries';
import {
  clearPayment,
  paymentName,
  retainPayment,
  retainedPaymentKey,
  type PaymentIdentity,
  type PaymentKind,
  type SendVariables,
  type FaucetVariables,
} from './payment-identity';
export type { SendVariables, FaucetVariables } from './payment-identity';

/** Everything a successful money movement invalidates. */
function walletKeys() {
  return [[...queryKeys.accounts], ['activity'], [...queryKeys.status], ['blocks'], ['send-quote']];
}

function useInvalidateWallet() {
  const queryClient = useQueryClient();
  return useCallback(async () => {
    await Promise.all(
      walletKeys().map((key) =>
        queryClient.invalidateQueries({ queryKey: key, refetchType: 'active' }),
      ),
    );
  }, [queryClient]);
}

function operationKey<T>(
  kind: string,
  fingerprint: (variables: T) => string,
  storageArea = sessionStorage,
) {
  const storageKey = (variables: T) => `ths:${kind}:${fingerprint(variables)}`;
  return {
    nameFor: storageKey,
    keyFor(variables: T) {
      const itemKey = storageKey(variables);
      let key = storageArea.getItem(itemKey);
      if (!key) {
        key = idempotencyKey();
      }
      storageArea.setItem(itemKey, key);
      return key;
    },
    clear(variables: T) {
      storageArea.removeItem(storageKey(variables));
      if (storageArea === localStorage) sessionStorage.removeItem(storageKey(variables));
    },
  };
}

export type PaymentResult = { activity: Activity; key: string; cleanupError?: string };
type PaymentSubmission<T> = { variables: T; key: string | undefined; error?: unknown };
type PaymentCallbacks<T> = {
  onError?: (error: Error, variables: T) => void;
  onSuccess?: (result: PaymentResult, variables: T) => void;
};

function usePaymentMutation<T extends SendVariables | FaucetVariables>(
  kind: PaymentKind,
  post: (variables: T, key: string) => Promise<Activity>,
) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateWallet();
  const ownedKeys = useRef(new Map<string, string>());
  const clear = useCallback(
    async (identity: PaymentIdentity) => {
      try {
        await clearPayment(identity, ownedKeys.current);
      } finally {
        void invalidate();
      }
    },
    [invalidate],
  );
  // The sender and the status card both learn of a confirmation, in an order
  // that depends on rendering; whichever sees it first announces it.
  const announced = useRef(new Set<string>());
  const claimAnnouncement = useCallback((key: string) => {
    if (announced.current.has(key)) return false;
    announced.current.add(key);
    return true;
  }, []);
  const mutation = useMutation<PaymentResult, Error, PaymentSubmission<T>>({
    mutationFn: async (submission) => {
      if ('error' in submission) throw submission.error;
      const { variables, key } = submission;
      const identity = await retainPayment(kind, variables, ownedKeys.current, key);
      try {
        const activity = await post(variables, identity.key);
        return { activity, key: identity.key };
      } catch (error) {
        // An expired wallet journal can preserve the claim even after a
        // rejected proposal. Release only when a keyed lookup proves it absent;
        // a lookup failure must leave the identity available for recovery.
        if (isPaymentRejection(error) && !(await api.payment(identity.key))) {
          await clearPayment(identity, ownedKeys.current);
        }
        throw error;
      }
    },
    retry: false,
    onSuccess: async (result, { variables }) => {
      const { activity, key } = result;
      // A lookup started before acceptance must not overwrite this response.
      await queryClient.cancelQueries({ queryKey: queryKeys.payment(key) });
      queryClient.setQueryData<Activity | null>(queryKeys.payment(key), (previous) =>
        isTerminalPayment(previous) ? previous : activity,
      );
      if (isTerminalPayment(activity)) {
        try {
          await clearPayment(
            { kind, name: paymentName(kind, variables), key, variables } as PaymentIdentity,
            ownedKeys.current,
          );
        } catch (error) {
          // Cleanup cannot change the server's outcome. Keep the dialog open
          // so its status card can show the warning and recover on reopening.
          result.cleanupError = errorMessage(error);
        }
      }
      // Query owners handle wallet refresh errors. Acceptance must not wait
      // for node-dependent views while stored payment status is available.
      void invalidate();
    },
  });
  const submission = (variables: T, key?: string): PaymentSubmission<T> => {
    try {
      // Capture retained identity at the user action, before a queued lock or
      // terminal status update can release it. This action only replays that key.
      return {
        variables,
        key: key ?? retainedPaymentKey(paymentName(kind, variables), ownedKeys.current),
      };
    } catch (error) {
      return {
        variables,
        key: undefined,
        error: error instanceof DOMException ? new Error(error.message, { cause: error }) : error,
      };
    }
  };
  const callbacks = (options?: PaymentCallbacks<T>) => ({
    onError: (error: Error, { variables }: PaymentSubmission<T>) =>
      options?.onError?.(error, variables),
    onSuccess: (result: PaymentResult, { variables }: PaymentSubmission<T>) =>
      options?.onSuccess?.(result, variables),
  });
  const resume = (identity: PaymentIdentity, options?: PaymentCallbacks<T>) => {
    mutation.mutate(submission(identity.variables as T, identity.key), callbacks(options));
  };
  return {
    ...mutation,
    clear,
    resume,
    claimAnnouncement,
    /** Names the payment whose POST is in flight, so its status can say so. */
    pendingName:
      mutation.isPending && mutation.variables
        ? paymentName(kind, mutation.variables.variables)
        : null,
    mutate: (variables: T, options?: PaymentCallbacks<T>) =>
      mutation.mutate(submission(variables), callbacks(options)),
    mutateAsync: (variables: T) => mutation.mutateAsync(submission(variables)),
  };
}

export function useSend(): UseMutationResult<Activity, Error, SendVariables> {
  const invalidate = useInvalidateWallet();
  const operation = operationKey('send', (variables: SendVariables) =>
    JSON.stringify([
      variables.from_account,
      variables.to_account,
      variables.source_pool,
      variables.destination_pool,
      variables.amount_zatoshi.toString(),
      variables.memo ?? null,
    ]),
  );
  return useMutation({
    mutationFn: (variables: SendVariables) =>
      api.send({ ...variables, idempotency_key: operation.keyFor(variables) }),
    onSuccess: async (_activity, variables) => {
      operation.clear(variables);
      await invalidate();
    },
  });
}

export function useFaucet() {
  return usePaymentMutation('faucet', (variables: FaucetVariables, key) =>
    api.faucet({ ...variables, idempotency_key: key }),
  );
}

export function useStartMining(): UseMutationResult<MiningJob, Error, number> {
  const queryClient = useQueryClient();
  const operation = operationKey('mine', (blocks: number) => String(blocks));
  return useMutation({
    mutationFn: (blocks: number) => {
      const state = queryClient.getQueryData<{ job: MiningJob | null }>(queryKeys.mining)?.job
        ?.state;
      if (state === 'completed' || state === 'failed') operation.clear(blocks);
      return api.startMining(blocks, operation.keyFor(blocks));
    },
    retry: false,
    onSuccess: async (job, blocks) => {
      operation.clear(blocks);
      queryClient.setQueryData(queryKeys.mining, { job });
      await queryClient.invalidateQueries({ queryKey: queryKeys.mining });
    },
    onError: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.mining });
    },
  });
}
