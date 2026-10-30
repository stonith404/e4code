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

`e4-release.yml` replaces upstream's `release.yml`, which only runs in pingdotgg/t3code. It reuses `release-desktop.yml` on GitHub-hosted runners without T3 Connect, npm, AUR, web, mobile or Discord publishing. Nightlies run hourly when main has changed (at least 6 hours apart). Stable releases come from a `vX.Y.Z` tag or a manual dispatch. Upstream's other workflows are disabled in the repository settings.

Upstream syncs rebase these patches onto upstream's main, so `check-nightly-release.cjs` also releases a main that diverged from the last nightly, instead of skipping it.

## ci(desktop): sign macOS builds with a self-signed identity

Lets the in-app updater install new builds on Macs that trust the fork's certificate. Squirrel.Mac only swaps in an update whose signature matches the running app, which ad hoc builds never do.

- `.github/actions/import-mac-signing-identity` imports `CSC_LINK` into a keychain, trusts it as a root when it is self-signed (otherwise macOS lists no valid identity) and returns the identity name. The CLI archive and desktop jobs both use it.
- When `CSC_LINK` is set but the Apple notarization secrets are not, the desktop job passes the identity as `T3CODE_DESKTOP_MAC_SIGN_IDENTITY`. `build-desktop-artifact.ts` then sets `mac.identity` with hardened runtime and notarization off, instead of upstream's `--signed` path that needs a provisioning profile.
- Gatekeeper still shows the unverified-developer dialog on first launch, since only notarized Developer ID builds skip it.
- Each Mac that should receive in-app updates trusts the certificate once: `security add-trusted-cert -r trustRoot -p codeSign -k ~/Library/Keychains/login.keychain-db e4code-signing.cert.pem`. The first switch from an ad hoc build to a signed one is a manual DMG install.

## feat(review): review local changes with marks and guides

A **Review** surface in the right panel (`+` menu, `R`, or the thread details **Review** item) for a thread's local changes, laid out like GitKraken: changed files in a sidebar, one whole file at a time beside it. The diff panel is upstream's. Opening Review maximizes the panel when it was last left maximized on the Review tab (`t3code.reviewMaximized`). The surface opens with the file sidebar focused, where `↑`/`↓` step through files, `R` toggles Reviewed and `M` toggles Check later.

- Scopes **Changes**, **Uncommitted** and **Unpushed**: commits ahead of the upstream, or of the base branch when there is none (`review.getDiffPreview` with `unpushed: true`). The base branch is always the automatic one. The chosen scope is remembered per thread, and until one is chosen it follows the diff panel (Uncommitted, otherwise Changes).
- The sidebar shows the files as a list (change-type icon, start-truncated path) or a tree; in both, reviewed files are dimmed, flagged files highlighted, and only the selected file shows its mark icon (the tree through `:has()` on its decoration icons in `pierre-tree-theme.ts`). It resizes like the file explorer (`t3code.reviewSidebarWidth`). The selected file renders with Pierre's `expandUnchanged`, loading full contents through `loadDiffFiles` into a copy of the shared parsed diff, and scrolls to its first change once loaded. A strip beside it marks where the file changed (`reviewOverview.ts`), and clicking it scrolls there. Line comments go to the composer as in the diff panel. Large diffs load per file through `useReviewFilePatches`.
- Per-file **Reviewed** and **Check later** marks, stored client-side per thread and scope (`t3code:review-marks:v1`). A reviewed file whose diff blobs change reads as **Changed**. Shown in the file header, the sidebar and the panel header.
- The sidebar's **Review guide** view: a Markdown summary (with a mermaid diagram when it helps) and the changed files grouped in reading order, which the previous/next buttons then follow. It reuses the PR review guide writer and its coverage normalization on a snapshot of the local changes (a checkpoint commit in a temporary worktree), with its own prompt. Generation failures keep a short model-settings hint and expandable diagnostics, so retry stays reachable. Guides are kept under `review-guides/` in the state directory, keyed by workspace, scope and base ref (`review.getGuide`, `review.generateGuide`).
- The thread details **Changes** row follows the diff panel's selected scope: Uncommitted uses the working-tree totals and a turn its checkpoint totals, both already on the client. A commit, a tool call or a custom base ref fall back to the branch Changes totals, since only a full diff could count them. The fallback keeps upstream's dirty-working-tree totals when branch totals are empty. Deleting a thread clears its saved review scope along with upstream's panel state.
- Web and desktop only; mobile only widens a type.

## feat(settings): manage MCP servers for Claude and Codex

Settings → MCP servers adds, edits, toggles and removes MCP servers per environment, and picks which Claude and Codex instances get each one.

- `mcpServers` in server settings (`packages/contracts/src/mcpServer.ts`): stdio or Streamable HTTP. Env, header, client secret and session values go to the secret store. Patches need the providers-manage scope, since a stdio server is a host command.
- The Claude and Codex adapters add the servers beside `t3-code` when a session starts. Claude's T3 instructions now key on the `t3-code` entry, not on any MCP server being present.
- OAuth: `McpServers` discovers metadata (RFC 9728/8414), runs PKCE through `/oauth/mcp-servers/callback`, keeps the session in `oauthSession` and refreshes it. Without a client ID it signs in as the client ID metadata document committed at `oauth/mcp-client.json` and served from jsDelivr when the server accepts one and the redirect is loopback, and otherwise registers a client per sign-in (RFC 7591). Providers reach OAuth servers through `/mcp-servers/<name>` with their T3 session credential, and the proxy adds the access token.
- Web only; the mobile app has no MCP server screen.
