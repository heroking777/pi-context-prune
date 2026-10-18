export function rejectOAuthRefresh(value, budget, onBlocked) {
  let url;
  try { url = new URL(String(value)); } catch { return; }
  if (url.protocol !== "https:" || url.hostname !== "auth.openai.com" || url.pathname !== "/oauth/token") return;
  const error = new Error("OAuth refresh prohibited; stop benchmark");
  budget.blockConnection(value, "oauth-refresh-blocked-before-network");
  onBlocked(error, value);
  throw error;
}
