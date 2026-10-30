# Fork changes

E4 Code is a personal fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code). Each patch on top of upstream is listed here by commit subject.

## feat(desktop): rebrand fork as E4 Code

Lets E4 Code install next to T3 Code without sharing state.

- App ID `com.eliasschneider.e4code`, product name "E4 Code" (no "Beta" suffix; nightlies stay "E4 Code (Nightly)").
- Data in `~/.e4` and Electron profile `e4code` instead of `~/.t3` and `t3code-v2`.
- Linux executable, WM class, desktop entry and `.deb` package renamed to `e4code`.
- Desktop updates, CLI archives and release links point at `stonith404/e4code`.
- Tests updated to the new names.

## feat(branding): E4 wordmark in app icons and logos

Keeps upstream's three icon designs (black production, night-sky nightly, blueprint dev) and swaps the T3 wordmark for a geometric E4.

- `text.svg` in the dev, nightly and prod Icon Composer projects carries the E4 mark; the dev `annotations.svg` dimension lines follow the new glyphs.
- iOS, universal, Windows, web favicon and Android assets regenerated with `icons:export` and `icons:export:android`. The macOS pre-Tahoe PNGs are composed from the universal export (824 body inset 100, soft shadow) because the export only works in the Icon Composer GUI.
- Android monochrome and notification marks redrawn by hand at the same bounds as upstream's T3 silhouettes.
- `T3Wordmark` in web and mobile, the mobile widget mark, `assets/prod/logo.svg`, the DMG backgrounds and the mobile showcase favicon use the E4 path. Component and file names stay as upstream's to keep syncs small.

## ci: add E4 release workflow

`e4-release.yml` replaces upstream's `release.yml`, which only runs in pingdotgg/t3code. It reuses `release-desktop.yml` on GitHub-hosted runners without T3 Connect, npm, AUR, web, mobile or Discord publishing. Nightlies run hourly when main has changed (at least 6 hours apart). Stable releases come from a `vX.Y.Z` tag or a manual dispatch. Upstream's other workflows are disabled in the repository settings.

Upstream syncs rebase these patches onto upstream's main, so `check-nightly-release.cjs` also releases a main that diverged from the last nightly, instead of skipping it.

## ci(desktop): sign macOS builds with a self-signed identity

Lets the in-app updater install new builds on Macs that trust the fork's certificate. Squirrel.Mac only swaps in an update whose signature matches the running app, which ad hoc builds never do.

- `.github/actions/import-mac-signing-identity` imports `CSC_LINK` into a keychain, trusts it as a root when it is self-signed (otherwise macOS lists no valid identity) and returns the identity name. The CLI archive and desktop jobs both use it.
- When `CSC_LINK` is set but the Apple notarization secrets are not, the desktop job passes the identity as `T3CODE_DESKTOP_MAC_SIGN_IDENTITY`. `build-desktop-artifact.ts` then sets `mac.identity` with hardened runtime and notarization off, instead of upstream's `--signed` path that needs a provisioning profile.
- Gatekeeper still shows the unverified-developer dialog on first launch, since only notarized Developer ID builds skip it.
- Each Mac that should receive in-app updates trusts the certificate once: `security add-trusted-cert -r trustRoot -p codeSign -k ~/Library/Keychains/login.keychain-db e4code-signing.cert.pem`. The first switch from an ad hoc build to a signed one is a manual DMG install.

## feat(review): review local changes with marks and guides

Reviews a thread's local changes from the diff panel.

- An **Unpushed** scope next to Changes and Uncommitted: commits ahead of the upstream, or of the base branch when there is none (`review.getDiffPreview` with `unpushed: true`).
- Per-file **Reviewed** and **Check later** marks, stored client-side per thread and scope (`t3code:review-marks:v1`). A reviewed file whose diff blobs change reads as **Changed**. Shown in file headers, the file tree and the panel header. In these scopes only reviewed files start collapsed, instead of following the "collapse files" setting; a manual fold lasts until the file's mark or review state changes.
- A **Review guide** view: a Markdown summary (with a mermaid diagram when it helps) and the changed files grouped in reading order, each expandable to its diff. It reuses the PR review guide writer and its coverage normalization on a snapshot of the local changes (a checkpoint commit in a temporary worktree), with its own prompt. Guides are kept under `review-guides/` in the state directory, keyed by workspace, scope and base ref (`review.getGuide`, `review.generateGuide`).
- Web and desktop only; mobile only widens a type.

## fix(ci): launch check keeps its fixture threads out of the Settled shelf

The release launch check seeds a fixture database whose threads date from 2026-10-27. Three days later the server's default auto-settle moved them into the collapsed Settled shelf, so the check never found the seeded thread and every desktop build failed to publish. The seeded T3 home now disables auto-settle in its `settings.json`. Upstream has the same time bomb.
