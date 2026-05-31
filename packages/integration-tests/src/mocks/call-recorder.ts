import { createLogger } from '@app-factory/shared';

const log = createLogger('integration-tests:call-recorder');

/**
 * A simple per-test call recorder. Used to assert that side-effecting calls
 * (e.g., outbound HTTP, execa) really did happen (or did NOT happen in plan
 * mode). Tests reset it in `beforeEach`.
 */
export interface RecordedCall {
  kind: 'execa' | 'spawn' | 'http' | 'graph' | 'arm';
  target: string;
  argv?: unknown[];
  url?: string;
  method?: string;
}

class CallRecorder {
  private calls: RecordedCall[] = [];

  reset(): void {
    this.calls = [];
  }

  record(call: RecordedCall): void {
    this.calls.push(call);
    log.debug({ call }, 'recorded call');
  }

  all(): readonly RecordedCall[] {
    return this.calls;
  }

  byKind(kind: RecordedCall['kind']): readonly RecordedCall[] {
    return this.calls.filter((c) => c.kind === kind);
  }

  count(): number {
    return this.calls.length;
  }
}

export const callRecorder = new CallRecorder();
