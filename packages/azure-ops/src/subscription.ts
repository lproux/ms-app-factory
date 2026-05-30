import type { TokenCredential } from '@azure/identity';
import { SubscriptionClient } from '@azure/arm-subscriptions';
import { AppFactoryError, createLogger } from '@app-factory/shared';

const log = createLogger('azure-ops:subscription');

export interface SubscriptionSummary {
  id: string;
  displayName: string;
  tenantId: string;
  state: string;
}

export async function listSubscriptions(cred: TokenCredential): Promise<SubscriptionSummary[]> {
  const client = new SubscriptionClient(cred);
  const out: SubscriptionSummary[] = [];
  for await (const sub of client.subscriptions.list()) {
    out.push({
      id: sub.subscriptionId ?? '',
      displayName: sub.displayName ?? '',
      tenantId: sub.tenantId ?? '',
      state: String(sub.state ?? 'Unknown'),
    });
  }
  log.debug({ count: out.length }, 'listed subscriptions');
  return out;
}

export async function pickSubscription(
  cred: TokenCredential,
  hint: string,
): Promise<{ id: string; displayName: string }> {
  const subs = await listSubscriptions(cred);
  if (subs.length === 0) {
    throw new AppFactoryError('NO_SUBSCRIPTION', 'no Azure subscriptions visible to credential');
  }

  const lowered = hint.toLowerCase();
  if (lowered === 'default' || lowered === '') {
    const enabled = subs.find((s) => s.state.toLowerCase() === 'enabled') ?? subs[0];
    if (!enabled) {
      throw new AppFactoryError('NO_SUBSCRIPTION', 'no enabled subscription found');
    }
    return { id: enabled.id, displayName: enabled.displayName };
  }

  const byId = subs.find((s) => s.id === hint);
  if (byId) return { id: byId.id, displayName: byId.displayName };

  const byName = subs.find((s) => s.displayName.toLowerCase() === lowered);
  if (byName) return { id: byName.id, displayName: byName.displayName };

  throw new AppFactoryError(
    'SUBSCRIPTION_NOT_FOUND',
    `subscription hint "${hint}" did not match any visible subscription (have: ${subs
      .map((s) => `${s.displayName}/${s.id}`)
      .join(', ')})`,
  );
}
