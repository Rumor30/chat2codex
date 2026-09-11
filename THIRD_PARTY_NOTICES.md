# Third-party notices

Chat2Codex reuses the browser transport, MCP server, TurnBroker, prompt compiler and Responses handlers of **miuuyy/codex-chatgpt-web**, pinned to commit `e85e3693fdb4e3e033348c08df0298c20fcdb612` (upstream package version 5.0.6).

Source: https://github.com/miuuyy/codex-chatgpt-web/tree/e85e3693fdb4e3e033348c08df0298c20fcdb612

The upstream project declares the MIT license. Bootstrap retains its complete LICENSE, LICENSES and notices in the local checkout. Its dependency licenses remain their respective owners' licenses. No upstream authorship is claimed for new Chat2Codex code.

The upstream DEV adapter factory is reused, but its simulated outer driver is not used to execute user tools. Electron, Bun, the MCP SDK, Playwright and the official OpenAI tunnel-client have separate upstream distributions and licenses; this repository does not redistribute their binaries.
