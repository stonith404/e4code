# Fork changes

E4 Code is a personal fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code). Each patch on top of upstream is listed here by commit subject.

## feat(desktop): rebrand fork as E4 Code

Lets E4 Code install next to T3 Code without sharing state.

- App ID `com.eliasschneider.e4code`, product name "E4 Code" (no "Beta" suffix; nightlies stay "E4 Code (Nightly)").
- Data in `~/.e4` and Electron profile `e4code` instead of `~/.t3` and `t3code-v2`.
- Linux executable, WM class, desktop entry and `.deb` package renamed to `e4code`.
- Desktop updates, CLI archives, release links and the GitHub star prompt point at `stonith404/e4code`.
- Tests updated to the new names.
- `README.md` opens with a short fork section listing the user-facing patches, and `AGENTS.md` ends with the fork's rules for agents.
