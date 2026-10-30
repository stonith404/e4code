# MCP servers

Give Claude and Codex the tools of other MCP servers from **Settings → MCP servers**. Each server is saved on the environment, so it works the same from web, desktop, and any client connected to it. Other providers don't get these servers yet; configure them in the provider's own settings.

Choose **Add server**, name it, and tick the Claude and Codex providers that should get it. A server is either a command the environment runs (stdio) or a Streamable HTTP URL. Environment variable and header values are kept in the environment's secret store and never shown again. Sessions pick up a new or changed server when they start, so start a new thread or restart one to use it. The switch on each row turns a server off without deleting it.

## Signing in with OAuth

For a server that needs a sign-in, set **Authentication** to **OAuth**. Leave the client ID empty and E4 Code sets itself up with the server's authorization server when you sign in, from this machine or another device. Only for a server that allows neither client ID metadata documents nor dynamic client registration, enter a client ID (and secret, if it has one) registered with it, and register the redirect URI the dialog shows.

After saving, choose **Sign in** and finish in the browser tab that opens. The environment keeps the tokens and refreshes them, and agents reach the server through the environment, so the tokens never reach Claude or Codex. Changing the server's URL, client, or scopes signs it out. **Sign out** forgets the tokens.
