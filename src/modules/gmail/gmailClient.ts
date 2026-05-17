import { google } from "googleapis";
import { env } from "../../config/env";

export function getOAuthClient() {
  const client = new google.auth.OAuth2(
    env.GMAIL_CLIENT_ID,
    env.GMAIL_CLIENT_SECRET,
    env.GMAIL_REDIRECT_URI
  );

  if (env.GMAIL_REFRESH_TOKEN) {
    client.setCredentials({ refresh_token: env.GMAIL_REFRESH_TOKEN });
  }
  return client;
}

export function getGmailApi() {
  return google.gmail({ version: "v1", auth: getOAuthClient() });
}
