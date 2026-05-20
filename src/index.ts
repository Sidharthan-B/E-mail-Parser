import express from "express";
import multer, { MulterError } from "multer";
import { env } from "./config/env";
import { runExtractionPipeline } from "./modules/parser/pipeline";
import { normalizeText } from "./modules/normalization/normalizer";
import { segmentSections } from "./modules/segmentation/sectionSegmenter";
import { listInboxFiles, processLocalInbox } from "./modules/localFolder/processInbox";
import { bufferToParsedEmail } from "./modules/localFolder/fileToParsedEmail";
import { processTypedInbox } from "./modules/localFolder/processTypedInbox";
import { extractCompany } from "./modules/semantic/geminiCompanyExtractor";
import { extractRecruiterProfile } from "./modules/semantic/geminiRecruiterExtractor";
import { extractApproval } from "./modules/semantic/geminiApprovalExtractor";
import { DocumentTextExtractor } from "./modules/parser/documentTextExtractor";

const app = express();
app.use(express.json({ limit: "2mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "aarambh-parser", mode: env.NODE_ENV });
});

app.post("/api/pipeline/parse-text", async (req, res) => {
  const text = String(req.body?.text ?? "");
  const type = String(req.body?.type ?? "job");

  if (!text.trim()) {
    res.status(400).json({ error: "text is required" });
    return;
  }

  try {
    if (type === "company") {
      res.json(await extractCompany(text));
      return;
    }
    if (type === "approval") {
      res.json(await extractApproval(text));
      return;
    }
    if (type === "recruiter") {
      res.json(await extractRecruiterProfile(text));
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
    res.json(result[0] ?? null);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
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

    const extraText = String(req.body?.extra_text ?? "").trim();
    if (extraText) {
      parsed.text = parsed.text + "\n\n" + extraText;
      parsed.cleanedText = parsed.cleanedText + "\n\n" + extraText;
    }

    const type = String(req.body?.type ?? "job");

    try {
      if (type === "company") {
        res.json(await extractCompany(parsed.text));
        return;
      }
      if (type === "approval") {
        res.json(await extractApproval(parsed.text));
        return;
      }
      if (type === "recruiter") {
        res.json(await extractRecruiterProfile(parsed.text));
        return;
      }

      const result = await runExtractionPipeline(parsed);
      res.json(result[0] ?? null);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
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

app.post("/api/local/process-companies", async (_req, res) => {
  try {
    const result = await processTypedInbox(env.COMPANY_INBOX_DIR, env.COMPANY_OUTPUT_DIR, extractCompany);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/local/process-recruiters", async (_req, res) => {
  try {
    const result = await processTypedInbox(env.RECRUITER_INBOX_DIR, env.RECRUITER_OUTPUT_DIR, extractRecruiterProfile);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/local/process-approvals", async (_req, res) => {
  try {
    const result = await processTypedInbox(env.APPROVAL_INBOX_DIR, env.APPROVAL_OUTPUT_DIR, extractApproval);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Aarambh parser listening on http://localhost:${env.PORT}`);
});
