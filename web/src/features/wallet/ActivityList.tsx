import { Link } from 'react-router-dom';
import { ArrowDownToLine, ArrowRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import { absoluteTime, shortHash, timeAgo } from '@/lib/format';
import { formatZecAmount } from '@/lib/money';
import { errorMessage, type Activity } from '@/lib/api';
import { EmptyState, ErrorState } from '@/components/ui/StateBlock';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { Badge } from '@/components/ui/Badge';
import { statusTone } from '@/components/ui/status-tone';
import { DataTable, NumCell, Row, type Column } from '@/components/ui/DataTable';
import { Panel } from '@/components/ui/Panel';

const COLUMNS: Column[] = [
  { key: 'transfer', header: 'Transfer', width: '196px' },
  { key: 'route', header: 'Route', collapse: true, width: '172px' },
  { key: 'txid', header: 'Transaction' },
  { key: 'amount', header: 'Amount', align: 'right', width: '92px' },
  { key: 'when', header: 'When', align: 'right', collapse: true, width: '104px' },
  { key: 'status', header: 'Status', align: 'right', width: '100px' },
];

/** Shielded funds read in accent; public funds read in neutral ink. */
function PoolLabel({ pool }: { pool: Activity['source_pool'] }) {
  return (
    <span
      className={cn(
        'text-[11px] font-bold tracking-[0.04em] uppercase',
        pool === 'ironwood' ? 'text-accent' : 'text-ink-muted',
      )}
    >
      {pool}
    </span>
  );
}

function ActivityRow({ activity, index }: { activity: Activity; index: number }) {
  const isFaucet = activity.kind === 'faucet';
  const transactionPath = activity.txid ? `/explorer/tx/${activity.txid}` : null;
  const transfer = isFaucet
    ? `Faucet → Account ${activity.to_account}`
    : `Account ${activity.from_account ?? '?'} → Account ${activity.to_account}`;

  return (
    <Row index={index} {...(transactionPath ? { to: transactionPath } : {})}>
      <td>
        <div className="flex items-center gap-2.5">
          <span
            className={cn(
              'xp-raised grid size-6 shrink-0 place-items-center rounded-xs',
              isFaucet ? 'bg-accent-soft text-accent' : 'bg-raised text-ink-muted',
            )}
            aria-hidden
          >
            {isFaucet ? <ArrowDownToLine className="size-3" /> : <ArrowRight className="size-3" />}
          </span>
          {transactionPath ? (
            <Link to={transactionPath} className="min-w-0 font-semibold hover:underline">
              <span className="block truncate">{transfer}</span>
            </Link>
          ) : (
            <span className="min-w-0 truncate font-semibold">{transfer}</span>
          )}
        </div>
        {activity.last_error && (
          <p
            className={cn(
              'mt-1 text-[11px] wrap-anywhere',
              activity.status === 'failed' ? 'text-negative' : 'text-warning',
            )}
          >
            {activity.status === 'failed' ? 'Failed: ' : 'Latest execution error: '}
            {activity.last_error}
          </p>
        )}
      </td>

      <td className="max-sm:hidden">
        <PoolLabel pool={activity.source_pool} />
        <span className="text-ink-muted px-1.5">→</span>
        <PoolLabel pool={activity.destination_pool} />
      </td>

      <td className="min-w-0">
        {activity.txid ? (
          <code className="text-ink block truncate font-mono" title={activity.txid}>
            {shortHash(activity.txid)}
          </code>
        ) : (
          <span className="text-ink-muted">Not prepared</span>
        )}
      </td>

      <NumCell className="font-semibold">{formatZecAmount(activity.amount_zatoshi)}</NumCell>

      <NumCell className="text-ink-muted max-sm:hidden">
        <time dateTime={activity.created_at} title={absoluteTime(activity.created_at)}>
          {timeAgo(activity.created_at)}
        </time>
      </NumCell>

      <td className="text-right">
        <Badge tone={statusTone(activity.status)}>{activity.status}</Badge>
      </td>
    </Row>
  );
}

export function ActivityList({
  activity,
}: {
  activity: {
    data?: Activity[] | undefined;
    isPending: boolean;
    isError: boolean;
    error: unknown;
  };
}) {
  const count = activity.data?.length ?? 0;

  return (
    <Panel
      title="Recent activity"
      className="min-w-0"
      meta={
        <Badge>
          {count} event{count === 1 ? '' : 's'}
        </Badge>
      }
    >
      {activity.isPending && <SkeletonRows rows={4} />}
      {activity.isError && <ErrorState message={errorMessage(activity.error)} />}
      {activity.data &&
        (count === 0 ? (
          <EmptyState message="No transactions yet. Use the faucet to create your first activity." />
        ) : (
          <DataTable columns={COLUMNS}>
            {activity.data.map((item, index) => (
              <ActivityRow key={item.id} activity={item} index={index} />
            ))}
          </DataTable>
        ))}
    </Panel>
  );
}
