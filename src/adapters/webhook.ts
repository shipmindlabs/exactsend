import type { Adapter, SendContext } from './types.ts';

const encoder = new TextEncoder();

export interface WebhookRequest {
  readonly method: 'POST';
  readonly headers: Record<string, string>;
  readonly body: Uint8Array;
}

export interface WebhookResponse {
  readonly ok: boolean;
  readonly status: number;

  text(): Promise<string>;
}

export type WebhookFetch = (url: string, request: WebhookRequest) => Promise<WebhookResponse>;

export interface WebhookAdapterOptions {
  readonly url: string;
  readonly fetch: WebhookFetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly honoursIdempotencyKey?: boolean;
}

export class WebhookAdapter implements Adapter {
  readonly honoursIdempotencyKey: boolean;
  readonly #url: string;
  readonly #fetch: WebhookFetch;
  readonly #headers: Readonly<Record<string, string>>;

  constructor(options: WebhookAdapterOptions) {
    this.#url = options.url;
    this.#fetch = options.fetch;
    this.#headers = Object.freeze({ ...options.headers });
    // Sending the header is not the same as the endpoint deduplicating on it, so the claim
    // belongs to whoever knows the endpoint.
    this.honoursIdempotencyKey = options.honoursIdempotencyKey ?? false;
  }

  render(draft: Record<string, unknown>, target: string): Uint8Array {
    return encoder.encode(stableJson({ target, draft }));
  }

  async send(bytes: Uint8Array, { executionKey }: SendContext): Promise<string | null> {
    const response = await this.#fetch(this.#url, {
      method: 'POST',
      headers: {
        ...this.#headers,
        'Content-Type': 'application/json',
        'Idempotency-Key': executionKey,
      },
      body: bytes,
    });
    if (!response.ok) {
      throw new Error(`${this.#url} answered ${String(response.status)}`);
    }
    const reference = (await response.text()).trim();
    return reference === '' ? null : reference;
  }
}

// Keys are sorted, so two drafts that differ only in key order render the same bytes and
// therefore digest the same.
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key: string, raw: unknown) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return raw;
    }
    const record = raw as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = record[key];
    }
    return sorted;
  });
}
