import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppFactoryError } from '@app-factory/shared';
import { runComputerUseTask } from '../src/computer-use.js';

describe('runComputerUseTask', () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });

  it('throws COMPUTER_USE_NO_KEY (recoverable) when ANTHROPIC_API_KEY is unset', async () => {
    let caught: unknown;
    try {
      await runComputerUseTask({ goal: 'consent to admin app' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppFactoryError);
    expect(caught).toMatchObject({ code: 'COMPUTER_USE_NO_KEY', recoverable: true });
  });
});
