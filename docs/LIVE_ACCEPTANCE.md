# Live acceptance

`npm run acceptance:live` is the production-path acceptance harness for one authorized ChatGPT account. It uses an isolated Electron profile, validates the imported or existing ChatGPT session, runs the account's real MCP nonce probe, then starts real Codex against the local Responses gateway and requires Codex to make an exact disk mutation in an isolated acceptance workspace.

The harness does **not** accept a session token as a command-line argument. This keeps the credential out of shell history, process listings, CI metadata, and crash command lines.

## Before running

Install the normal project prerequisites, update the source, and rebuild the account runtime because session import requires bridge v4:

```sh
git pull --ff-only
npm run bootstrap
```

Create/configure the account and its Tunnel first. The selected account must use its own isolated Chat2Codex profile. The acceptance harness will open that profile if it is not already running.

## Import a session key by hidden stdin

```sh
npm run acceptance:live -- --account ACCOUNT_ID --model chatgpt-web/high
```

When prompted, paste the ChatGPT session key and press Enter. Terminal input is hidden. The key is sent only over the launcher's authenticated loopback control channel and is written to that account's Electron Cookie Store. Chat2Codex immediately calls `https://chatgpt.com/api/auth/session` from the same profile to confirm authentication.

The importer accepts a raw session key. It also accepts a locally pasted `/api/auth/session` JSON object that contains a `sessionToken`; `accessToken` alone is intentionally not accepted.

## Import from a private file

On macOS/Linux:

```sh
chmod 600 /path/to/session.txt
npm run acceptance:live -- --account ACCOUNT_ID --model chatgpt-web/high --session-file /path/to/session.txt
```

On Windows the normal per-user ACL is used. The file may contain the raw session key, an auth-session JSON object with `sessionToken`, or a Cookie header containing the supported ChatGPT session-token cookie. Chunked NextAuth/Auth.js session cookies are reconstructed locally.

Do not commit the file. Do not put the token in `.env`, argv, an issue, a PR, or a chat transcript.

## Existing logged-in profile

If the account's isolated Electron profile is already authenticated:

```sh
npm run acceptance:live -- --account ACCOUNT_ID --model chatgpt-web/high --use-existing-session
```

If an authenticated profile already exists and you intentionally need to replace its session, add `--replace-session`. Replacement is refused while that launcher has active/retained tool tabs. If a new key does not authenticate, the importer restores the prior session cookies it found before the attempt.

## What counts as a pass

A passing run proves all of the following for the selected account/model on that machine:

1. the isolated Electron profile is authenticated;
2. the configured Tunnel and Connector can complete the real nonce MCP round-trip;
3. the exact model enters the verified Ready set;
4. real Codex starts against the Chat2Codex Responses provider;
5. the web model requests Codex tools through the MCP/TurnBroker loop;
6. Codex changes only the isolated `acceptance.txt` file to the expected random marker;
7. Chat2Codex reads the file from disk and verifies the exact expected bytes;
8. acceptance thread state is retired afterwards.

A sanitized report is written under `CHAT2CODEX_HOME/acceptance/`. It contains stage names, timestamps, model/account IDs, and failure codes/messages; it does not contain the session key, Cookie values, access token, Tunnel runtime key, or gateway key.

Use `--keep-workspace` when debugging a failure. Successful runs remove the temporary acceptance workspace by default.
