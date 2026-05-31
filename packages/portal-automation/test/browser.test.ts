import { describe, expect, it } from 'vitest';
import { buildSafeContextOptions } from '../src/browser.js';

describe('buildSafeContextOptions', () => {
  it('force-disables recordVideo and recordHar', () => {
    const opts = buildSafeContextOptions();
    expect(opts).toHaveProperty('recordVideo');
    expect(opts).toHaveProperty('recordHar');
    expect(opts.recordVideo).toBeUndefined();
    expect(opts.recordHar).toBeUndefined();
  });

  it('threads storageStatePath through when supplied', () => {
    const opts = buildSafeContextOptions({ storageStatePath: '/tmp/storage.json' });
    expect(opts.storageState).toBe('/tmp/storage.json');
    expect(opts.recordVideo).toBeUndefined();
    expect(opts.recordHar).toBeUndefined();
  });

  it('omits storageState when no path is given', () => {
    const opts = buildSafeContextOptions({});
    expect(opts.storageState).toBeUndefined();
  });
});
