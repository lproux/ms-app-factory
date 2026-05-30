import { describe, expect, it, vi } from 'vitest';
import { AppFactoryError, PortalRequiredError } from '@app-factory/shared';
import { withFallback } from '../src/fallback.js';

describe('withFallback', () => {
  it('returns the primary result when primary succeeds; playwright is not called', async () => {
    const primary = vi.fn(async () => 'primary-ok');
    const playwright = vi.fn(async () => 'pw-result');
    const computerUse = vi.fn(async () => 'cu-result');

    const result = await withFallback({ primary, playwright, computerUse, label: 'happy' });

    expect(result).toBe('primary-ok');
    expect(primary).toHaveBeenCalledTimes(1);
    expect(playwright).not.toHaveBeenCalled();
    expect(computerUse).not.toHaveBeenCalled();
  });

  it('rethrows non-PortalRequiredError verbatim without invoking fallbacks', async () => {
    const boom = new Error('boom');
    const primary = vi.fn(async () => {
      throw boom;
    });
    const playwright = vi.fn(async () => 'pw-result');
    const computerUse = vi.fn(async () => 'cu-result');

    await expect(
      withFallback({ primary, playwright, computerUse, label: 'non-portal' }),
    ).rejects.toBe(boom);
    expect(playwright).not.toHaveBeenCalled();
    expect(computerUse).not.toHaveBeenCalled();
  });

  it('invokes playwright fallback when primary throws PortalRequiredError', async () => {
    const primary = vi.fn(async () => {
      throw new PortalRequiredError('needs portal', 'https://portal.example.com');
    });
    const playwright = vi.fn(async () => 'pw-recovered');
    const computerUse = vi.fn(async () => 'cu-result');

    const result = await withFallback({ primary, playwright, computerUse, label: 'pw-recover' });

    expect(result).toBe('pw-recovered');
    expect(primary).toHaveBeenCalledTimes(1);
    expect(playwright).toHaveBeenCalledTimes(1);
    expect(computerUse).not.toHaveBeenCalled();
  });

  it('falls through to computer-use when playwright also fails', async () => {
    const primary = vi.fn(async () => {
      throw new PortalRequiredError('needs portal', 'https://portal.example.com');
    });
    const playwright = vi.fn(async () => {
      throw new Error('playwright not installed');
    });
    const computerUse = vi.fn(async () => 'cu-recovered');

    const result = await withFallback({ primary, playwright, computerUse, label: 'cu-recover' });

    expect(result).toBe('cu-recovered');
    expect(playwright).toHaveBeenCalledTimes(1);
    expect(computerUse).toHaveBeenCalledTimes(1);
  });

  it('throws PORTAL_FALLBACK_EXHAUSTED when no fallbacks are provided', async () => {
    const portalErr = new PortalRequiredError('needs portal', 'https://portal.example.com');
    const primary = vi.fn(async () => {
      throw portalErr;
    });

    await expect(withFallback({ primary, label: 'no-fallback' })).rejects.toMatchObject({
      code: 'PORTAL_FALLBACK_EXHAUSTED',
    });
    await expect(withFallback({ primary, label: 'no-fallback' })).rejects.toBeInstanceOf(
      AppFactoryError,
    );
  });
});
