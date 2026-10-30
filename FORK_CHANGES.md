# Fork changes

E4 Code is a personal fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code). Each patch on top of upstream is listed here by commit subject.

## feat(desktop): rebrand fork as E4 Code

Lets E4 Code install next to T3 Code without sharing state.

- App ID `com.eliasschneider.e4code`, product name "E4 Code" (no "Beta" suffix; nightlies stay "E4 Code (Nightly)").
- Data in `~/.e4` and Electron profile `e4code` instead of `~/.t3` and `t3code-v2`.
- Linux executable, packaged WM class, desktop entry and `.deb` package renamed to `e4code`; upstream’s unused runtime `--class` switch stays removed.
- Desktop updates, CLI archives, the install scripts, release links and the GitHub star prompt point at `stonith404/e4code`.
- Windows installer running-app prompts recognize E4 Code and E4 Code (Nightly), retaining upstream's legacy-name detection.
- Managed policy uses E4-specific files, macOS preference domain and Windows registry key, so T3 Code can be managed separately. Startup profiles go to `.e4/startup-profiles`.
- Tests updated to the new names.
- `README.md` opens with a short fork section listing the user-facing patches, and `AGENTS.md` ends with the fork's rules for agents.

## feat(branding): E4 wordmark in app icons and logos

Keeps upstream's three icon designs (black production, night-sky nightly, blueprint dev) and swaps the T3 wordmark for a geometric E4.

- `text.svg` in the dev, nightly and prod Icon Composer projects carries the E4 mark; the dev `annotations.svg` dimension lines follow the new glyphs.
- iOS, universal, Windows, web favicon and Android assets regenerated with `icons:export` and `icons:export:android`. The macOS pre-Tahoe PNGs are composed from the universal export (824 body inset 100, soft shadow) because the export only works in the Icon Composer GUI.
- Android monochrome and notification marks redrawn by hand at the same bounds as upstream's T3 silhouettes.
- `T3Wordmark` in web and mobile, the mobile widget mark, `assets/prod/logo.svg`, the DMG backgrounds and the mobile showcase favicon use the E4 path. Component and file names stay as upstream's to keep syncs small.

## ci: add E4 release workflow

`e4-release.yml` replaces upstream's `release.yml`, which only runs in pingdotgg/t3code. It reuses `release-desktop.yml` on GitHub-hosted runners, unsigned, without T3 Connect, npm, AUR, web, mobile or Discord publishing. Nightlies run hourly when main has changed (at least 6 hours apart). Stable releases come from a `vX.Y.Z` tag or a manual dispatch. Upstream's other workflows are disabled in the repository settings.

Upstream syncs rebase these patches onto upstream's main, so `check-nightly-release.cjs` also releases a main that diverged from the last nightly, instead of skipping it.
