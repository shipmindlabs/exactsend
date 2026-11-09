import type { Adapter, ProviderStatus, SendContext } from './types.ts';

const encoder = new TextEncoder();

export type EmailTemplate = (draft: Record<string, unknown>, target: string) => string;

export interface EmailProvider {
  deliver(bytes: Uint8Array, idempotencyKey: string): Promise<string>;

  status(idempotencyKey: string): Promise<ProviderStatus>;
}

export interface EmailAdapterOptions {
  readonly provider: EmailProvider;
  readonly template?: EmailTemplate;
}

export interface EmailAdapter extends Adapter {
  readonly honoursIdempotencyKey: true;

  render(draft: Record<string, unknown>, target: string): Uint8Array;

  send(bytes: Uint8Array, context: SendContext): Promise<string>;

  queryStatus(executionKey: string): Promise<ProviderStatus>;
}

export function emailAdapter(options: EmailAdapterOptions): EmailAdapter {
  const provider = options.provider;
  const template = options.template ?? defaultTemplate;
  return {
    honoursIdempotencyKey: true,
    render: (draft, target) => encoder.encode(template(draft, target)),
    send: async (bytes, { executionKey }) => await provider.deliver(bytes, executionKey),
    queryStatus: async (executionKey) => await provider.status(executionKey),
  };
}

export interface DeliveredEmail {
  readonly bytes: Uint8Array;
  readonly idempotencyKey: string;
  readonly providerRef: string;
}

export class FakeEmailProvider implements EmailProvider {
  readonly #delivered: DeliveredEmail[] = [];
  readonly #byKey = new Map<string, DeliveredEmail>();

  get delivered(): readonly DeliveredEmail[] {
    return Object.freeze([...this.#delivered]);
  }

  async deliver(bytes: Uint8Array, idempotencyKey: string): Promise<string> {
    const seen = this.#byKey.get(idempotencyKey);
    if (seen !== undefined) {
      return seen.providerRef;
    }
    const email: DeliveredEmail = Object.freeze({
      bytes: new Uint8Array(bytes),
      idempotencyKey,
      providerRef: `fake-email-${String(this.#delivered.length + 1)}`,
    });
    this.#delivered.push(email);
    this.#byKey.set(idempotencyKey, email);
    return email.providerRef;
  }

  async status(idempotencyKey: string): Promise<ProviderStatus> {
    const seen = this.#byKey.get(idempotencyKey);
    if (seen === undefined) {
      return Object.freeze({ state: 'not-sent' as const, providerRef: null });
    }
    return Object.freeze({ state: 'sent' as const, providerRef: seen.providerRef });
  }
}

function defaultTemplate(draft: Record<string, unknown>, target: string): string {
  return [`To: ${target}`, `Subject: ${text(draft.subject)}`, '', text(draft.body)].join('\n');
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
