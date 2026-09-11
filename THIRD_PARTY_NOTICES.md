# Third-party notices

Chat2Codex reuses the browser transport, MCP server, TurnBroker, prompt compiler and Responses handlers of **miuuyy/codex-chatgpt-web**, pinned to commit `e85e3693fdb4e3e033348c08df0298c20fcdb612` (upstream package version 5.0.6).

Source: https://github.com/miuuyy/codex-chatgpt-web/tree/e85e3693fdb4e3e033348c08df0298c20fcdb612

The upstream project declares the MIT license. Bootstrap retains its complete LICENSE, LICENSES and notices in the local checkout. Its dependency licenses remain their respective owners' licenses. No upstream authorship is claimed for new Chat2Codex code.

The upstream DEV adapter factory is reused, but its simulated outer driver is not used to execute user tools. Electron, Bun, the MCP SDK, Playwright and the official OpenAI tunnel-client have separate upstream distributions and licenses; this repository does not redistribute their binaries.

`bridge/profile-constants.ts` is a narrowly scoped replacement of the pinned upstream DEV constants. It gives each Chat2Codex account a distinct Tunnel runtime alias; bootstrap verifies the original Git blob before applying it and refuses unrelated source changes.

The optional native model catalog template is downloaded from **openai/codex**, tag `rust-v0.154.0`, path `codex-rs/models-manager/models.json` (Git blob `c9b4d6ce6e85acc87c236e83421e3b4520e1a5a0`). The public repository uses Apache-2.0. Bootstrap verifies and retains its LICENSE beside the downloaded template (license Git blob `4606e72e042564097e8780d66c1d4dcb611869bd`). Chat2Codex generates account-verified browser model entries from that template without claiming those browser routes are an official API. The downloaded public template and native binaries are not embedded in this source archive.
