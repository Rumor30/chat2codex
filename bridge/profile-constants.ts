/** Narrow overlay for the pinned upstream DEV constants; all other runtime code stays upstream. */
export const DEV_CONFIG_PURPOSE = "dev-harness" as const;
export const DEV_LAUNCHER_PROFILE = "development" as const;
const accountId = process.env.CHAT2CODEX_ACCOUNT_ID;
if (accountId !== undefined && !/^acct_[a-f0-9]{32}$/.test(accountId)) {
  throw new Error("Invalid Chat2Codex account identity for Tunnel isolation");
}
// Tunnel runtime aliases are global to the OS user, unlike browser profile directories.
export const DEV_TUNNEL_BASE_NAME = accountId
  ? `chat2codex-${accountId}`
  : "codex-chatgpt-web-dev";
