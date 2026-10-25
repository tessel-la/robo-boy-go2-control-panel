# Releasing

`dev` integrates topic PRs; `main` receives reviewed release promotions. release-please
owns version changes, tags, and `CHANGELOG.md`. The manifest file seeds the current source
version; it does not assert that a release with that version has already been published.

## First release setup

1. Review and merge the readiness topic through `dev`, preserving existing default-branch work. The prepared local `dev` starts at the current `main`; push it before enabling the workflows.
2. Enable GitHub Actions and allow Actions to create pull requests. The built-in token handles release PRs and tags; `RELEASE_PLEASE_TOKEN` is optional for deployments that require a separate bot token. Never commit one.
3. Configure protection/review for `dev` and `main`. Allow the sync workflow to merge `main` back into `dev`, or resolve a protected-branch rejection through review. Do not force-push.
4. Open a promotion from `dev` to `main` with a Conventional Commit title. Merge it with a merge commit. Review the release-please PR, then merge it to create the versioned tag and release.
5. Run the publication checks below before making any catalog entry live. Confirm repository history has been scanned for secrets and third-party notices are present before making source public.

While the project is on `0.x`, describe incompatible changes in the PR body and release notes
without `!` or `BREAKING CHANGE:` markers that would force a `1.0.0` bump.

## Dependency updates

Use Node.js 22 and npm. Keep the SDK pinned to its versioned public GitHub tarball and
use `import type` only. Update dependencies intentionally with npm, commit the lockfile,
and prove `npm ci` works without sibling repositories.

```bash
npm ci
npm run release:prepare
```

The artifact job runs in the same workflow as release-please so releases made by the
built-in token still get their assets. It checks out the released tag, builds the exact
locked source, verifies the committed SRI, and uploads `roboboy.panel.json`, `index.js`,
and `LICENSE`. Existing assets are not overwritten. A failed job must be resolved before
registration; do not rewrite an already consumed release. Use a new release for changed bytes.

## Register in the Panel Inventory

After the source and release assets are publicly reachable, run the inventory's
`npm run register -- --panel NAME --version VERSION` command for this panel using its
real released version. `NAME` is `go2` or `microduck`. The command fetches anonymous
manifest/bundle bytes, verifies identity, version and SHA-256, and then writes the entry.
Run `npm run validate` and review the catalog diff before merging it.

The catalog must not point at draft, private, mutable, or guessed release URLs. Test the
installer with this panel alone and with both robot panels; `selection: all` deployments
will discover newly registered entries. Verify permission preview/apply, add, reload,
reconnect, inactive/active, resize, remove, and failure retry in light/dark at 390 px and
wide tile sizes. Installing a panel must not start its simulator.

## Limitations

Source visibility changes do not publish runnable panel artifacts or update the inventory.
GitHub Actions must be enabled and the release/configuration branches must exist remotely.
The final anonymous download and installer checks require public release assets.
