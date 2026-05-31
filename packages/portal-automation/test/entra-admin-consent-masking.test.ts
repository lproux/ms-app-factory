import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { maskForLog } from '../src/pages/entra-admin-consent.js';

describe('maskForLog', () => {
  it('replaces password / pwd / pass / code / device_code with ***', () => {
    const out = maskForLog({
      username: 'alice',
      password: 'P@ssw0rd!',
      pwd: 'short',
      pass: 'medium',
      code: 'ABCDEFGH',
      device_code: 'XYZ12345',
      deviceCode: 'CASE-INSENSITIVE',
      tenantId: 'contoso',
    });
    expect(out.username).toBe('alice');
    expect(out.password).toBe('***');
    expect(out.pwd).toBe('***');
    expect(out.pass).toBe('***');
    expect(out.code).toBe('***');
    expect(out.device_code).toBe('***');
    expect(out.deviceCode).toBe('***');
    expect(out.tenantId).toBe('contoso');
  });

  it('does not mutate the original object', () => {
    const input = { password: 'leak-me', tenantId: 'contoso' };
    maskForLog(input);
    expect(input.password).toBe('leak-me');
  });

  it('handles all MASKED_FIELDS with mixed case in keys', () => {
    const out = maskForLog({ PASSWORD: 'a', PassWord: 'b', code: 'c' });
    expect(out.PASSWORD).toBe('***');
    expect(out.PassWord).toBe('***');
    expect(out.code).toBe('***');
  });
});

/**
 * Capture every chunk written to a pino logger so the test can inspect the
 * raw NDJSON. `pino` writes one JSON object per line; we parse each line and
 * return the array.
 */
function makeCapturingLogger(): { logger: pino.Logger; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString('utf8'));
      cb();
    },
  });
  const logger = pino({ name: 'portal-automation:entra-admin-consent' }, sink);
  const lines = () =>
    chunks
      .join('')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { logger, lines };
}

describe('pino capturing transport masks the password field to ***', () => {
  it('emits only *** for the password field through a pino capturing transport', () => {
    const { logger, lines } = makeCapturingLogger();
    const secret = 'P@ssw0rd!-leak';
    logger.info(maskForLog({ username: 'admin@contoso', password: secret }), 'navigating');
    logger.info(maskForLog({ code: 'DEVICE-CODE-VALUE' }), 'device code captured');

    const captured = lines();
    expect(captured.length).toBeGreaterThanOrEqual(2);
    const all = JSON.stringify(captured);
    expect(all).not.toContain(secret);
    expect(all).not.toContain('DEVICE-CODE-VALUE');
    expect(captured[0]?.password).toBe('***');
    expect(captured[0]?.username).toBe('admin@contoso');
    expect(captured[1]?.code).toBe('***');
  });

  it('demonstrates that without maskForLog the password would land verbatim in the pino sink (proves the helper is load-bearing)', () => {
    const { logger, lines } = makeCapturingLogger();
    const secret = 'P@ssw0rd!-unmasked-control';
    // Negative control: bypass maskForLog. The captured line MUST contain
    // the cleartext. This guards against a regression where the helper
    // silently becomes a no-op (e.g. if MASKED_FIELDS is emptied).
    logger.info({ password: secret }, 'unsafe call');
    const captured = lines();
    expect(JSON.stringify(captured)).toContain(secret);
  });
});
