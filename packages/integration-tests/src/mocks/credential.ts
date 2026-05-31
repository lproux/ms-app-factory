// `TokenCredential` shape (mirrored locally to avoid pulling @azure/identity
// into the integration-tests package). Same surface as @azure/identity.
export interface FakeAccessToken {
  token: string;
  expiresOnTimestamp: number;
}

export interface FakeTokenCredential {
  getToken(scopes: string | string[]): Promise<FakeAccessToken | null>;
}

/**
 * A `TokenCredential`-shaped fake. Always returns a synthetic bearer token.
 */
export function makeFakeCredential(): FakeTokenCredential {
  return {
    async getToken(_scopes: string | string[]): Promise<FakeAccessToken | null> {
      return {
        token: 'fake-access-token-for-integration-tests',
        expiresOnTimestamp: Date.now() + 60 * 60 * 1000,
      };
    },
  };
}

/**
 * Drop-in replacement for `@app-factory/auth-broker` `getCredential` that
 * never touches MSAL / device-code / interactive-browser. Returns the fake
 * credential from {@link makeFakeCredential}.
 */
export function getCredentialMock(): FakeTokenCredential {
  return makeFakeCredential();
}
