# MCP servers

Give Claude and Codex the tools of other MCP servers from **Settings → MCP servers**. Each server is saved on the environment, so it works the same from web, desktop, and any client connected to it. Other providers don't get these servers yet; configure them in the provider's own settings.

Choose **Add server**, name it, and tick the Claude and Codex providers that should get it. A server is either a command the environment runs (stdio) or a Streamable HTTP URL. Environment variable and header values are kept in the environment's secret store and never shown again. Sessions pick up a new or changed server when they start, so start a new thread or restart one to use it. The switch on each row turns a server off without deleting it.

## Signing in with OAuth

For a server that needs a sign-in, set **Authentication** to **OAuth**. Without a client ID, E4 Code identifies itself with its own client ID metadata document. That works with servers that accept one, as long as you sign in from the machine running the environment at a localhost address. For other servers, or to sign in from another device, enter a client ID (and secret, if it has one) registered with the server's authorization server, and register the redirect URI the dialog shows. Dynamic client registration isn't supported.

After saving, choose **Sign in** and finish in the browser tab that opens. The environment keeps the tokens and refreshes them, and agents reach the server through the environment, so the tokens never reach Claude or Codex. Changing the server's URL, client, or scopes signs it out. **Sign out** forgets the tokens.
