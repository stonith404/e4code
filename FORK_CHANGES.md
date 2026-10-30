# Fork changes

E4 Code is a personal fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code). Each patch on top of upstream is listed here by commit subject.

## feat(desktop): rebrand fork as E4 Code

Lets E4 Code install next to T3 Code without sharing state.

- App ID `com.eliasschneider.e4code`, product name "E4 Code" (no "Beta" suffix; nightlies stay "E4 Code (Nightly)").
- Data in `~/.e4` and Electron profile `e4code` instead of `~/.t3` and `t3code-v2`.
- Linux executable, WM class, desktop entry and `.deb` package renamed to `e4code`.
- Desktop updates, CLI archives and release links point at `stonith404/E4-code`.
- Tests updated to the new names.

## ci: add E4 release workflow

`e4-release.yml` replaces upstream's `release.yml`, which only runs in pingdotgg/t3code. It reuses `release-desktop.yml` on GitHub-hosted runners, unsigned, without T3 Connect, npm, AUR, web, mobile or Discord publishing. Nightlies run hourly when main has changed (at least 6 hours apart). Stable releases come from a `vX.Y.Z` tag or a manual dispatch. Upstream's other workflows are disabled in the repository settings.
