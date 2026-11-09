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
