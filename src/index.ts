import express from "express";
import multer, { MulterError } from "multer";
import { env } from "./config/env";
import { GmailService } from "./modules/gmail/gmailService";
import { getOAuthClient } from "./modules/gmail/gmailClient";
import { runExtractionPipeline } from "./modules/parser/pipeline";
import { normalizeText } from "./modules/normalization/normalizer";
import { segmentSections } from "./modules/segmentation/sectionSegmenter";
import { listInboxFiles, processLocalInbox } from "./modules/localFolder/processInbox";
import { bufferToParsedEmail } from "./modules/localFolder/fileToParsedEmail";
import { DocumentTextExtractor } from "./modules/parser/documentTextExtractor";

const app = express();
app.use(express.json({ limit: "2mb" }));

const gmailService = new GmailService();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "aarambh-parser", mode: env.NODE_ENV });
});

app.get("/api/gmail/oauth2/url", (_req, res) => {
  const oauth2Client = getOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/gmail.readonly"]
  });
  res.json({ url });
});

app.get("/api/gmail/oauth2/callback", async (req, res) => {
  const code = String(req.query.code ?? "");
  if (!code) {
    res.status(400).json({ error: "Missing code query parameter" });
    return;
  }

  const oauth2Client = getOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);
  res.json({
    message: "Persist this refresh token into .env as GMAIL_REFRESH_TOKEN",
    refresh_token: tokens.refresh_token ?? null
  });
});

app.post("/api/pipeline/fetch-unread", async (req, res) => {
  const maxResults = Number(req.body?.maxResults ?? 5);
  const emails = await gmailService.fetchUnreadRecruiterEmails(maxResults);
  const extracted = await Promise.all(emails.map((email) => runExtractionPipeline(email)));
  res.json({ count: extracted.length, data: extracted });
});

app.post("/api/pipeline/parse-text", async (req, res) => {
  const text = String(req.body?.text ?? "");
  if (!text.trim()) {
    res.status(400).json({ error: "text is required" });
    return;
  }

  const result = await runExtractionPipeline({
    messageId: "manual",
    threadId: "manual",
    subject: "manual-input",
    sender: String(req.body?.source_email ?? "manual@local"),
    recipients: [],
    html: "",
    text,
    cleanedText: text,
    attachments: []
  });
  res.json(result);
});

app.post(
  "/api/pipeline/parse-upload",
  (req, res, next) => {
    upload.single("file")(req, res, (err: unknown) => {
      if (err) {
        if (err instanceof MulterError) {
          const message =
            err.code === "LIMIT_FILE_SIZE" ? "file too large (max 25MB)" : err.message;
          res.status(400).json({ error: message });
          return;
        }
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        return;
      }
      next();
    });
  },
  async (req, res) => {
    const file = req.file;
    if (!file?.buffer?.length) {
      res.status(400).json({
        error: 'Expected multipart field "file" (PDF, DOCX, DOC, PPTX, TXT, or EML)'
      });
      return;
    }

    const extractor = new DocumentTextExtractor();
    const parsed = await bufferToParsedEmail(file.originalname, file.buffer, extractor);
    if (!parsed) {
      res.status(415).json({
        error: "Unsupported file type",
        supported: [".eml", ".mime", ".pdf", ".docx", ".doc", ".pptx", ".txt", ".text", ".md"]
      });
      return;
    }

    const result = await runExtractionPipeline(parsed);
    res.json(result);
  }
);

app.post("/api/pipeline/sections", (req, res) => {
  const text = String(req.body?.text ?? "");
  if (!text.trim()) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  const cleaned = normalizeText(text);
  res.json(segmentSections(cleaned));
});

app.get("/api/local/inbox", async (_req, res) => {
  try {
    const { inboxDir, files } = await listInboxFiles();
    res.json({
      inboxDir,
      files,
      supportedExtensions: [".txt", ".text", ".md", ".pdf", ".docx", ".doc", ".pptx", ".eml", ".mime"],
      process: "POST /api/local/process-inbox",
      body: { moveToProcessed: "optional boolean — move parsed files to UPLOAD_PROCESSED_DIR" }
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/local/process-inbox", async (req, res) => {
  const moveToProcessed = Boolean(req.body?.moveToProcessed);
  try {
    const result = await processLocalInbox({ moveToProcessed });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Aarambh parser listening on http://localhost:${env.PORT}`);
});
