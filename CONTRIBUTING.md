# Contributing to Ember

Use Node.js 24 and Windows for desktop packaging. Clone the repository, run `npm ci`, then use `npm run dev` for the renderer or `npm start` for the desktop app. Run `npm test` and `npm run build` before opening a pull request.

Keep changes focused and describe the user-visible behavior, relevant verification, and any remaining limitations. Include screenshots for visual changes. Add regression coverage for data loss, dependency handling, downloads, and updater behavior; small visual changes can be checked with screenshots instead of implementation-mirroring tests.

Preserve existing profile storage and the `modrelay://app` origin when changing branding. Do not commit real profiles, share codes containing personal configuration, downloaded mod archives, Steam installations, credentials, signing keys, or generated release executables. Use synthetic fixtures for tests.

Treat mods and archives as untrusted input. Keep game/profile paths scoped, preserve download and installer verification, and use fixed trusted update providers. Client applications must never contain a GitHub token. Do not silently change the update repository or weaken verification to make a test pass.

Original Ember code is available under the MIT license. Third-party dependencies and game artwork retain their existing licenses and notices; see `THIRD-PARTY-NOTICES.md`. By submitting a contribution, you agree that your original contribution is provided under the project's MIT license. Only submit material you have the right to contribute.

## Publishing a client release

The repository must be public, and both `package.repository` and the GitHub provider in `package.build.publish` must name this repository. CI uses a temporary `GITHUB_TOKEN`; no personal token is required in source or in the distributed application.

1. Update the stable version with `npm version patch --no-git-tag-version` (or choose a new minor/major version).
2. Update `RELEASE-NOTES.md` and versioned user documentation. Review and merge the change to `main`.
3. The version-file push starts the Windows release workflow. It tests the source, packages NSIS and portable builds, verifies `latest.yml`, and publishes a stable `v<version>` release with checksums and notices. A `v<version>` tag push or a manual workflow run can also initiate the same flow.
4. Inspect the Actions run and release assets. An already-published version is skipped rather than overwritten. For a corrected binary, publish a new version.

The release workflow refuses lower/equal stable versions, mismatched tags, and a provider pointing at another repository. Never publish `latest.yml` for files that failed to build. Portable builds use the release download page for manual replacement; installed Windows builds use the NSIS update feed.
