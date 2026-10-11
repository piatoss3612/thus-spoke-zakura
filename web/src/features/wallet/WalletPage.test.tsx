import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient } from '@tanstack/react-query';
import {
  renderWithProviders,
  renderWithWalletActions,
  requestUrl,
  testAccounts,
} from '@/test/utils';
import { queryKeys } from '@/hooks/queries';
import { api, type Activity } from '@/lib/api';
import { PaymentUpdates } from './PaymentUpdates';
import { WalletActionsProvider } from './WalletActions';
import { WalletPage } from './WalletPage';

const TXID = 'ab'.repeat(32);

function json(body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

function mockWalletApis(status = 'confirmed') {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = requestUrl(input);
    if (url.includes('/accounts')) {
      return json([
        {
          id: 1,
          name: 'Account 1',
          unified_address: 'uregtest1account1verylongunifiedaddressfortruncation',
          transparent_address: 'tmAccount1',
          transparent_zatoshi: 0,
          ironwood_zatoshi: 500_000_000,
        },
      ]);
    }
    if (url.includes('/activity')) {
      return json([
        {
          id: 'act-1',
          kind: 'faucet',
          from_account: null,
          to_account: 1,
          source_pool: 'ironwood',
          destination_pool: 'ironwood',
          amount_zatoshi: 500_000_000,
          txid: status === 'failed' ? '' : TXID,
          block_hash: 'cd'.repeat(32),
          status,
          last_error:
            status === 'failed'
              ? 'Insufficient funds'
              : status === 'broadcast'
                ? 'Lightwalletd unavailable'
                : null,
          created_at: '2026-09-18 10:00:00',
        },
      ]);
    }
    return json({
      instance: 'default',
      node: null,
      account_count: 5,
      auto_mine: true,
      network: 'regtest',
    });
  });
}

function renderWallet(status = 'confirmed') {
  mockWalletApis(status);
  return renderWithProviders(
    <MemoryRouter>
      <WalletActionsProvider>
        <PaymentUpdates />
        <WalletPage />
      </WalletActionsProvider>
    </MemoryRouter>,
  );
}

