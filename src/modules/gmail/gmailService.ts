import { getGmailApi } from "./gmailClient";
import { parseRawMime } from "../parser/mailExtractor";
import { DocumentTextExtractor } from "../parser/documentTextExtractor";
import { ParsedEmail } from "../../shared/types";
import { env } from "../../config/env";

function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf-8");
}

export class GmailService {
  constructor(private readonly attachmentExtractor = new DocumentTextExtractor()) {}

  async fetchUnreadRecruiterEmails(maxResults = 10): Promise<ParsedEmail[]> {
    const gmail = getGmailApi();
    const listRes = await gmail.users.messages.list({
      userId: env.GMAIL_USER_ID,
      q: "is:unread",
      maxResults
    });

    const messageIds = listRes.data.messages?.map((m) => m.id).filter(Boolean) as string[];
    const parsedEmails: ParsedEmail[] = [];

    for (const id of messageIds) {
      const message = await gmail.users.messages.get({
        userId: env.GMAIL_USER_ID,
        id,
        format: "raw"
      });

      const raw = message.data.raw ? decodeBase64Url(message.data.raw) : "";
      parsedEmails.push(
        await parseRawMime(id, message.data.threadId ?? "", raw, this.attachmentExtractor)
      );
    }

    return parsedEmails;
  }
}
