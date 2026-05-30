import { AppFactoryError, PortalRequiredError, createLogger, span } from '@app-factory/shared';

const log = createLogger('portal:fallback');

export interface FallbackOpts<T> {
  primary: () => Promise<T>;
  playwright?: () => Promise<T>;
  computerUse?: () => Promise<T>;
  label?: string;
}

/**
 * Run `primary`. If it throws a `PortalRequiredError`, try `playwright` next,
 * then `computerUse`. Any other error from `primary` is rethrown verbatim.
 *
 * When no fallback succeeds, throws AppFactoryError('PORTAL_FALLBACK_EXHAUSTED')
 * with the original PortalRequiredError as its cause.
 */
export async function withFallback<T>(opts: FallbackOpts<T>): Promise<T> {
  const label = opts.label ?? 'portal-fallback';
  return span(`fallback:${label}`, async () => {
    try {
      return await opts.primary();
    } catch (err) {
      if (!(err instanceof PortalRequiredError)) throw err;
      log.warn(
        { portalUrl: err.portalUrl, label },
        'primary requires portal; falling back to playwright',
      );
      if (opts.playwright) {
        try {
          return await opts.playwright();
        } catch (pwErr) {
          log.warn(
            { err: (pwErr as Error).message, label },
            'playwright fallback failed; trying computer-use',
          );
        }
      }
      if (opts.computerUse) {
        return await opts.computerUse();
      }
      throw new AppFactoryError(
        'PORTAL_FALLBACK_EXHAUSTED',
        `no fallback completed ${label}`,
        { cause: err },
      );
    }
  });
}
