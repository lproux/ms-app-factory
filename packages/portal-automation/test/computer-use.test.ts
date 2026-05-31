import { AppFactoryError } from '@app-factory/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redactSecrets, runComputerUseTask } from '../src/computer-use.js';

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
    vi.unstubAllEnvs();
    vi.resetModules();
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

describe('redactSecrets', () => {
  it('masks values for keys matching the secret pattern', () => {
    const out = redactSecrets({
      username: 'alice',
      password: 'P@ssw0rd!',
      token: 'tok_secret_value',
      api_key: 'sk-live-xxx',
      apiKey: 'sk-live-yyy',
      client_secret: 'cs-zzz',
      clientSecret: 'cs-camel',
      user_code: 'ABCD1234',
      userCode: 'EFGH5678',
      secret: 'literal',
      privateKey: 'pem',
    }) as Record<string, unknown>;
    expect(out.username).toBe('alice');
    expect(out.password).toBe('<redacted>');
    expect(out.token).toBe('<redacted>');
    expect(out.api_key).toBe('<redacted>');
    expect(out.apiKey).toBe('<redacted>');
    expect(out.client_secret).toBe('<redacted>');
    expect(out.clientSecret).toBe('<redacted>');
    expect(out.user_code).toBe('<redacted>');
    expect(out.userCode).toBe('<redacted>');
    expect(out.secret).toBe('<redacted>');
    expect(out.privateKey).toBe('<redacted>');
  });

  it('recurses into nested objects and arrays', () => {
    const out = redactSecrets({
      outer: {
        password: 'leak-me',
        nested: { token: 't' },
      },
      items: [{ password: 'a' }, { user: 'bob' }],
    }) as { outer: { password: string; nested: { token: string } }; items: unknown[] };
    expect(out.outer.password).toBe('<redacted>');
    expect(out.outer.nested.token).toBe('<redacted>');
    expect((out.items[0] as Record<string, string>).password).toBe('<redacted>');
    expect((out.items[1] as Record<string, string>).user).toBe('bob');
  });

  it('returns primitives unchanged', () => {
    expect(redactSecrets('hello')).toBe('hello');
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(null)).toBe(null);
    expect(redactSecrets(undefined)).toBe(undefined);
  });

  it('does not mutate its input', () => {
    const input = { password: 'leak-me', nested: { token: 't' } };
    const snapshot = JSON.parse(JSON.stringify(input));
    redactSecrets(input);
    expect(input).toEqual(snapshot);
  });
});

describe('runComputerUseTask request payload', () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-test-fake';
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalKey;
    }
    vi.resetModules();
  });

  it('redacts secret-bearing keys from task.context before forwarding to the SDK', async () => {
    const create = vi.fn(async () => ({ ok: true, mocked: 'response' }));
    const FakeAnthropic = vi.fn().mockImplementation(() => ({
      beta: { messages: { create } },
    }));

    vi.doMock('@anthropic-ai/sdk', () => ({
      default: FakeAnthropic,
      Anthropic: FakeAnthropic,
    }));

    const { runComputerUseTask: run } = await import('../src/computer-use.js');

    const secretPassword = 'super-secret-P@ss';
    const secretToken = 'tok_abcdef';
    const apiKey = 'sk-leaky-12345';
    const result = await run({
      goal: 'sign in and consent',
      url: 'https://login.microsoftonline.com/contoso/adminconsent',
      context: {
        username: 'admin@contoso.onmicrosoft.com',
        password: secretPassword,
        token: secretToken,
        api_key: apiKey,
        nested: { client_secret: 'leak-cs' },
      },
    });

    expect(FakeAnthropic).toHaveBeenCalledWith({ apiKey: 'sk-test-fake' });
    expect(create).toHaveBeenCalledTimes(1);
    const callArg = create.mock.calls[0]?.[0] as { messages: { content: string }[] } | undefined;
    expect(callArg).toBeDefined();
    if (!callArg) throw new Error('expected call arg');
    const content = callArg.messages[0]?.content ?? '';
    // The original secret values must NOT appear anywhere in the request body.
    expect(content).not.toContain(secretPassword);
    expect(content).not.toContain(secretToken);
    expect(content).not.toContain(apiKey);
    expect(content).not.toContain('leak-cs');
    // Each scrubbed slot is replaced with the literal `<redacted>` marker.
    expect(content).toContain('<redacted>');
    // Non-secret values still flow through.
    expect(content).toContain('admin@contoso.onmicrosoft.com');
    // Returned value is the JSON-stringified SDK response.
    expect(result).toBe(JSON.stringify({ ok: true, mocked: 'response' }));
  });
});
