import { createLogger } from './log.js';

const log = createLogger('telemetry');

export interface Event {
  kind: string;
  runId?: string;
  worker?: string;
  duration_ms?: number;
  ok?: boolean;
  attributes?: Record<string, unknown>;
}

export function emit(event: Event): void {
  log.info(event, event.kind);
}

export async function span<T>(kind: string, fn: () => Promise<T>, attributes?: Record<string, unknown>): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    emit({ kind, ok: true, duration_ms: Date.now() - start, attributes });
    return result;
  } catch (err) {
    emit({
      kind,
      ok: false,
      duration_ms: Date.now() - start,
      attributes: { ...attributes, error: (err as Error).message },
    });
    throw err;
  }
}
