export class AppFactoryError extends Error {
  readonly code: string;
  readonly recoverable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    opts: { recoverable?: boolean; cause?: unknown; details?: Record<string, unknown> } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = 'AppFactoryError';
    this.code = code;
    this.recoverable = opts.recoverable ?? false;
    this.details = opts.details;
  }
}

export class AuthError extends AppFactoryError {
  constructor(message: string, opts: ConstructorParameters<typeof AppFactoryError>[2] = {}) {
    super('AUTH', message, opts);
    this.name = 'AuthError';
  }
}

export class PortalRequiredError extends AppFactoryError {
  readonly portalUrl: string;
  constructor(
    message: string,
    portalUrl: string,
    opts: ConstructorParameters<typeof AppFactoryError>[2] = {},
  ) {
    super('PORTAL_REQUIRED', message, { ...opts, recoverable: true });
    this.name = 'PortalRequiredError';
    this.portalUrl = portalUrl;
  }
}

export class ProvisioningError extends AppFactoryError {
  constructor(message: string, opts: ConstructorParameters<typeof AppFactoryError>[2] = {}) {
    super('PROVISIONING', message, opts);
    this.name = 'ProvisioningError';
  }
}

export class JudgeVetoError extends AppFactoryError {
  readonly votes: { judge: string; verdict: string; reason: string }[];
  constructor(message: string, votes: JudgeVetoError['votes']) {
    super('JUDGE_VETO', message, { recoverable: true });
    this.name = 'JudgeVetoError';
    this.votes = votes;
  }
}
