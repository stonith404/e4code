# Fork changes

E4 Code is a personal fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code). Each patch on top of upstream is listed here by commit subject.

## feat(desktop): rebrand fork as E4 Code

Lets E4 Code install next to T3 Code without sharing state.

- App ID `com.eliasschneider.e4code`, product name "E4 Code" (no "Beta" suffix; nightlies stay "E4 Code (Nightly)").
- Data in `~/.e4` and Electron profile `e4code` instead of `~/.t3` and `t3code-v2`.
- Linux executable, desktop entry and `.deb` package renamed to `e4code`; packaged WM class matches the E4 desktop identity; upstream’s unused runtime `--class` switch stays removed. Updatable AppImages use versionless `E4-Code` / `E4-Code-Nightly` names, retaining upstream’s old-path restoration after an update.
- Desktop updates, CLI archives, the install scripts (including remote setup commands and the CLI self-install fallback), release links and the GitHub star prompt point at `stonith404/e4code`.
- Windows installer running-app prompts recognize E4 Code and E4 Code (Nightly), retaining upstream's legacy-name detection.
- Managed policy uses E4-specific files, macOS preference domain, Windows registry key and generated policy templates, so T3 Code can be managed separately. Startup profiles go to `.e4/startup-profiles`.
- Web bootstrap and runtime titles use E4 branding and channel labels, retaining upstream’s thread/project window titles.
- Tests updated to the new names.
- `README.md` opens with a short fork section listing the user-facing patches, and `AGENTS.md` ends with the fork's rules for agents.