function savedFaucet(
  key: string,
  account: number,
  status: Activity['status'] | null,
): Activity | null {
  const name = `ths:faucet:${account}:ironwood:500000000`;
  localStorage.setItem(name, key);
  localStorage.setItem(`ths:faucet:retained:${key}`, name);
  return status === null
    ? null
    : {
        id: key,
        kind: 'faucet',
        from_account: null,
        to_account: account,
        source_pool: 'ironwood',
        destination_pool: 'ironwood',
        amount_zatoshi: 500_000_000n,
        txid: status === 'confirmed' ? TXID : '',
        block_hash: null,
        status,
        last_error: status === 'failed' ? 'Insufficient funds' : null,
        created_at: '2026-10-11 00:00:00',
      };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WalletPage', () => {
  it.each(['confirmed', 'failed', 'broadcast'])(
    'restores %s outside the dialogs using GET only',
    async (status) => {
      const name = 'ths:faucet:1:ironwood:500000000';
      const key = 'restored-faucet-key';
      localStorage.setItem(name, key);
      localStorage.setItem(`ths:faucet:retained:${key}`, name);
      renderWallet(status);
      const trigger = await screen.findByRole('button', { name: /View payments/ });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await waitFor(() =>
        expect(trigger).toHaveAccessibleName(
          status === 'broadcast' ? /1 unresolved/ : new RegExp(`1 ${status}`),
        ),
      );
      // Cleanup happens while the panel is closed; opening it still shows the result.
      if (status !== 'broadcast')
        await waitFor(() => expect(localStorage.getItem(name)).toBeNull());
      await userEvent.click(trigger);
      const updates = await screen.findByRole('region', { name: 'Payment updates' });
      expect(
        await within(updates).findByText(
          status === 'broadcast' ? 'Pending' : status === 'confirmed' ? 'Confirmed' : 'Failed',
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText('Funded Account 1')).not.toBeInTheDocument();
      expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(([input]) => requestUrl(input).includes(`idempotency_key=${key}`)),
      ).toBe(true);
      if (status === 'broadcast') {
        expect(within(updates).getByText('Waiting for confirmation')).toBeInTheDocument();
        expect(localStorage.getItem(name)).toBe(key);
        expect(within(updates).getByRole('button', { name: 'Resume' })).toBeInTheDocument();
      } else {
        await waitFor(() => expect(localStorage.getItem(name)).toBeNull());
        expect(updates).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Clear finished' }));
        expect(within(updates).queryByRole('heading')).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
        expect(screen.queryByRole('button', { name: /View payments/ })).not.toBeInTheDocument();
      }
    },
  );

  it('filters results without stopping hidden checks or clearing hidden results', async () => {
    mockWalletApis();
    const payments = new Map([
      ['pending-key', savedFaucet('pending-key', 1, 'broadcast')],
      ['confirmed-key', savedFaucet('confirmed-key', 2, 'confirmed')],
      ['failed-key', savedFaucet('failed-key', 3, 'failed')],
      ['unknown-key', savedFaucet('unknown-key', 4, null)],
    ]);
    const lookup = vi
      .spyOn(api, 'payment')
      .mockImplementation((key) => Promise.resolve(payments.get(key) ?? null));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderWithWalletActions(<WalletPage />, client);
    await userEvent.click(await screen.findByRole('button', { name: /View payments/ }));
    const filters = screen.getByRole('group', { name: 'Filter payments' });
    const updates = screen.getByRole('region', { name: 'Payment updates' });
    expect(
      await within(filters).findByRole('button', { name: 'Unresolved 2' }),
    ).toBeInTheDocument();
    expect(await within(updates).findByText('Pending')).toBeInTheDocument();
    expect(await within(updates).findByText('Unknown')).toBeInTheDocument();
    await userEvent.click(await within(filters).findByRole('button', { name: 'Failed 1' }));
    expect(within(updates).getAllByRole('heading')).toHaveLength(1);
    expect(within(updates).getByText('Failed')).toBeInTheDocument();
    const reads = lookup.mock.calls.filter(([key]) => key === 'pending-key').length;
    await act(() =>
      client.refetchQueries({ queryKey: queryKeys.payment('pending-key'), type: 'active' }),
    );
    expect(lookup.mock.calls.filter(([key]) => key === 'pending-key')).toHaveLength(reads + 1);
    await userEvent.click(screen.getByRole('button', { name: 'Clear failed' }));
    expect(await within(updates).findByText('No failed payments.')).toBeInTheDocument();
    expect(within(filters).getByRole('button', { name: 'Failed 0' })).toBeEnabled();
    expect(within(filters).getByRole('button', { name: 'Confirmed 1' })).toBeInTheDocument();
    expect(localStorage.getItem('ths:faucet:1:ironwood:500000000')).toBe('pending-key');
    expect(localStorage.getItem('ths:faucet:4:ironwood:500000000')).toBe('unknown-key');
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: /View payments/ }));
    expect(screen.getByRole('button', { name: 'All 3' })).toHaveAttribute('aria-pressed', 'true');
    expect(
      within(screen.getByRole('region', { name: 'Payment updates' })).getAllByRole('heading'),
    ).toHaveLength(3);
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('keeps lookup errors unresolved and updates filter membership without losing focus', async () => {
    mockWalletApis();
    let payment = savedFaucet('live-key', 1, 'broadcast');
    let readError = false;
    vi.spyOn(api, 'payment').mockImplementation(() =>
      readError ? Promise.reject(new Error('Connection lost')) : Promise.resolve(payment),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderWithWalletActions(<WalletPage />, client);
    await userEvent.click(await screen.findByRole('button', { name: /View payments/ }));
    const updates = screen.getByRole('region', { name: 'Payment updates' });
    const selected = screen.getByRole('button', { name: 'Unresolved 1' });
    await userEvent.click(selected);
    const resume = await within(updates).findByRole('button', { name: 'Resume' });
    resume.focus();
    readError = true;
    await act(() => client.refetchQueries({ queryKey: queryKeys.payment('live-key') }));
    expect(await within(updates).findByText(/Couldn’t check status/)).toBeInTheDocument();
    expect(within(updates).getByText('Pending')).toBeInTheDocument();
    expect(within(updates).getByText('Last known: Waiting for confirmation')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Failed 0' })).toBeInTheDocument();
    expect(resume).toHaveFocus();
    expect(localStorage.getItem('ths:faucet:1:ironwood:500000000')).toBe('live-key');
    readError = false;
    payment = { ...payment!, status: 'confirmed', txid: TXID };
    await act(() => client.refetchQueries({ queryKey: queryKeys.payment('live-key') }));
    expect(await within(updates).findByText('No unresolved payments.')).toBeInTheDocument();
    await waitFor(() => expect(selected).toHaveFocus());
    expect(selected).toHaveAccessibleName('Unresolved 0');
    expect(selected).toHaveAttribute('aria-pressed', 'true');
    expect(within(updates).queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirmed 1' })).toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem('ths:faucet:1:ironwood:500000000')).toBeNull());
    await userEvent.click(within(updates).getByRole('button', { name: 'Show all' }));
    expect(within(updates).getByText('Confirmed')).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('tracks a late POST after closing its dialog and preserves a newly opened draft', async () => {
    vi.spyOn(api, 'accounts').mockResolvedValue(testAccounts);
    vi.spyOn(api, 'sendQuote').mockResolvedValue({
      available_zatoshi: 500_000_000n,
      fee_zatoshi: 10_000n,
      max_zatoshi: 499_990_000n,
    });
    let resolve!: (activity: Activity) => void;
    let payment: Activity | null = null;
    const response = new Promise<Activity>((done) => {
      resolve = done;
    });
    const post = vi.spyOn(api, 'send').mockReturnValue(response);
    vi.spyOn(api, 'payment').mockImplementation(() => Promise.resolve(payment));
    renderWallet();
    await waitFor(() =>
      expect(screen.getAllByRole('heading', { name: /Account [1-5]/ })).toHaveLength(5),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Send ZEC' }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Send ZEC' }),
    );
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /View payments/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Send ZEC' }));
    await userEvent.clear(screen.getByLabelText('Amount (ZEC)'));
    await userEvent.type(screen.getByLabelText('Amount (ZEC)'), '2');
    await act(async () => {
      payment = {
        id: 'late-send',
        kind: 'send',
        from_account: 1,
        to_account: 2,
        source_pool: 'ironwood',
        destination_pool: 'ironwood',
        amount_zatoshi: 100_000_000n,
        status: 'confirmed',
        txid: TXID,
        block_hash: null,
        last_error: null,
        created_at: '2026-10-11 00:00:00',
      };
      resolve(payment);
      await response;
    });
    await waitFor(() =>
      expect(screen.getByText('Payments').closest('button')).toHaveAttribute(
        'aria-label',
        expect.stringMatching(/1 confirmed/),
      ),
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('Amount (ZEC)')).toHaveValue('2');
    expect(screen.getAllByText('Sent to Account 2')).toHaveLength(1);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('uses the wrapping page rhythm the explorer and network surfaces share', async () => {
    const { container } = renderWallet();
    await waitFor(() => expect(screen.getByText('Account 1')).toBeInTheDocument());

    expect(container.firstElementChild).toHaveClass('grid', 'gap-4');
    expect(screen.getByRole('button', { name: 'Send ZEC' }).parentElement).toHaveClass('flex-wrap');
  });

  it('does not dump a full transaction id into the activity table', async () => {
    renderWallet();
    const tx = await screen.findByTitle(TXID);
    expect(tx).not.toHaveTextContent(TXID);
    expect(tx.textContent?.includes('…')).toBe(true);
  });

  it.each(['failed', 'broadcast'])(
    'describes %s payment errors and links only prepared transactions',
    async (status) => {
      renderWallet(status);
      expect(await screen.findByText('1 event')).toBeInTheDocument();
      const transfer = screen.getByRole('cell', { name: 'Faucet → Account 1' });
      const row = transfer.closest('tr')!;
      const detail = row.nextElementSibling as HTMLElement;
      const message =
        status === 'failed'
          ? 'Failed: Insufficient funds'
          : 'Latest execution error: Lightwalletd unavailable';
      expect(within(detail).getByText(message)).toBeInTheDocument();
      expect(transfer).toHaveAccessibleDescription(message);
      expect(within(detail).queryByRole('link')).not.toBeInTheDocument();
      if (status === 'failed') {
        expect(within(row).getByText('Not prepared')).toBeInTheDocument();
        expect(within(row).queryByRole('link')).not.toBeInTheDocument();
      } else {
        const link = within(transfer).getByRole('link');
        expect(link).toHaveAccessibleDescription(message);
        expect(link).toHaveAttribute('href', `/explorer/tx/${TXID}`);
      }
    },
  );
});
