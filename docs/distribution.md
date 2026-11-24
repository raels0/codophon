# Distribution

Installing Codophon? Start with the [Windows install](../README.md#install-on-windows)
in the README. See [GitHub Copilot setup](../README.md#use-github-copilot-in-codophon)
if you want to use Ask or Walkthrough.
This page is for building and releasing the app.

## Native Apps

Codophon uses Electron Forge at the repository root:

- App bundle ID: `com.github.raels0.codophon`
- Product name: `Codophon`
- URL scheme: `codophon`

Build commands:

```sh
pnpm make
pnpm make:ci
pnpm make:mac
```

`pnpm make:mac` builds the renderer and then runs the Apple Silicon build:

```sh
electron-forge make --platform=darwin --arch=arm64
```

For a local unsigned smoke test, run `CODOPHON_UNSIGNED_BUILD=1 pnpm package:app`. Release builds require a signing identity.

For a signed and notarized macOS build, export the Apple environment variables `pnpm make:mac`:

```sh
export APPLE_ID='apple-id@example.com'
export APPLE_PASSWORD='app-specific-password-or-keychain-profile'
export APPLE_TEAM_ID='TEAMID12345'
export APPLE_SIGNING_IDENTITY='Developer ID Application: Your Organization (TEAMID12345)'
pnpm make:mac
```

The signing certificate must already be present in the local keychain. If `APPLE_SIGNING_IDENTITY` is omitted, Electron's signing tooling may choose a matching Developer ID identity automatically, but setting it explicitly is less ambiguous.

## GitHub Actions

`.github/workflows/build-app.yml` builds Linux and Windows artifacts using Ubuntu and Windows runners. macOS builds are intentionally local-only for now because they require the Developer ID certificate in the local keychain.
