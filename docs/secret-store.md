# Secret store

`@app-factory/secret-store` persists run-scoped secrets to the OS keyring and
(optionally) mirrors them into an Azure Key Vault for unattended scenarios.

Since the keytar → `@napi-rs/keyring` migration (security/maint: keytar was
archived in 2023; `@napi-rs/keyring` ships prebuilt N-API binaries and is
actively maintained), the backend is automatically selected by platform:

| Platform | Backend                       |
| -------- | ----------------------------- |
| Linux    | libsecret (Secret Service)    |
| macOS    | Keychain                      |
| Windows  | Credential Manager            |

`SecretStore.set('cs', 'invokeUrl', value)` writes an entry under service
`app-factory:cs`, account `invokeUrl` — identical to the keytar layout, so
secrets stored by older builds remain accessible.

## Platform deps

`@napi-rs/keyring` ships prebuilt binaries, so the JS side has no postinstall
build. The native backend may still require a system library:

| Distro             | Install                                  |
| ------------------ | ---------------------------------------- |
| Debian / Ubuntu    | `sudo apt install libsecret-1-dev`       |
| Fedora / RHEL      | `sudo dnf install libsecret-devel`       |
| Arch               | `sudo pacman -S libsecret`               |
| Alpine             | `apk add libsecret-dev`                  |
| macOS / Windows    | nothing — Keychain / Credential Manager  |

Linux server / container hosts often lack libsecret AND have no D-Bus session
to talk to it. The store treats that as an unrecoverable runtime error.

## `APP_FACTORY_ALLOW_MEMORY_SECRETS` escape hatch

If the OS keyring is missing, `SecretStore.set` / `.get` throw
`AppFactoryError('SECRET_STORE_UNAVAILABLE', …, { recoverable: true })` by
default. To explicitly opt into the **ephemeral in-memory fallback** (values
live only for the current Node process and never touch disk), set:

```bash
export APP_FACTORY_ALLOW_MEMORY_SECRETS=1
```

This is gated because silent in-memory fallback is the worst of both worlds:
the caller thinks the secret is persisted but it vanishes when the process
exits. The env var forces operators to acknowledge the trade-off.

CI runners and ephemeral containers are the typical valid use case.

## Pairing with Azure Key Vault for production

Pass `keyVaultUrl` + a `TokenCredential` to `buildSecretStore` and the store
mirrors every `set` into Key Vault and falls back to it on `get` miss. Use
this for unattended / multi-host deploys where the local OS keyring isn't a
durable source of truth. See `docs/auth-and-secrets.md` for the auth-broker
wiring that produces the credential.
