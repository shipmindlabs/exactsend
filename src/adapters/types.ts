import type { ActionRenderer, RenderRequest } from '../proposal.ts';
import type { ActionAdapter } from '../registry.ts';

export interface SendContext {
  readonly executionKey: string;
}

export type ProviderState = 'sent' | 'not-sent' | 'unknown';

export interface ProviderStatus {
  readonly state: ProviderState;
  readonly providerRef: string | null;
}

export interface Adapter {
  // Whether the provider deduplicates on the execution key: what decides later whether a
  // retry under the same key is safe or has to be reconciled first.
  readonly honoursIdempotencyKey: boolean;

  render(draft: Record<string, unknown>, target: string): Uint8Array | Promise<Uint8Array>;

  send(bytes: Uint8Array, context: SendContext): Promise<string | null>;

  queryStatus?(executionKey: string): Promise<ProviderStatus>;
}

export interface RegisteredAdapter extends ActionAdapter, ActionRenderer {
  readonly honoursIdempotencyKey: boolean;

  queryStatus?(executionKey: string): Promise<ProviderStatus>;
}

// What the executor hands a registered adapter: the approved bytes of the revision and the
// key the provider may deduplicate on.
interface SendEnvelope {
  readonly payload: Uint8Array;
  readonly executionKey: string;
}

type MutableAdapter = {
  -readonly [K in keyof RegisteredAdapter]: RegisteredAdapter[K];
};

export function actionAdapter(adapter: Adapter): RegisteredAdapter {
  const query = adapter.queryStatus;
  const registered: MutableAdapter = {
    honoursIdempotencyKey: adapter.honoursIdempotencyKey,
    render: (request: RenderRequest) => adapter.render(request.draft, request.target),
    send: async (action: Record<string, unknown>) => {
      const envelope = action as unknown as SendEnvelope;
      return await adapter.send(envelope.payload, { executionKey: envelope.executionKey });
    },
  };
  if (query !== undefined) {
    // Reconciliation has to be able to ask the provider, so the query survives registration.
    registered.queryStatus = async (executionKey) => await query.call(adapter, executionKey);
  }
  return Object.freeze(registered);
}
