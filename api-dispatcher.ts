import type { NextRequest } from 'next/server';
import { inflateSync } from 'node:zlib';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { appEnv } from '../../config/env';
import { requireAuth } from '../../modules/auth/auth-guards';
import { createPlacementDomainServices } from '../../modules/domain-services';
import type { PlacementDomainServices } from '../../modules/domain-services';
import { getSupabaseServerClient, getStorageClient } from '../../interface-adapters/db/supabase-server-client';
import { createSupabasePlacementRepository } from '../../interface-adapters/repositories/supabase-placement-repository';
import { AppError } from '../../use-cases/errors';
import {
  assertJsonObject,
  validateInterviewPayload,
  validateOfferPayload,
  validatePaginationQuery,
  validateRecruiterJobPayload,
  validateRecruiterJobUpdatePayload,
  validateReferralPayload,
  validateSupportIssuePayload,
} from '../../shared/validation/validators';
import { logger } from '../../shared/logger/logger';
import { attachAuthContext } from '../../shared/http/request-context';
import { verifyCaptcha, getCaptchaToken, getClientIp } from '../../shared/http/captcha';

type StoredStudentCertificate = {
  id: string;
  title: string;
  issuer: string;
  issueDate: string;
  expiryDate: string | null;
  credentialId: string;
  skills: string[];
  status: 'pending' | 'verified';
  points: number;
  fileName: string;
  fileSize: number;
  mimeType: string;
  storagePath: string;
  uploadedAt: string;
  updatedAt: string;
  verifiedAt: string | null;
};

type StudentCertificateResponse = StoredStudentCertificate & {
  viewUrl: string | null;
  downloadUrl: string | null;
};

const parseJsonBody = async (request: NextRequest): Promise<Record<string, unknown>> => {
  try {
    return assertJsonObject(await request.json());
  } catch {
    return {};
  }
};

const getBackendContext = () => {
  const supabase = getSupabaseServerClient();
  const repository = createSupabasePlacementRepository(supabase);
  const services = createPlacementDomainServices(repository);
  return { services };
};

const CERTIFICATES_BUCKET = 'certificates';
const HIGHLIGHTS_BUCKET = 'highlights';
const PLACEMENT_REPORTS_BUCKET = 'plreports';

const AVATAR_ALIAS_BASE_URL = String(process.env.NEXT_PUBLIC_AVATAR_ALIAS_BASE_URL ?? '').trim().replace(/\/+$/g, '');
const AVATAR_ALIAS_SECRET = String(process.env.AVATAR_ALIAS_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();

const ensureSupabaseServiceRoleConfigured = (): void => {
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
  if (!serviceRoleKey) {
    throw new AppError(
      'Server misconfiguration: SUPABASE_SERVICE_ROLE_KEY is required for certificate uploads. Add it to placement-frontend/.env.local and restart the server.',
      500,
    );
  }
};

const ensureStudentProfile = async (
  auth: Awaited<ReturnType<typeof requireAuth>>,
  services: PlacementDomainServices,
) => {
  try {
    return await services.profiles.getMyStudentProfile(auth);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) {
      await services.profiles.upsertStudentProfile(auth, {});
      return services.profiles.getMyStudentProfile(auth);
    }
    throw error;
  }
};

const sanitizeFileName = (rawName: string): string => {
  const normalized = rawName.trim().replace(/\s+/g, '_');
  return normalized.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 120) || `certificate-${Date.now()}.bin`;
};

const normalizeStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry.length > 0);
  }

  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  return [];
};

const normalizeCredentialToken = (value: string): string => value.toUpperCase().replace(/[^A-Z0-9]/g, '');

const sanitizeExtension = (fileName: string): string => {
  const ext = fileName.includes('.') ? fileName.split('.').pop() ?? '' : '';
  const clean = ext.toLowerCase().replace(/[^a-z0-9]/g, '');
  return clean || 'bin';
};

const slugifyName = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'student';

const encodeBase64Url = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');

const decodeBase64Url = (value: string): string => Buffer.from(value, 'base64url').toString('utf8');

const parseAvatarAliasToken = (token: string): string | null => {
  if (!AVATAR_ALIAS_SECRET) return null;

  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) return null;

  const expectedSignature = createHmac('sha256', AVATAR_ALIAS_SECRET).update(encodedPayload).digest('base64url');
  const provided = Buffer.from(signature, 'utf8');
  const expected = Buffer.from(expectedSignature, 'utf8');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }

  try {
    const payload = JSON.parse(decodeBase64Url(encodedPayload)) as Record<string, unknown>;
    const studentId = typeof payload.sid === 'string' ? payload.sid.trim() : '';
    return studentId || null;
  } catch {
    return null;
  }
};

const buildSimpleAvatarAliasUrl = (studentName: string): string => {
  const alias = `aarambh.${slugifyName(studentName)}`;
  const path = `/api/avatar/${encodeURIComponent(alias)}`;
  return AVATAR_ALIAS_BASE_URL ? `${AVATAR_ALIAS_BASE_URL}${path}` : path;
};

const buildSimpleResumePhotoAliasUrl = (studentName: string): string => {
  const alias = `aarambh.${slugifyName(studentName)}`;
  const path = `/api/resume-photo/${encodeURIComponent(alias)}`;
  return AVATAR_ALIAS_BASE_URL ? `${AVATAR_ALIAS_BASE_URL}${path}` : path;
};

const resolveStudentIdFromSimpleAlias = async (
  alias: string,
  supabase: ReturnType<typeof getSupabaseServerClient>,
): Promise<string | null> => {
  const normalized = alias.trim().toLowerCase();
  if (!normalized.startsWith('aarambh.')) {
    return null;
  }

  const namePart = normalized.slice('aarambh.'.length).replace(/[_-]+/g, ' ').trim();
  if (!namePart) {
    return null;
  }

  const { data: userRows, error: userError } = await supabase
    .from('profiles')
    .select('id, name, role')
    .eq('role', 'student')
    .ilike('name', namePart)
    .limit(1);

  if (userError || !Array.isArray(userRows) || userRows.length === 0) {
    return null;
  }

  const userId = typeof userRows[0]?.id === 'string' ? userRows[0].id.trim() : '';
  if (!userId) {
    return null;
  }

  const { data: studentRow, error: studentError } = await supabase
    .from('students')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle();

  if (studentError || !studentRow) {
    return null;
  }

  return typeof studentRow.id === 'string' ? studentRow.id.trim() : null;
};

const extractErrorMessage = (error: unknown): string => {
  if (!error) return 'Unknown parse error';
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message ?? 'Unknown parse error');
  }
  return String(error);
};

type PlacementReportCompanyEntry = {
  company_name: string;
  job_count: number;
  offer_count: number;
  avg_ctc: number | null;
  top_ctc: number | null;
};

type PlacementReportRow = {
  id: string;
  college_id: string;
  year: number;
  placement_rate: number;
  company_count: number;
  offer_count: number;
  avg_ctc: number | null;
  top_ctc: number | null;
  companies: PlacementReportCompanyEntry[];
};

const reportNumberFormat = new Intl.NumberFormat('en-IN');

const formatPlacementPercent = (value: number) => `${Math.max(0, Number(value ?? 0)).toFixed(0)}%`;

const formatPlacementCtc = (value: number | null) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  return `Rs ${value.toFixed(2)} LPA`;
};

const formatPlacementCount = (value: number) => reportNumberFormat.format(Number(value ?? 0));

const buildPlacementReportStoragePath = (report: PlacementReportRow): string => {
  const safeCollegeId = String(report.college_id ?? '').trim() || 'unknown-college';
  const safeYear = String(report.year ?? 'unknown-year');
  const safeReportId = String(report.id ?? '').trim() || `report-${Date.now()}`;
  return `${safeCollegeId}/${safeYear}/placement-report-${safeReportId}.pdf`;
};

const storePlacementReportPdf = async (report: PlacementReportRow, pdfBuffer: Buffer): Promise<void> => {
  ensureSupabaseServiceRoleConfigured();
  const supabase = getSupabaseServerClient();
  const storagePath = buildPlacementReportStoragePath(report);
  const { error } = await supabase.storage.from(PLACEMENT_REPORTS_BUCKET).upload(storagePath, pdfBuffer, {
    contentType: 'application/pdf',
    upsert: true,
  });

  if (error) {
    throw new AppError(`Failed to store placement report PDF: ${error.message}`, 500, error);
  }
};

const createPlacementReportPdf = async (report: PlacementReportRow): Promise<Buffer> => {
  const pdfkitModule = await import('pdfkit/js/pdfkit.standalone');
  const PDFDocument = (pdfkitModule as { default?: new (options?: Record<string, unknown>) => any }).default
    ?? (pdfkitModule as unknown as new (options?: Record<string, unknown>) => any);
  const doc = new PDFDocument({ size: 'A4', margin: 40 });

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));

  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const margin = 40;
  const pageWidth = doc.page.width;
  const usableWidth = pageWidth - margin * 2;

  const drawRule = (y: number) => {
    doc.moveTo(margin, y).lineTo(pageWidth - margin, y).strokeColor('#E5E7EB').lineWidth(1).stroke();
  };

  doc.fillColor('#111827').fontSize(20).text('Yearly Placement Report', margin, margin);
  doc.fontSize(12).fillColor('#374151').text(`Year: ${report.year}`);
  doc.moveDown(0.5);
  doc.fontSize(10).fillColor('#6B7280').text('Generated by Placement Admin Reports', { width: usableWidth });

  doc.moveDown(1.2);
  const summaryY = doc.y;
  drawRule(summaryY - 6);

  const summaryCols = [
    { label: 'Year', value: String(report.year), x: margin, width: 60 },
    { label: 'Placement Rate', value: formatPlacementPercent(report.placement_rate), x: margin + 70, width: 90 },
    { label: 'Company Count', value: formatPlacementCount(report.company_count), x: margin + 170, width: 90 },
    { label: 'Offer Count', value: formatPlacementCount(report.offer_count), x: margin + 270, width: 80 },
    { label: 'Avg CTC', value: formatPlacementCtc(report.avg_ctc), x: margin + 360, width: 90 },
    { label: 'Top CTC', value: formatPlacementCtc(report.top_ctc), x: margin + 460, width: 80 },
  ];

  doc.fontSize(9).fillColor('#6B7280');
  summaryCols.forEach((col) => {
    doc.text(col.label, col.x, summaryY, { width: col.width, align: 'left' });
  });

  const summaryValueY = summaryY + 14;
  doc.fontSize(11).fillColor('#111827');
  summaryCols.forEach((col) => {
    doc.text(col.value, col.x, summaryValueY, { width: col.width, align: 'left' });
  });

  const afterSummaryY = summaryValueY + 22;
  drawRule(afterSummaryY - 6);
  doc.moveDown(1.4);

  doc.fontSize(13).fillColor('#111827').text('Company Breakdown', margin, doc.y);
  doc.fontSize(10).fillColor('#6B7280').text('Sorted by offers, then top CTC, then average CTC.');
  doc.moveDown(0.6);

  const nameWidth = 210;
  const headerY = doc.y;
  const tableCols = [
    { label: 'Company', x: margin, width: nameWidth },
    { label: 'Jobs', x: margin + nameWidth + 10, width: 40 },
    { label: 'Offers', x: margin + nameWidth + 60, width: 50 },
    { label: 'Avg CTC', x: margin + nameWidth + 120, width: 80 },
    { label: 'Top CTC', x: margin + nameWidth + 210, width: 80 },
  ];

  doc.fontSize(9).fillColor('#6B7280');
  tableCols.forEach((col) => {
    doc.text(col.label, col.x, headerY, { width: col.width, align: 'left' });
  });
  drawRule(headerY + 14);

  let cursorY = headerY + 20;
  const rowPadding = 6;

  const drawTableHeader = () => {
    doc.fontSize(9).fillColor('#6B7280');
    tableCols.forEach((col) => {
      doc.text(col.label, col.x, margin, { width: col.width, align: 'left' });
    });
    drawRule(margin + 14);
    cursorY = margin + 20;
  };

  for (const company of report.companies ?? []) {
    const nameText = company.company_name || 'Unknown Company';
    doc.fontSize(10).fillColor('#111827');

    const nameHeight = doc.heightOfString(nameText, { width: nameWidth });
    const rowHeight = Math.max(16, nameHeight) + rowPadding;

    if (cursorY + rowHeight > doc.page.height - margin) {
      doc.addPage();
      drawTableHeader();
    }

    doc.text(nameText, tableCols[0].x, cursorY, { width: tableCols[0].width });
    doc.text(String(company.job_count ?? 0), tableCols[1].x, cursorY, { width: tableCols[1].width });
    doc.text(String(company.offer_count ?? 0), tableCols[2].x, cursorY, { width: tableCols[2].width });
    doc.text(formatPlacementCtc(company.avg_ctc ?? null), tableCols[3].x, cursorY, { width: tableCols[3].width });
    doc.text(formatPlacementCtc(company.top_ctc ?? null), tableCols[4].x, cursorY, { width: tableCols[4].width });

    cursorY += rowHeight;
  }

  doc.end();
  return done;
};

const extractPdfFlateText = (buffer: Buffer): string => {
  const raw = buffer.toString('latin1');
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  const chunks: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = streamRegex.exec(raw)) !== null) {
    const streamData = Buffer.from(match[1], 'latin1');
    if (streamData.length === 0) continue;

    try {
      const inflated = inflateSync(streamData);
      chunks.push(inflated.toString('utf8'));
    } catch {
      // Some streams are not Flate-compressed text; ignore these chunks.
    }
  }

  return chunks.join('\n');
};

const verifyCertificateCredentialFromPdf = async (
  supabase: ReturnType<typeof getSupabaseServerClient>,
  certificate: StoredStudentCertificate,
): Promise<void> => {
  const isPdf =
    certificate.mimeType.toLowerCase().includes('pdf') ||
    certificate.fileName.toLowerCase().endsWith('.pdf');

  if (!isPdf) {
    throw new AppError('Automated verification currently supports PDF certificates only.', 400);
  }

  const { data, error } = await supabase.storage.from(CERTIFICATES_BUCKET).download(certificate.storagePath);
  if (error || !data) {
    throw new AppError(`Failed to read certificate from storage: ${error?.message ?? 'unknown error'}`, 500, error);
  }

  const buffer = Buffer.from(await data.arrayBuffer());
  const expectedToken = normalizeCredentialToken(certificate.credentialId);

  if (!expectedToken) {
    throw new AppError('Credential ID is missing and cannot be verified.', 400);
  }

  let extractedText = '';
  let parserFailure: string | null = null;
  try {
    const pdfParseModule = await import('pdf-parse/lib/pdf-parse.js');
    const pdfParse = (pdfParseModule as { default?: unknown }).default as
      | ((input: Buffer) => Promise<{ text?: string }>)
      | undefined;

    if (typeof pdfParse !== 'function') {
      throw new Error('pdf-parse function export not found');
    }

    const parsed = await pdfParse(buffer);
    extractedText = typeof parsed?.text === 'string' ? parsed.text : '';
  } catch (error) {
    parserFailure = extractErrorMessage(error);
  }

  const documentToken = normalizeCredentialToken(extractedText);
  if (documentToken.includes(expectedToken)) {
    return;
  }

  // Fallback: scan raw PDF bytes. Many generated PDFs still retain searchable text tokens.
  const rawToken = normalizeCredentialToken(buffer.toString('latin1'));
  if (rawToken.includes(expectedToken)) {
    return;
  }

  const flateToken = normalizeCredentialToken(extractPdfFlateText(buffer));
  if (flateToken.includes(expectedToken)) {
    return;
  }

  if (parserFailure) {
    throw new AppError(
      `Failed to parse PDF for verification. Parser error: ${parserFailure}`,
      400,
    );
  }

  throw new AppError(
    `Verification failed: credential ID ${certificate.credentialId} was not found in the uploaded PDF content.`,
    400,
  );
};

const toStoredCertificate = (input: unknown): StoredStudentCertificate | null => {
  if (!input || typeof input !== 'object') return null;
  const row = input as Record<string, unknown>;

  const id = String(row.id ?? '').trim();
  const storagePath = String(row.storagePath ?? '').trim();
  const title = String(row.title ?? '').trim();
  const issuer = String(row.issuer ?? '').trim();
  const issueDate = String(row.issueDate ?? '').trim();
  const credentialId = String(row.credentialId ?? '').trim();

  if (!id || !storagePath || !title || !issuer || !issueDate || !credentialId) {
    return null;
  }

  const status = row.status === 'verified' ? 'verified' : 'pending';
  const points = typeof row.points === 'number' && Number.isFinite(row.points) ? row.points : status === 'verified' ? 100 : 0;
  const fileSize = typeof row.fileSize === 'number' && Number.isFinite(row.fileSize) ? row.fileSize : 0;

  return {
    id,
    title,
    issuer,
    issueDate,
    expiryDate: typeof row.expiryDate === 'string' && row.expiryDate.trim() ? row.expiryDate.trim() : null,
    credentialId,
    skills: normalizeStringArray(row.skills),
    status,
    points,
    fileName: String(row.fileName ?? 'certificate').trim() || 'certificate',
    fileSize,
    mimeType: String(row.mimeType ?? 'application/octet-stream').trim() || 'application/octet-stream',
    storagePath,
    uploadedAt: typeof row.uploadedAt === 'string' && row.uploadedAt ? row.uploadedAt : new Date().toISOString(),
    updatedAt: typeof row.updatedAt === 'string' && row.updatedAt ? row.updatedAt : new Date().toISOString(),
    verifiedAt: typeof row.verifiedAt === 'string' && row.verifiedAt ? row.verifiedAt : null,
  };
};

const readCertificatesFromProfile = (profile: unknown): StoredStudentCertificate[] => {
  if (!profile || typeof profile !== 'object') return [];
  const certificates = (profile as { certificates?: unknown }).certificates;
  if (!Array.isArray(certificates)) return [];

  return certificates
    .map((row) => toStoredCertificate(row))
    .filter((row): row is StoredStudentCertificate => Boolean(row));
};

const hydrateCertificateUrls = async (
  supabase: ReturnType<typeof getSupabaseServerClient>,
  certificate: StoredStudentCertificate,
): Promise<StudentCertificateResponse> => {
  const { data: viewData } = await supabase.storage.from(CERTIFICATES_BUCKET).createSignedUrl(certificate.storagePath, 60 * 60);
  const { data: downloadData } = await supabase.storage
    .from(CERTIFICATES_BUCKET)
    .createSignedUrl(certificate.storagePath, 60 * 60, { download: certificate.fileName });

  return {
    ...certificate,
    viewUrl: typeof viewData?.signedUrl === 'string' ? viewData.signedUrl : null,
    downloadUrl: typeof downloadData?.signedUrl === 'string' ? downloadData.signedUrl : null,
  };
};

const buildCertificatePayload = async (request: NextRequest): Promise<Record<string, unknown>> => {
  const form = await request.formData();
  const file = form.get('file');

  if (!(file instanceof File)) {
    throw new AppError('Certificate file is required', 400);
  }

  const title = String(form.get('title') ?? '').trim();
  const issuer = String(form.get('issuer') ?? '').trim();
  const issueDate = String(form.get('issueDate') ?? '').trim();
  const credentialId = String(form.get('credentialId') ?? '').trim();
  const expiryDateRaw = String(form.get('expiryDate') ?? '').trim();
  const skills = normalizeStringArray(form.get('skills'));

  if (!title || !issuer || !issueDate || !credentialId) {
    throw new AppError('title, issuer, issueDate and credentialId are required', 400);
  }

  return {
    file,
    title,
    issuer,
    issueDate,
    credentialId,
    expiryDate: expiryDateRaw || null,
    skills,
  };
};

const listStudentCertificates = async (
  request: NextRequest,
  services: PlacementDomainServices,
): Promise<unknown> => {
  const auth = await authOrThrow(request);
  ensureSupabaseServiceRoleConfigured();
  const profile = await ensureStudentProfile(auth, services);
  const certificates = readCertificatesFromProfile(profile);
  const supabase = getSupabaseServerClient();

  const rows = await Promise.all(
    certificates
      .sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime())
      .map((certificate) => hydrateCertificateUrls(supabase, certificate)),
  );

  const points = rows.reduce((acc, row) => acc + (row.status === 'verified' ? row.points : 0), 0);
  return {
    points,
    certificates: rows,
  };
};

const uploadStudentCertificate = async (
  request: NextRequest,
  services: PlacementDomainServices,
): Promise<unknown> => {
  const auth = await authOrThrow(request);
  ensureSupabaseServiceRoleConfigured();
  const user = await services.profiles.getCurrentUser(auth);
  if (user.role !== 'student') {
    throw new AppError('Only students can upload certificates', 403);
  }

  const payload = await buildCertificatePayload(request);
  const file = payload.file as File;
  const safeFileName = sanitizeFileName(file.name);
  const filePath = `${auth.uid}/${Date.now()}-${crypto.randomUUID()}-${safeFileName}`;
  const bytes = Buffer.from(await file.arrayBuffer());

  const supabase = getSupabaseServerClient();
  const { error } = await supabase.storage.from(CERTIFICATES_BUCKET).upload(filePath, bytes, {
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  });

  if (error) {
    throw new AppError(`Certificate upload failed: ${error.message}`, 500, error);
  }

  const now = new Date().toISOString();
  const createdCertificate: StoredStudentCertificate = {
    id: crypto.randomUUID(),
    title: String(payload.title),
    issuer: String(payload.issuer),
    issueDate: String(payload.issueDate),
    expiryDate: payload.expiryDate ? String(payload.expiryDate) : null,
    credentialId: String(payload.credentialId),
    skills: normalizeStringArray(payload.skills),
    status: 'pending',
    points: 0,
    fileName: safeFileName,
    fileSize: file.size,
    mimeType: file.type || 'application/octet-stream',
    storagePath: filePath,
    uploadedAt: now,
    updatedAt: now,
    verifiedAt: null,
  };

  const currentProfile = await ensureStudentProfile(auth, services);
  const existingCertificates = readCertificatesFromProfile(currentProfile);
  const nextCertificates = [createdCertificate, ...existingCertificates];

  await services.profiles.upsertStudentProfile(auth, {
    certificates: nextCertificates,
  });

  return listStudentCertificates(request, services);
};

const verifyStudentCertificate = async (
  request: NextRequest,
  services: PlacementDomainServices,
  certificateId: string,
): Promise<unknown> => {
  const auth = await authOrThrow(request);
  ensureSupabaseServiceRoleConfigured();
  const user = await services.profiles.getCurrentUser(auth);
  if (user.role !== 'student') {
    throw new AppError('Only students can verify certificates', 403);
  }

  const currentProfile = await ensureStudentProfile(auth, services);
  const existingCertificates = readCertificatesFromProfile(currentProfile);
  const index = existingCertificates.findIndex((row) => row.id === certificateId);

  if (index < 0) {
    throw new AppError('Certificate not found', 404);
  }

  const current = existingCertificates[index];
  if (!current.title || !current.issuer || !current.credentialId || !current.storagePath) {
    throw new AppError('Certificate details are incomplete and cannot be verified', 400);
  }

  const supabase = getSupabaseServerClient();
  await verifyCertificateCredentialFromPdf(supabase, current);

  if (current.status !== 'verified') {
    const now = new Date().toISOString();
    existingCertificates[index] = {
      ...current,
      status: 'verified',
      points: current.points > 0 ? current.points : 100,
      verifiedAt: now,
      updatedAt: now,
    };

    await services.profiles.upsertStudentProfile(auth, {
      certificates: existingCertificates,
    });
  }

  return listStudentCertificates(request, services);
};

const getStudentCertificateShareUrl = async (
  request: NextRequest,
  services: PlacementDomainServices,
  certificateId: string,
): Promise<unknown> => {
  const auth = await authOrThrow(request);
  ensureSupabaseServiceRoleConfigured();
  const profile = await ensureStudentProfile(auth, services);
  const certificate = readCertificatesFromProfile(profile).find((row) => row.id === certificateId);

  if (!certificate) {
    throw new AppError('Certificate not found', 404);
  }

  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase.storage
    .from(CERTIFICATES_BUCKET)
    .createSignedUrl(certificate.storagePath, 60 * 60 * 24 * 7);

  if (error) {
    throw new AppError(`Failed to generate share url: ${error.message}`, 500, error);
  }

  return {
    shareUrl: data?.signedUrl ?? null,
    expiresInSeconds: 60 * 60 * 24 * 7,
  };
};

// ── Highlights ──────────────────────────────────────────────────────────────

type StoredStudentHighlight = {
  id: string;
  title: string;
  description: string;
  skills: string[];
  storagePath: string | null;
  createdAt: string;
};

type StudentHighlightResponse = StoredStudentHighlight & {
  fileUrl: string | null;
};

const readHighlightsFromProfile = (profile: Record<string, unknown>): StoredStudentHighlight[] => {
  const raw = profile?.highlights;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === 'object' && entry !== null && typeof (entry as Record<string, unknown>).id === 'string',
    )
    .map((entry) => ({
      id: String(entry.id),
      title: String(entry.title ?? ''),
      description: String(entry.description ?? ''),
      skills: Array.isArray(entry.skills)
        ? entry.skills
            .map((skill) => (typeof skill === 'string' ? skill.trim() : ''))
            .filter((skill) => skill.length > 0)
        : [],
      storagePath: typeof entry.storagePath === 'string' ? entry.storagePath : null,
      createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString(),
    }));
};

const listStudentHighlights = async (
  request: NextRequest,
  services: PlacementDomainServices,
): Promise<unknown> => {
  const auth = await authOrThrow(request);
  const profile = await ensureStudentProfile(auth, services);
  const highlights = readHighlightsFromProfile(profile as unknown as Record<string, unknown>);

  const supabase = getSupabaseServerClient();
  const enriched: StudentHighlightResponse[] = await Promise.all(
    highlights.map(async (hl) => {
      let fileUrl: string | null = null;
      if (hl.storagePath) {
        try {
          const { data } = await supabase.storage.from(HIGHLIGHTS_BUCKET).createSignedUrl(hl.storagePath, 60 * 60);
          fileUrl = data?.signedUrl ?? null;
        } catch { /* ignore */ }
      }
      return { ...hl, fileUrl };
    }),
  );

  return { highlights: enriched };
};

const addStudentHighlight = async (
  request: NextRequest,
  services: PlacementDomainServices,
): Promise<unknown> => {
  const auth = await authOrThrow(request);
  ensureSupabaseServiceRoleConfigured();
  const user = await services.profiles.getCurrentUser(auth);
  if (user.role !== 'student') {
    throw new AppError('Only students can add highlights', 403);
  }

  const contentType = request.headers.get('content-type') ?? '';
  let title = '';
  let description = '';
  let skills: string[] = [];
  let file: File | null = null;

  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    title = String(form.get('title') ?? '').trim();
    description = String(form.get('description') ?? '').trim();
    const rawSkills = form.get('skills');
    if (typeof rawSkills === 'string') {
      try {
        const parsed = JSON.parse(rawSkills) as unknown;
        skills = Array.isArray(parsed)
          ? parsed
              .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
              .filter((entry) => entry.length > 0)
          : [];
      } catch {
        skills = rawSkills
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
      }
    }
    const fileField = form.get('file');
    if (fileField instanceof File && fileField.size > 0) {
      file = fileField;
    }
  } else {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    title = String(body.title ?? '').trim();
    description = String(body.description ?? '').trim();
    skills = Array.isArray(body.skills)
      ? body.skills
          .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
          .filter((entry) => entry.length > 0)
      : [];
  }

  if (!title) {
    throw new AppError('Highlight title is required', 400);
  }

  let storagePath: string | null = null;

  if (file) {
    const supabase = getSupabaseServerClient();
    const safeFileName = sanitizeFileName(file.name);
    const filePath = `${auth.uid}/${Date.now()}-${crypto.randomUUID()}-${safeFileName}`;
    const bytes = Buffer.from(await file.arrayBuffer());

    const { error } = await supabase.storage.from(HIGHLIGHTS_BUCKET).upload(filePath, bytes, {
      contentType: file.type || 'application/octet-stream',
      upsert: false,
    });

    if (error) {
      throw new AppError(`Highlight file upload failed: ${error.message}`, 500, error);
    }

    storagePath = filePath;
  }

  const now = new Date().toISOString();
  const newHighlight: StoredStudentHighlight = {
    id: crypto.randomUUID(),
    title,
    description,
    skills,
    storagePath,
    createdAt: now,
  };

  const currentProfile = await ensureStudentProfile(auth, services);
  const existing = readHighlightsFromProfile(currentProfile as unknown as Record<string, unknown>);
  const nextHighlights = [newHighlight, ...existing];

  await services.profiles.upsertStudentProfile(auth, { highlights: nextHighlights });

  return listStudentHighlights(request, services);
};

const deleteStudentHighlight = async (
  request: NextRequest,
  services: PlacementDomainServices,
  highlightId: string,
): Promise<unknown> => {
  const auth = await authOrThrow(request);
  ensureSupabaseServiceRoleConfigured();
  const user = await services.profiles.getCurrentUser(auth);
  if (user.role !== 'student') {
    throw new AppError('Only students can delete highlights', 403);
  }

  const currentProfile = await ensureStudentProfile(auth, services);
  const existing = readHighlightsFromProfile(currentProfile as unknown as Record<string, unknown>);
  const target = existing.find((hl) => hl.id === highlightId);

  if (!target) {
    throw new AppError('Highlight not found', 404);
  }

  // Delete file from storage if present
  if (target.storagePath) {
    try {
      const supabase = getSupabaseServerClient();
      await supabase.storage.from(HIGHLIGHTS_BUCKET).remove([target.storagePath]);
    } catch { /* best-effort */ }
  }

  const nextHighlights = existing.filter((hl) => hl.id !== highlightId);
  await services.profiles.upsertStudentProfile(auth, { highlights: nextHighlights });

  return listStudentHighlights(request, services);
};

const authOrThrow = async (request: NextRequest) => {
  const auth = await requireAuth(request);
  return auth;
};

const handleUpload = async (request: NextRequest): Promise<unknown> => {
  const auth = await authOrThrow(request);
  const { services } = getBackendContext();
  const currentUser = await services.profiles.getCurrentUser(auth);
  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) {
    throw new AppError('No file provided', 400);
  }

  // Extract user JWT so the storage client can authenticate correctly when
  // the service role key is not configured (falls back to anon key + user JWT).
  const rawAuthHeader = request.headers.get('authorization') ?? request.headers.get('Authorization') ?? '';
  const userJwt = rawAuthHeader.startsWith('Bearer ') ? rawAuthHeader.slice('Bearer '.length).trim() : '';
  const supabase = getStorageClient(userJwt);
  const requestedBucket = String(form.get('bucket') ?? '').trim();
  const bucket = requestedBucket || process.env.SUPABASE_STORAGE_BUCKET || 'uploads';
  const requestedFolder = String(form.get('folder') ?? '').trim().replace(/^\/+|\/+$/g, '');

  let folderPrefix = requestedFolder;
  let avatarStudentId: string | null = null;
  let resumePhotoStudentId: string | null = null;
  if (requestedFolder === 'avatars') {
    const profile = await ensureStudentProfile(auth, services);
    const studentId = typeof profile?.id === 'string' ? profile.id.trim() : '';
    if (!studentId) {
      throw new AppError('Student profile not found for avatar upload', 404);
    }
    avatarStudentId = studentId;
    folderPrefix = `avatars/${studentId}`;
  }

  if (requestedFolder.startsWith('resume_photo/')) {
    const profile = await ensureStudentProfile(auth, services);
    const studentId = typeof profile?.id === 'string' ? profile.id.trim() : '';
    const requestedStudentId = requestedFolder.slice('resume_photo/'.length).trim();
    if (!studentId || !requestedStudentId || requestedStudentId !== studentId) {
      throw new AppError('Invalid resume photo folder path', 403);
    }
    resumePhotoStudentId = studentId;
    folderPrefix = `resume_photo/${studentId}`;
  }

  const extension = sanitizeExtension(file.name);
  const fileNameCore = requestedFolder === 'avatars' || requestedFolder.startsWith('resume_photo/')
    ? `current.${extension}`
    : `${auth.uid}/${crypto.randomUUID()}.${extension}`;
  const fileName = folderPrefix ? `${folderPrefix}/${fileNameCore}` : fileNameCore;
  const fileBytes = Buffer.from(await file.arrayBuffer());

  if (requestedFolder === 'avatars' && avatarStudentId) {
    try {
      const { data: existing } = await supabase.storage.from(bucket).list(`avatars/${avatarStudentId}`, {
        limit: 100,
        offset: 0,
      });

      const stalePaths = (existing ?? [])
        .map((entry) => (typeof entry?.name === 'string' ? entry.name.trim() : ''))
        .filter((name) => Boolean(name))
        .map((name) => `avatars/${avatarStudentId}/${name}`)
        .filter((path) => path !== fileName);

      if (stalePaths.length > 0) {
        await supabase.storage.from(bucket).remove(stalePaths);
      }
    } catch {
      // Best-effort cleanup: upload still proceeds.
    }
  }

  if (requestedFolder.startsWith('resume_photo/') && resumePhotoStudentId) {
    try {
      const { data: existing } = await supabase.storage.from(bucket).list(`resume_photo/${resumePhotoStudentId}`, {
        limit: 100,
        offset: 0,
      });

      const stalePaths = (existing ?? [])
        .map((entry) => (typeof entry?.name === 'string' ? entry.name.trim() : ''))
        .filter((name) => Boolean(name))
        .map((name) => `resume_photo/${resumePhotoStudentId}/${name}`)
        .filter((path) => path !== fileName);

      if (stalePaths.length > 0) {
        await supabase.storage.from(bucket).remove(stalePaths);
      }
    } catch {
      // Best-effort cleanup: upload still proceeds.
    }
  }

  const { error } = await supabase.storage.from(bucket).upload(fileName, fileBytes, {
    contentType: file.type || 'application/octet-stream',
    upsert: true,
  });

  if (error) {
    throw new AppError(`Upload failed: ${error.message}`, 500, error);
  }

  if (requestedFolder === 'avatars' && avatarStudentId) {
    return { url: `${buildSimpleAvatarAliasUrl(currentUser.name ?? 'student')}?v=${Date.now()}` };
  }

  if (requestedFolder.startsWith('resume_photo/') && resumePhotoStudentId) {
    return { url: `${buildSimpleResumePhotoAliasUrl(currentUser.name ?? 'student')}?v=${Date.now()}` };
  }

  const { data } = supabase.storage.from(bucket).getPublicUrl(fileName);
  return { url: data.publicUrl };
};

// ── Email → Job Automated Pipeline ───────────────────────────────────────────

interface ParsedEmail {
  company_name: string | null;
  role: string | null;
  ctc_lpa: number | null;
  minimum_cgpa: number | null;
  location: string | null;
  skills_required: string[];
  backlog_criteria: number;
  is_internship: boolean;
  deadline: string | null;
  mode: 'online' | 'offline';
}

interface EmailPipelineInput {
  messageId: string;
  threadId: string;
  sourceEmail: string;
  cleanedText: string;
}

interface EmailPipelineResult {
  alreadyProcessed: boolean;
  jobId: string | null;
  companyId: string | null;
}

// qwen3 outputs <think>…</think> reasoning blocks before the actual answer.
// Strip them so JSON extraction always sees clean output.
function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

async function callQwen(prompt: string): Promise<string> {
  const res = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen3:8b',
      prompt,
      stream: false,
      options: { temperature: 0.1, num_predict: 4096 },
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Ollama HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json() as { response?: string; error?: string };
  if (data.error) throw new Error(`Ollama model error: ${data.error}`);
  const text = stripThinkBlocks(String(data.response ?? ''));
  if (!text) throw new Error('Ollama returned empty response — is qwen3:8b loaded? Run: ollama pull qwen3:8b');
  return text;
}

function extractJsonFromLlm(raw: string): Record<string, unknown> {
  let candidate = '';
  if (raw.trimStart().startsWith('{')) {
    candidate = raw.trim();
  } else {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced?.[1]?.trim().startsWith('{')) {
      candidate = fenced[1].trim();
    } else {
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start !== -1 && end > start) candidate = raw.slice(start, end + 1);
    }
  }
  if (!candidate) {
    throw new Error(`No JSON found in LLM output: "${raw.slice(0, 300)}"`);
  }
  try {
    return JSON.parse(candidate) as Record<string, unknown>;
  } catch {
    const fixed = candidate
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/:\s*undefined\b/g, ': null')
      .replace(/:\s*'([^']*)'/g, ': "$1"')
      .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":');
    return JSON.parse(fixed) as Record<string, unknown>;
  }
}

function normalizeEmailParse(raw: Record<string, unknown>): ParsedEmail {
  const coerceStr = (v: unknown): string | null => {
    if (v == null) return null;
    const s = String(v).trim();
    const l = s.toLowerCase();
    if (!s || l === 'null' || l === 'n/a' || l === 'none' || l === 'not mentioned' || l === 'not specified') return null;
    return s;
  };
  const coerceNum = (v: unknown): number | null => {
    if (v == null) return null;
    if (typeof v === 'number' && isFinite(v)) return v;
    const s = String(v).trim();
    const rangeMatch = s.match(/([\d.]+)\s*(?:[-–—]|to)\s*([\d.]+)/i);
    if (rangeMatch) {
      const max = Math.max(parseFloat(rangeMatch[1]!), parseFloat(rangeMatch[2]!));
      if (isFinite(max)) return max;
    }
    const m = s.match(/[\d.]+/);
    if (m) { const n = parseFloat(m[0]); if (isFinite(n)) return n; }
    return null;
  };

  // backlog_criteria: "No active backlogs" / "No backlogs" → 0
  const rawBacklog = raw.backlog_criteria ?? raw.allowed_backlogs;
  let backlogCriteria = 0;
  if (typeof rawBacklog === 'number' && isFinite(rawBacklog)) {
    backlogCriteria = Math.round(rawBacklog);
  } else if (typeof rawBacklog === 'string') {
    const s = rawBacklog.toLowerCase();
    if (s.includes('no') || s === '0') {
      backlogCriteria = 0;
    } else {
      const m = rawBacklog.match(/\d+/);
      backlogCriteria = m ? parseInt(m[0], 10) : 0;
    }
  }

  // job_type: false = Full Time, true = Internship
  let isInternship = false;
  const jt = raw.job_type ?? raw.is_internship;
  if (typeof jt === 'boolean') {
    isInternship = jt;
  } else if (typeof jt === 'string') {
    const s = jt.toLowerCase();
    isInternship = s.includes('intern') || s === 'true';
  }

  // mode: online / offline
  let mode: 'online' | 'offline' = 'online';
  const rawMode = coerceStr(raw.mode)?.toLowerCase();
  if (rawMode && (rawMode.includes('offline') || rawMode.includes('on-site') || rawMode === 'onsite')) {
    mode = 'offline';
  }

  // deadline: normalise to YYYY-MM-DD
  const rawDeadline = coerceStr(raw.deadline);
  let deadline: string | null = null;
  if (rawDeadline) {
    const dateMatch = rawDeadline.match(/(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) deadline = dateMatch[1];
  }

  // skills
  let skills: string[] = [];
  if (Array.isArray(raw.skills_required)) {
    skills = (raw.skills_required as unknown[]).map(s => String(s).trim()).filter(Boolean);
  } else if (typeof raw.skills_required === 'string') {
    skills = raw.skills_required.split(/[,;]/).map(s => s.trim()).filter(Boolean);
  }

  return {
    company_name: coerceStr(raw.company_name),
    role: coerceStr(raw.role),
    ctc_lpa: coerceNum(raw.ctc_lpa ?? raw.ctc),
    minimum_cgpa: coerceNum(raw.minimum_cgpa ?? raw.min_cgpa),
    location: coerceStr(raw.location),
    skills_required: skills,
    backlog_criteria: backlogCriteria,
    is_internship: isInternship,
    deadline,
    mode,
  };
}

async function parsePlacementEmail(rawText: string): Promise<ParsedEmail> {
  const prompt = `/no_think
Extract placement job information from the recruiter email below. Return ONLY valid JSON with no explanation, no markdown, no preamble. Start directly with {.

Required JSON schema:
{
  "company_name": string or null,
  "role": string or null,
  "ctc_lpa": number in LPA or null,
  "minimum_cgpa": number or null,
  "location": string or null,
  "skills_required": array of strings,
  "backlog_criteria": number (use 0 for "no active backlogs" or "no backlogs allowed"),
  "job_type": boolean (false for Full Time / Permanent, true for Internship),
  "deadline": "YYYY-MM-DD" string or null,
  "mode": "online" or "offline"
}

Email:
${rawText}

JSON:`;

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await callQwen(prompt);
      return normalizeEmailParse(extractJsonFromLlm(raw));
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

async function createJobFromParsedData(
  input: EmailPipelineInput,
  adminId: string,
  collegeId: string | null,
): Promise<EmailPipelineResult> {
  const supabase = getSupabaseServerClient();

  // 1. Dedup check — bail early if this message was already processed
  const { data: existing } = await supabase
    .from('processed_emails')
    .select('job_id, company_id')
    .eq('message_id', input.messageId)
    .maybeSingle();

  if (existing) {
    return {
      alreadyProcessed: true,
      jobId: (existing as { job_id?: string | null }).job_id ?? null,
      companyId: (existing as { company_id?: string | null }).company_id ?? null,
    };
  }

  // 2. Parse email via Qwen
  const parsed = await parsePlacementEmail(input.cleanedText);

  // 3. Company lookup / create
  if (!parsed.company_name) {
    throw new AppError('Could not determine company name from email — LLM extraction returned null', 422);
  }

  let companyId: string;
  const { data: foundCompany } = await supabase
    .from('companies')
    .select('id')
    .ilike('name', parsed.company_name)
    .limit(1)
    .maybeSingle();

  if (foundCompany) {
    companyId = String((foundCompany as { id?: unknown }).id ?? '');
  } else {
    const { data: newCompany, error: companyErr } = await supabase
      .from('companies')
      .insert({ name: parsed.company_name })
      .select('id')
      .single();
    if (companyErr || !newCompany) {
      throw new AppError(`Failed to create company: ${companyErr?.message ?? 'unknown error'}`, 500);
    }
    companyId = String((newCompany as { id?: unknown }).id ?? '');
  }

  // 4. Job insert
  const { data: newJob, error: jobErr } = await supabase
    .from('jobs')
    .insert({
      company_id: companyId,
      role: parsed.role ?? 'Unknown Role',
      min_cgpa: parsed.minimum_cgpa,
      allowed_backlogs: parsed.backlog_criteria,
      skills_required: parsed.skills_required.length > 0 ? parsed.skills_required : null,
      ctc: parsed.ctc_lpa,
      location: parsed.location,
      is_internship: parsed.is_internship,
      status: 'open',
      created_by_admin_id: adminId,
    })
    .select('id')
    .single();

  if (jobErr || !newJob) {
    throw new AppError(`Failed to create job: ${jobErr?.message ?? 'unknown error'}`, 500);
  }
  const jobId = String((newJob as { id?: unknown }).id ?? '');

  // 5. Placement drive insert
  if (collegeId) {
    await supabase.from('placement_drives').insert({
      job_id: jobId,
      company_id: companyId,
      college_id: collegeId,
      drive_date: parsed.deadline ? [parsed.deadline] : [],
      mode: parsed.mode,
      status: 'scheduled',
      created_by_admin_id: adminId,
    });
  }

  // 6. Student auto-sync — fetch eligible students and bulk-insert applications
  const minCgpa = parsed.minimum_cgpa ?? 0;
  const maxBacklogs = parsed.backlog_criteria;

  const { data: eligibleStudents } = await supabase
    .from('students')
    .select('id')
    .gte('cgpa', minCgpa)
    .lte('backlogs', maxBacklogs);

  let studentsSynced = 0;
  if (eligibleStudents && eligibleStudents.length > 0) {
    const rows = (eligibleStudents as { id: string }[]).map(s => ({
      student_id: s.id,
      job_id: jobId,
      status: 'applied',
    }));
    // Insert in chunks of 500 to stay within Supabase request limits
    for (let i = 0; i < rows.length; i += 500) {
      await supabase.from('applications').insert(rows.slice(i, i + 500));
    }
    studentsSynced = rows.length;
  }

  // 7. Record messageId to prevent future duplicates
  await supabase.from('processed_emails').insert({
    message_id: input.messageId,
    thread_id: input.threadId || null,
    source_email: input.sourceEmail || null,
    job_id: jobId,
    company_id: companyId,
  });

  // 8. Audit log (best-effort — never block on failure)
  try {
    await supabase.from('audit_logs').insert({
      actor_user_id: adminId,
      actor_category: 'admin',
      action: 'email.job.created',
      title: 'Job created from email',
      description: `Auto-created job "${parsed.role}" at "${parsed.company_name}" from ${input.sourceEmail || 'unknown sender'}`,
      entity_type: 'job',
      entity_id: jobId,
      metadata: {
        message_id: input.messageId,
        company_name: parsed.company_name,
        role: parsed.role,
        source_email: input.sourceEmail,
        students_synced: studentsSynced,
      },
      created_at: new Date().toISOString(),
    });
  } catch { /* audit logging is non-critical */ }

  return { alreadyProcessed: false, jobId, companyId };
}

// ─────────────────────────────────────────────────────────────────────────────

export const dispatchApiRequest = async (request: NextRequest, segments: string[]): Promise<unknown> => {
  const method = request.method.toUpperCase();
  const path = `/${segments.join('/')}`;
  const { services } = getBackendContext();

  if (method === 'GET' && segments[0] === 'avatar' && segments.length === 2) {
    const aliasOrToken = decodeURIComponent(segments[1] ?? '').trim();
    if (!aliasOrToken) {
      throw new AppError('avatar token or alias is required', 400);
    }

    const supabase = getSupabaseServerClient();

    const studentId =
      parseAvatarAliasToken(aliasOrToken) ??
      await resolveStudentIdFromSimpleAlias(aliasOrToken, supabase);

    if (!studentId) {
      throw new AppError('Invalid avatar alias', 404);
    }

    const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'uploads';
    const avatarFolder = `avatars/${studentId}`;

    const { data: avatarObjects, error: listError } = await supabase.storage.from(bucket).list(avatarFolder, {
      limit: 50,
      offset: 0,
      sortBy: { column: 'created_at', order: 'desc' },
    });

    if (listError) {
      throw new AppError(`Failed to load avatar: ${listError.message}`, 500, listError);
    }

    const latestAvatar = (avatarObjects ?? []).find((entry) => typeof entry?.name === 'string' && entry.name.trim().length > 0);
    const avatarPath = latestAvatar?.name ? `${avatarFolder}/${latestAvatar.name}` : null;

    if (!avatarPath) {
      return new Response(null, { status: 404 });
    }

    const { data: signed, error: signError } = await supabase.storage.from(bucket).createSignedUrl(avatarPath, 60 * 10);
    if (signError || !signed?.signedUrl) {
      throw new AppError(`Failed to sign avatar URL: ${signError?.message ?? 'Unknown error'}`, 500, signError);
    }

    return Response.redirect(signed.signedUrl, 307);
  }

  if (method === 'GET' && segments[0] === 'resume-photo' && segments.length === 2) {
    const aliasOrToken = decodeURIComponent(segments[1] ?? '').trim();
    if (!aliasOrToken) {
      throw new AppError('resume-photo token or alias is required', 400);
    }

    const supabase = getSupabaseServerClient();

    const studentId =
      parseAvatarAliasToken(aliasOrToken) ??
      await resolveStudentIdFromSimpleAlias(aliasOrToken, supabase);

    if (!studentId) {
      throw new AppError('Invalid resume-photo alias', 404);
    }

    const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'uploads';
    const resumePhotoFolder = `resume_photo/${studentId}`;

    const { data: resumePhotoObjects, error: listError } = await supabase.storage.from(bucket).list(resumePhotoFolder, {
      limit: 50,
      offset: 0,
      sortBy: { column: 'created_at', order: 'desc' },
    });

    if (listError) {
      throw new AppError(`Failed to load resume photo: ${listError.message}`, 500, listError);
    }

    const latestResumePhoto = (resumePhotoObjects ?? []).find((entry) => typeof entry?.name === 'string' && entry.name.trim().length > 0);
    const resumePhotoPath = latestResumePhoto?.name ? `${resumePhotoFolder}/${latestResumePhoto.name}` : null;

    if (!resumePhotoPath) {
      return new Response(null, { status: 404 });
    }

    const { data: signed, error: signError } = await supabase.storage.from(bucket).createSignedUrl(resumePhotoPath, 60 * 10);
    if (signError || !signed?.signedUrl) {
      throw new AppError(`Failed to sign resume photo URL: ${signError?.message ?? 'Unknown error'}`, 500, signError);
    }

    return Response.redirect(signed.signedUrl, 307);
  }

  if (method === 'GET' && segments[0] === 'students' && segments[1] === 'avatar' && segments.length === 3) {
    const studentId = decodeURIComponent(segments[2] ?? '').trim();
    if (!studentId) {
      throw new AppError('student_id is required', 400);
    }

    const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'uploads';
    const avatarFolder = `avatars/${studentId}`;
    const supabase = getSupabaseServerClient();

    const { data: avatarObjects, error: listError } = await supabase.storage.from(bucket).list(avatarFolder, {
      limit: 50,
      offset: 0,
      sortBy: { column: 'created_at', order: 'desc' },
    });

    if (listError) {
      throw new AppError(`Failed to load avatar: ${listError.message}`, 500, listError);
    }

    const latest = (avatarObjects ?? []).find((entry) => typeof entry?.name === 'string' && entry.name.trim().length > 0);
    if (!latest?.name) {
      return new Response(null, { status: 404 });
    }

    const avatarPath = `${avatarFolder}/${latest.name}`;
    const { data: signed, error: signError } = await supabase.storage.from(bucket).createSignedUrl(avatarPath, 60 * 10);
    if (signError || !signed?.signedUrl) {
      throw new AppError(`Failed to sign avatar URL: ${signError?.message ?? 'Unknown error'}`, 500, signError);
    }

    return Response.redirect(signed.signedUrl, 307);
  }

  if (method === 'POST' && path === '/upload') return handleUpload(request);

  if (method === 'POST' && path === '/auth/captcha') {
    await verifyCaptcha(getCaptchaToken(request), getClientIp(request));
    return { success: true };
  }


  if (method === 'GET' && path === '/colleges') {
    const url = new URL(request.url);
    const query = url.searchParams.get('query') ?? undefined;
    const state = url.searchParams.get('state') ?? undefined;
    return services.profiles.listPublicColleges(query, state);
  }

  if (method === 'GET' && path === '/users/me') {
    const auth = await authOrThrow(request);
    return services.profiles.getCurrentUserProfile(auth);
  }

  if (method === 'GET' && path === '/users/me/settings') {
    const auth = await authOrThrow(request);
    return services.profiles.getCurrentUserSettings(auth);
  }

  if (method === 'PUT' && path === '/users/me') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.profiles.updateCurrentUserProfile(auth, body);
  }

  if ((method === 'PATCH' || method === 'PUT') && path === '/users/me/settings') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.profiles.updateCurrentUserSettings(auth, body);
  }

  if (method === 'GET' && path === '/jobs') {
    const url = new URL(request.url);
    const { page, limit } = validatePaginationQuery(url.searchParams);
    const filters: Record<string, string | boolean | number | undefined> = {
      skip: url.searchParams.get('skip') ? Number(url.searchParams.get('skip')) : (page - 1) * limit,
      limit,
      query: url.searchParams.get('query') ?? undefined,
      location: url.searchParams.get('location') ?? undefined,
      status: url.searchParams.get('status') ?? 'open',
      is_internship: url.searchParams.get('is_internship')
        ? url.searchParams.get('is_internship') === 'true'
        : undefined,
      job_source: url.searchParams.get('job_source') ?? undefined,
      mode_of_work: url.searchParams.get('mode_of_work') ?? undefined,
    };

    // Student-authenticated callers get eligibility-decorated results;
    // anonymous/non-student callers get the raw list (no eligibility).
    try {
      const auth = await authOrThrow(request);
      return services.jobs.listJobsForStudent(auth, filters);
    } catch {
      return services.jobs.getJobs(filters);
    }
  }

  if (method === 'GET' && segments[0] === 'jobs' && segments.length === 2) {
    // If authenticated as a student, decorate the single job with eligibility.
    try {
      const auth = await authOrThrow(request);
      const { job } = await services.jobs.evaluateJobEligibilityForStudent(auth, segments[1]);
      return job;
    } catch {
      return services.jobs.getJob(segments[1]);
    }
  }

  if (method === 'POST' && path === '/applications') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    const created = await services.applications.createApplication(auth, body);
    logger.info('domain.application.submitted', {
      module: 'applications',
      userId: auth.uid,
    });
    return created;
  }

  if (method === 'GET' && path === '/applications/me') {
    const auth = await authOrThrow(request);
    const status = new URL(request.url).searchParams.get('status') ?? undefined;
    return services.applications.getMyApplications(auth, status);
  }

  if (method === 'GET' && segments[0] === 'applications' && segments[1] === 'me' && segments.length === 3) {
    const auth = await authOrThrow(request);
    return services.applications.getMyApplication(auth, segments[2]);
  }

  if (
    method === 'PATCH' &&
    segments[0] === 'applications' &&
    segments[1] === 'me' &&
    segments.length === 4 &&
    segments[3] === 'resume'
  ) {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    const resumeId = String(body.resume_id ?? '').trim();
    if (!resumeId) {
      throw new AppError('resume_id is required', 400);
    }
    return services.applications.updateMyApplicationResume(auth, segments[2], resumeId);
  }

  if (
    (method === 'PATCH' || method === 'POST') &&
    segments[0] === 'applications' &&
    segments.length === 3 &&
    segments[2] === 'withdraw'
  ) {
    const auth = await authOrThrow(request);
    return services.applications.withdrawApplication(auth, segments[1]);
  }

  if (method === 'GET' && path === '/interviews/me') {
    const auth = await authOrThrow(request);
    const status = new URL(request.url).searchParams.get('status') ?? undefined;
    return services.interviews.getMyInterviews(auth, status);
  }

  if (method === 'GET' && segments[0] === 'interviews' && segments[1] === 'me' && segments.length === 3) {
    const auth = await authOrThrow(request);
    return services.interviews.getMyInterview(auth, segments[2]);
  }

  if (method === 'GET' && path === '/offers/me') {
    const auth = await authOrThrow(request);
    const status = new URL(request.url).searchParams.get('status') ?? undefined;
    return services.offers.getMyOffers(auth, status);
  }

  if (method === 'GET' && segments[0] === 'offers' && segments[1] === 'me' && segments.length === 3) {
    const auth = await authOrThrow(request);
    return services.offers.getMyOffer(auth, segments[2]);
  }

  if ((method === 'PATCH' || method === 'POST') && segments[0] === 'offers' && segments.length === 3 && segments[2] === 'accept') {
    const auth = await authOrThrow(request);
    return services.offers.acceptOffer(auth, segments[1]);
  }

  if ((method === 'PATCH' || method === 'POST') && segments[0] === 'offers' && segments.length === 3 && segments[2] === 'decline') {
    const auth = await authOrThrow(request);
    return services.offers.declineOffer(auth, segments[1]);
  }

  if (
    (method === 'PATCH' || method === 'POST')
    && segments[0] === 'student'
    && segments[1] === 'referrals'
    && segments[3] === 'respond'
    && segments.length === 4
  ) {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.referrals.respondToStudentReferral(auth, segments[2], body);
  }

  if (method === 'POST' && path === '/referrals/send') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    const created = await services.referrals.sendReferral(auth, validateReferralPayload(body));
    logger.info('domain.referral.submitted', {
      module: 'referrals',
      userId: auth.uid,
    });
    return created;
  }

  if (method === 'GET' && path === '/referrals/incoming') {
    const auth = await authOrThrow(request);
    return services.referrals.fetchIncomingReferrals(auth);
  }

  if (method === 'GET' && path === '/referrals/outgoing') {
    const auth = await authOrThrow(request);
    return services.referrals.fetchOutgoingReferrals(auth);
  }

  if (method === 'POST' && path === '/referrals/accept') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.referrals.acceptReferral(auth, String(body.referral_id ?? body.referralId ?? ''));
  }

  if (method === 'POST' && path === '/referrals/reject') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.referrals.rejectReferral(auth, String(body.referral_id ?? body.referralId ?? ''));
  }

  if (method === 'GET' && path === '/students/me') {
    const auth = await authOrThrow(request);
    return services.profiles.getMyStudentProfile(auth);
  }

  // ── Master skills catalog ──
  if (method === 'GET' && path === '/skills/search') {
    const auth = await authOrThrow(request);
    const url = new URL(request.url);
    const q = url.searchParams.get('q') ?? url.searchParams.get('query') ?? '';
    const rawLimit = url.searchParams.get('limit');
    const limit = rawLimit ? Number(rawLimit) : undefined;
    return services.profiles.searchMasterSkills(auth, q, Number.isFinite(limit) ? (limit as number) : undefined);
  }

  if (method === 'GET' && path.startsWith('/skills/')) {
    const skillId = path.slice('/skills/'.length);
    if (skillId && !skillId.includes('/')) {
      const auth = await authOrThrow(request);
      return services.profiles.getMasterSkillById(auth, skillId);
    }
  }

  if (method === 'POST' && path === '/skills') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.profiles.createMasterSkill(auth, body);
  }

  if (method === 'PATCH' && path.startsWith('/skills/')) {
    const skillId = path.slice('/skills/'.length);
    if (skillId && !skillId.includes('/')) {
      const auth = await authOrThrow(request);
      const body = await parseJsonBody(request);
      return services.profiles.updateMasterSkill(auth, skillId, body);
    }
  }

  // ── Per-student skill add/remove (REST replacement for legacy RPCs) ──
  if (method === 'POST' && path === '/students/me/skills') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    const skillId = String((body as { skill_id?: unknown; skillId?: unknown }).skill_id ?? (body as { skillId?: unknown }).skillId ?? '');
    const proficiency = typeof (body as { proficiency?: unknown }).proficiency === 'string'
      ? (body as { proficiency: string }).proficiency
      : undefined;
    return services.profiles.addSkillToCurrentStudent(auth, skillId, proficiency);
  }

  if (method === 'DELETE' && path.startsWith('/students/me/skills/')) {
    const skillId = path.slice('/students/me/skills/'.length);
    if (skillId && !skillId.includes('/')) {
      const auth = await authOrThrow(request);
      return services.profiles.removeSkillFromCurrentStudent(auth, skillId);
    }
  }

  if (method === 'GET' && path === '/students/drives') {
    const auth = await authOrThrow(request);
    const url = new URL(request.url);
    return services.drives.fetchPlacementDrivesForStudent(auth, url.searchParams.get('tab') ?? undefined);
  }

  if (method === 'GET' && path === '/students/resume-source') {
    const auth = await authOrThrow(request);
    const source = await services.profiles.getMyResumeProfileSource(auth) as Record<string, unknown>;

    const student = source?.student as Record<string, unknown> | undefined;
    const user = source?.user as Record<string, unknown> | undefined;
    const studentId = typeof student?.id === 'string' ? student.id.trim() : '';

    if (studentId) {
      const supabase = getSupabaseServerClient();
      const avatarFolder = `avatars/${studentId}`;
      const resumePhotoFolder = `resume_photo/${studentId}`;

      try {
        const { data: resumePhotoObjects, error: resumePhotoError } = await supabase.storage
          .from(process.env.SUPABASE_STORAGE_BUCKET || 'uploads')
          .list(resumePhotoFolder, {
            limit: 50,
            offset: 0,
            sortBy: { column: 'created_at', order: 'desc' },
          });

        const latestResumePhoto = (resumePhotoObjects ?? []).find(
          (entry) => typeof entry?.name === 'string' && entry.name.trim().length > 0,
        );

        if (!latestResumePhoto && !resumePhotoError) {
          const { data: avatarObjects, error } = await supabase.storage
          .from(process.env.SUPABASE_STORAGE_BUCKET || 'uploads')
          .list(avatarFolder, {
            limit: 50,
            offset: 0,
            sortBy: { column: 'created_at', order: 'desc' },
          });

          if (!error && Array.isArray(avatarObjects) && avatarObjects.length > 0) {
            const latest = avatarObjects.find((entry) => typeof entry?.name === 'string' && entry.name.trim().length > 0);
            if (latest?.name && user) {
              source.user = {
                ...user,
                avatar: buildSimpleAvatarAliasUrl(typeof user.name === 'string' ? user.name : 'student'),
              };
            }
          }
        } else if (latestResumePhoto && user) {
          source.user = {
            ...user,
            avatar: buildSimpleResumePhotoAliasUrl(typeof user.name === 'string' ? user.name : 'student'),
          };
        } else if (!resumePhotoError && user) {
          // No resume photo and no avatars found: leave avatar as-is from profile.
        } else if (resumePhotoError) {
          const { data: avatarObjects } = await supabase.storage
            .from(process.env.SUPABASE_STORAGE_BUCKET || 'uploads')
            .list(avatarFolder, {
              limit: 50,
              offset: 0,
              sortBy: { column: 'created_at', order: 'desc' },
            });

          const latest = (avatarObjects ?? []).find((entry) => typeof entry?.name === 'string' && entry.name.trim().length > 0);
          if (latest?.name && user) {
            source.user = {
              ...user,
              avatar: buildSimpleAvatarAliasUrl(typeof user.name === 'string' ? user.name : 'student'),
            };
          }
        }
      } catch {
        // Best-effort avatar enrichment for resume source.
      }
    }

    return source;
  }

  if (method === 'POST' && path === '/students') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.profiles.upsertStudentProfile(auth, body);
  }

  if (method === 'GET' && path === '/students/resumes') {
    const auth = await authOrThrow(request);
    return services.profiles.listMyResumes(auth);
  }

  if (method === 'POST' && path === '/students/resumes') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.profiles.createMyResume(auth, body);
  }

  if (method === 'PATCH' && segments[0] === 'students' && segments[1] === 'resumes' && segments.length === 3) {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.profiles.updateMyResume(auth, segments[2], body);
  }

  if (method === 'PUT' && path === '/students/resumes/default-domain') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.profiles.upsertMyDefaultResumeDomain(auth, body);
  }

  if (method === 'DELETE' && segments[0] === 'students' && segments[1] === 'resumes' && segments.length === 3) {
    const auth = await authOrThrow(request);
    await services.profiles.deleteMyResume(auth, segments[2]);
    return { ok: true };
  }

  if (method === 'GET' && path === '/students/projects') {
    const auth = await authOrThrow(request);
    return services.profiles.listMyProjects(auth);
  }

  if (method === 'POST' && path === '/students/projects') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.profiles.createMyProject(auth, body);
  }

  if (method === 'DELETE' && segments[0] === 'students' && segments[1] === 'projects' && segments[2]) {
    const auth = await authOrThrow(request);
    await services.profiles.deleteMyProject(auth, segments[2]);
    return { ok: true };
  }

  if (method === 'GET' && path === '/students/certificates') {
    return listStudentCertificates(request, services);
  }

  if (method === 'POST' && path === '/students/certificates/upload') {
    return uploadStudentCertificate(request, services);
  }

  if (method === 'POST' && segments[0] === 'students' && segments[1] === 'certificates' && segments[3] === 'verify') {
    return verifyStudentCertificate(request, services, segments[2]);
  }

  if (method === 'GET' && segments[0] === 'students' && segments[1] === 'certificates' && segments[3] === 'share') {
    return getStudentCertificateShareUrl(request, services, segments[2]);
  }

  if (method === 'GET' && path === '/students/highlights') {
    return listStudentHighlights(request, services);
  }

  if (method === 'POST' && path === '/students/highlights') {
    return addStudentHighlight(request, services);
  }

  if (method === 'DELETE' && segments[0] === 'students' && segments[1] === 'highlights' && segments.length === 3) {
    return deleteStudentHighlight(request, services, segments[2]);
  }

  if (method === 'POST' && (path === '/recruiter/company' || path === '/recruiter/company/me')) {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.profiles.createMyCompany(auth, body);
  }

  if (method === 'GET' && path === '/recruiter/company/me') {
    const auth = await authOrThrow(request);
    return services.profiles.getMyCompany(auth);
  }

  if (method === 'PUT' && path === '/recruiter/company/me') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.profiles.updateMyCompany(auth, body);
  }

  if (method === 'GET' && path === '/recruiter/profile/me') {
    const auth = await authOrThrow(request);
    return services.profiles.getCurrentRecruiterProfile(auth);
  }

  if ((method === 'PUT' || method === 'PATCH') && path === '/recruiter/profile/me') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.profiles.updateCurrentRecruiterProfile(auth, body);
  }

  // POST /alumni/register — self-onboarding for alumni not pre-provisioned by admin
  if (method === 'POST' && path === '/alumni/register') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.profiles.alumniSelfRegister(auth, body);
  }

  if (method === 'GET' && path === '/alumni/profile/me') {
    const auth = await authOrThrow(request);
    return services.profiles.fetchCurrentAlumniProfile(auth);
  }

  if (method === 'POST' && path === '/alumni/support') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.profiles.submitAlumniSupportRequest(auth, body);
  }

  if (method === 'GET' && path === '/alumni/support/me') {
    const auth = await authOrThrow(request);
    return services.profiles.fetchMyAlumniSupportRequests(auth);
  }

  if ((method === 'PUT' || method === 'PATCH' || method === 'POST') && path === '/alumni/profile/me') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.profiles.upsertCurrentAlumniProfile(auth, body);
  }

  if (method === 'POST' && path === '/alumni/referral-jobs') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.profiles.addAlumniReferralJob(auth, body);
  }

  if (method === 'GET' && path === '/alumni/profile/options') {
    const auth = await authOrThrow(request);
    const url = new URL(request.url);
    return services.profiles.getAlumniProfileMeta(auth, {
      companyQuery: url.searchParams.get('company_query') ?? undefined,
      collegeQuery: url.searchParams.get('college_query') ?? undefined,
    });
  }

  if (method === 'GET' && path === '/alumni/company/me') {
    const auth = await authOrThrow(request);
    return services.profiles.fetchCurrentAlumniCompany(auth);
  }

  if ((method === 'PUT' || method === 'PATCH' || method === 'POST') && path === '/alumni/company/me') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.profiles.upsertAlumniCompanyContext(auth, body);
  }

  if (method === 'GET' && path === '/alumni/connect/discover') {
    const auth = await authOrThrow(request);
    const url = new URL(request.url);
    return services.networking.fetchAlumniConnectDiscover(auth, {
      mode: url.searchParams.get('mode') ?? undefined,
      query: url.searchParams.get('query') ?? undefined,
    });
  }

  if (method === 'GET' && path === '/alumni/connect/students') {
    const auth = await authOrThrow(request);
    const url = new URL(request.url);

    const minCgpaValue = url.searchParams.get('min_cgpa');
    const maxBacklogsValue = url.searchParams.get('max_backlogs');
    const minCgpa = typeof minCgpaValue === 'string' && minCgpaValue.trim() ? Number(minCgpaValue) : undefined;
    const maxBacklogs = typeof maxBacklogsValue === 'string' && maxBacklogsValue.trim() ? Number(maxBacklogsValue) : undefined;

    return services.networking.fetchStudentConnectDiscover(auth, {
      department_id: url.searchParams.get('department_id') ?? undefined,
      min_cgpa: typeof minCgpa === 'number' && Number.isFinite(minCgpa) ? minCgpa : undefined,
      max_backlogs: typeof maxBacklogs === 'number' && Number.isFinite(maxBacklogs) ? maxBacklogs : undefined,
      search: url.searchParams.get('search') ?? undefined,
    });
  }
  if (method === 'POST' && path === '/alumni/connect/request') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.networking.sendConnectionRequest(auth, String(body.target_user_id ?? body.targetUserId ?? ''));
  }

  if (method === 'POST' && path === '/alumni/connect/accept') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.networking.acceptConnectionRequest(auth, String(body.connection_id ?? body.connectionId ?? ''));
  }

  if (method === 'POST' && path === '/alumni/connect/reject') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.networking.rejectConnectionRequest(auth, String(body.connection_id ?? body.connectionId ?? ''));
  }

  if (method === 'POST' && path === '/alumni/connect/cancel') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.networking.cancelConnectionRequest(auth, String(body.connection_id ?? body.connectionId ?? ''));
  }

  if (method === 'GET' && path === '/alumni/connect/requests/incoming') {
    const auth = await authOrThrow(request);
    const response = await services.networking.fetchIncomingRequests(auth);
    logger.info(
      'alumni.connect.requests.incoming',
      { userId: auth.uid },
      { count: Array.isArray(response) ? response.length : 0 },
    );
    return response;
  }

  if (method === 'GET' && path === '/alumni/connect/requests/outgoing') {
    const auth = await authOrThrow(request);
    const response = await services.networking.fetchOutgoingRequests(auth);
    logger.info(
      'alumni.connect.requests.outgoing',
      { userId: auth.uid },
      { count: Array.isArray(response) ? response.length : 0 },
    );
    return response;
  }

  if (method === 'GET' && path === '/alumni/connect/network') {
    const auth = await authOrThrow(request);
    return services.networking.fetchNetwork(auth);
  }

  if (method === 'GET' && path === '/alumni/messages/contacts') {
    const auth = await authOrThrow(request);
    return services.networking.fetchMessageContacts(auth);
  }

  if (method === 'GET' && segments[0] === 'alumni' && segments[1] === 'messages' && segments.length === 3) {
    const auth = await authOrThrow(request);
    return services.networking.fetchMessagesByConnection(auth, segments[2]);
  }

  if (method === 'POST' && path === '/alumni/messages/send') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.networking.sendMessage(auth, body);
  }

  if (method === 'POST' && path === '/alumni/messages/attachment-url') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.networking.resolveMessageAttachmentUrl(auth, body);
  }

  if (method === 'GET' && path === '/recruiter/students') {
    const auth = await authOrThrow(request);
    const url = new URL(request.url);

    const minCgpaValue = url.searchParams.get('min_cgpa');
    const maxBacklogsValue = url.searchParams.get('max_backlogs');
    const minCgpa = typeof minCgpaValue === 'string' && minCgpaValue.trim() ? Number(minCgpaValue) : undefined;
    const maxBacklogs =
      typeof maxBacklogsValue === 'string' && maxBacklogsValue.trim() ? Number(maxBacklogsValue) : undefined;

    return services.jobs.recruiterGetReferralStudents(auth, {
      state: url.searchParams.get('state') ?? undefined,
      job_id: url.searchParams.get('job_id') ?? undefined,
      college_id: url.searchParams.get('college_id') ?? undefined,
      department_id: url.searchParams.get('department_id') ?? undefined,
      min_cgpa: typeof minCgpa === 'number' && Number.isFinite(minCgpa) ? minCgpa : undefined,
      max_backlogs: typeof maxBacklogs === 'number' && Number.isFinite(maxBacklogs) ? maxBacklogs : undefined,
      search: url.searchParams.get('search') ?? undefined,
    });
  }

  if (method === 'GET' && path === '/recruiter/drives') {
    const auth = await authOrThrow(request);
    const url = new URL(request.url);
    return services.drives.fetchPlacementDrivesForRecruiter(
      auth,
      url.searchParams.get('tab') ?? undefined,
      {
        state: url.searchParams.get('state') ?? undefined,
        job_id: url.searchParams.get('job_id') ?? undefined,
      },
    );
  }

  if (method === 'GET' && path === '/filters/states') {
    const auth = await authOrThrow(request);
    return services.jobs.fetchStateOptions(auth);
  }

  if (method === 'GET' && path === '/filters/jobs') {
    const auth = await authOrThrow(request);
    const url = new URL(request.url);
    const state = url.searchParams.get('state') ?? '';
    return services.jobs.fetchJobsForState(auth, state);
  }

  if (method === 'GET' && path === '/filters/colleges') {
    const auth = await authOrThrow(request);
    const url = new URL(request.url);
    const state = url.searchParams.get('state') ?? '';
    const jobId = url.searchParams.get('jobId') ?? '';
    return services.jobs.fetchCollegesForStateAndJob(auth, state, jobId);
  }

  if (method === 'GET' && path === '/filters/students') {
    const auth = await authOrThrow(request);
    const url = new URL(request.url);

    const minCgpaValue = url.searchParams.get('minCgpa');
    const maxBacklogsValue = url.searchParams.get('maxBacklogs');
    const minCgpa = typeof minCgpaValue === 'string' && minCgpaValue.trim() ? Number(minCgpaValue) : undefined;
    const maxBacklogs =
      typeof maxBacklogsValue === 'string' && maxBacklogsValue.trim() ? Number(maxBacklogsValue) : undefined;

    return services.jobs.fetchReferralStudentsForCollege(auth, {
      state: url.searchParams.get('state') ?? undefined,
      job_id: url.searchParams.get('jobId') ?? undefined,
      college_id: url.searchParams.get('collegeId') ?? undefined,
      department_id: url.searchParams.get('departmentId') ?? undefined,
      min_cgpa: typeof minCgpa === 'number' && Number.isFinite(minCgpa) ? minCgpa : undefined,
      max_backlogs: typeof maxBacklogs === 'number' && Number.isFinite(maxBacklogs) ? maxBacklogs : undefined,
      search: url.searchParams.get('search') ?? undefined,
    });
  }

  if (method === 'GET' && path === '/departments/by-college') {
    const auth = await authOrThrow(request);
    return services.jobs.fetchDepartmentsForCollege(auth);
  }

  if (method === 'POST' && path === '/recruiter/jobs') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    const normalizedBody = validateRecruiterJobPayload(body);
    const created = await services.jobs.recruiterCreateJob(auth, normalizedBody);
    logger.info('domain.job.created', {
      module: 'jobs',
      userId: auth.uid,
      role: 'recruiter',
    });
    return created;
  }

  if (method === 'GET' && path === '/recruiter/jobs') {
    const auth = await authOrThrow(request);
    return services.jobs.recruiterGetJobs(auth);
  }

  if (method === 'GET' && path === '/recruiter/insights') {
    const auth = await authOrThrow(request);
    const url = new URL(request.url);
    return services.analytics.recruiterGetInsights(auth, {
      state: url.searchParams.get('state') ?? undefined,
      college_id: url.searchParams.get('college_id') ?? undefined,
      role: url.searchParams.get('role') ?? undefined,
    });
  }

  if (method === 'GET' && path === '/recruiter/insights/jobs/drilldown') {
    const auth = await authOrThrow(request);
    const url = new URL(request.url);
    return services.analytics.recruiterGetJobDrilldownInsights(auth, {
      state: url.searchParams.get('state') ?? undefined,
      job_id: url.searchParams.get('job_id') ?? undefined,
      college_id: url.searchParams.get('college_id') ?? undefined,
    });
  }

  if (method === 'GET' && segments[0] === 'recruiter' && segments[1] === 'job-insights' && segments.length === 3) {
    const auth = await authOrThrow(request);
    return services.analytics.recruiterGetJobInsights(auth, segments[2]);
  }

  if (method === 'GET' && segments[0] === 'recruiter' && segments[1] === 'insights' && segments[2] === 'jobs' && segments.length === 4) {
    const auth = await authOrThrow(request);
    return services.analytics.recruiterGetJobInsights(auth, segments[3]);
  }

  if (method === 'GET' && segments[0] === 'recruiter' && segments[1] === 'jobs' && segments.length === 3) {
    const auth = await authOrThrow(request);
    return services.jobs.recruiterGetJob(auth, segments[2]);
  }

  if (method === 'PUT' && segments[0] === 'recruiter' && segments[1] === 'jobs' && segments.length === 3) {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    const normalizedBody = validateRecruiterJobUpdatePayload(body);
    return services.jobs.recruiterUpdateJob(auth, segments[2], normalizedBody);
  }

  if (method === 'PATCH' && segments[0] === 'recruiter' && segments[1] === 'jobs' && segments[3] === 'status') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.jobs.recruiterPatchJobStatus(auth, segments[2], String(body.status ?? ''));
  }

  if (method === 'PATCH' && segments[0] === 'recruiter' && segments[1] === 'jobs' && segments[3] === 'priority') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.jobs.recruiterPatchJobPriority(auth, segments[2], Boolean(body.priority));
  }

  if (method === 'DELETE' && segments[0] === 'recruiter' && segments[1] === 'jobs' && segments.length === 3) {
    const auth = await authOrThrow(request);
    return services.jobs.recruiterDeleteJob(auth, segments[2]);
  }

  if (method === 'GET' && segments[0] === 'recruiter' && segments[1] === 'jobs' && segments[3] === 'applications') {
    const auth = await authOrThrow(request);
    const status = new URL(request.url).searchParams.get('status') ?? undefined;
    return services.applications.recruiterGetApplicationsByJob(auth, segments[2], status);
  }

  if (method === 'GET' && segments[0] === 'recruiter' && segments[1] === 'jobs' && segments[3] === 'drive-request-readiness') {
    const auth = await authOrThrow(request);
    return services.approvals.recruiterGetDriveRequestReadiness(auth, segments[2]);
  }

  if (method === 'POST' && segments[0] === 'recruiter' && segments[1] === 'jobs' && segments[3] === 'close-after-finalized-offers') {
    const auth = await authOrThrow(request);
    return services.approvals.recruiterCloseJobAfterFinalizedOffers(auth, segments[2]);
  }

  if (method === 'GET' && segments[0] === 'recruiter' && segments[1] === 'applications' && segments.length === 3) {
    const auth = await authOrThrow(request);
    return services.applications.recruiterGetApplication(auth, segments[2]);
  }

  if (method === 'PATCH' && segments[0] === 'recruiter' && segments[1] === 'applications' && segments[3] === 'status') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.applications.recruiterUpdateApplicationStatus(
      auth,
      segments[2],
      String(body.status ?? ''),
      typeof body.current_round === 'number' || typeof body.current_round === 'string'
        ? body.current_round
        : undefined,
    );
  }

  if (method === 'PATCH' && segments[0] === 'recruiter' && segments[1] === 'applications' && segments[3] === 'reinstate') {
    const auth = await authOrThrow(request);
    return services.applications.recruiterReinstateApplication(auth, segments[2]);
  }

  if (method === 'POST' && path === '/recruiter/interviews') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    const created = await services.interviews.recruiterCreateInterview(auth, validateInterviewPayload(body));
    logger.info('domain.interview.scheduled', {
      module: 'interviews',
      userId: auth.uid,
      role: 'recruiter',
    });
    return created;
  }

  if (method === 'GET' && path === '/recruiter/interviews') {
    const auth = await authOrThrow(request);
    const url = new URL(request.url);
    return services.interviews.recruiterGetInterviews(auth, {
      state: url.searchParams.get('state') ?? undefined,
      college_id: url.searchParams.get('college_id') ?? undefined,
      department_id: url.searchParams.get('department_id') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
      job_id: url.searchParams.get('job_id') ?? undefined,
      role: url.searchParams.get('role') ?? undefined,
      search: url.searchParams.get('search') ?? undefined,
    });
  }

  if (method === 'GET' && segments[0] === 'recruiter' && segments[1] === 'interviews' && segments.length === 3) {
    const auth = await authOrThrow(request);
    return services.interviews.recruiterGetInterview(auth, segments[2]);
  }

  if (
    (method === 'PUT' || method === 'PATCH') &&
    segments[0] === 'recruiter' &&
    segments[1] === 'interviews' &&
    segments.length === 3
  ) {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.interviews.recruiterUpdateInterview(auth, segments[2], body);
  }

  if (method === 'PATCH' && segments[0] === 'recruiter' && segments[1] === 'interviews' && segments[3] === 'result') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.interviews.recruiterUpdateInterviewResult(
      auth,
      segments[2],
      String(body.result ?? ''),
      typeof body.feedback === 'string' ? body.feedback : undefined,
    );
  }

  if (method === 'DELETE' && segments[0] === 'recruiter' && segments[1] === 'interviews' && segments.length === 3) {
    const auth = await authOrThrow(request);
    return services.interviews.recruiterDeleteInterview(auth, segments[2]);
  }

  if (method === 'POST' && path === '/recruiter/offers') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    const created = await services.offers.recruiterCreateOffer(auth, validateOfferPayload(body));
    logger.info('domain.offer.issued', {
      module: 'offers',
      userId: auth.uid,
      role: 'recruiter',
    });
    return created;
  }

  if (method === 'POST' && segments[0] === 'recruiter' && segments[1] === 'jobs' && segments[3] === 'finalize-offers') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.offers.recruiterFinalizeJobOffers(auth, segments[2], body);
  }

  if (method === 'GET' && path === '/recruiter/approvals') {
    const auth = await authOrThrow(request);
    return services.approvals.recruiterGetApprovalRequests(auth);
  }

  if (method === 'GET' && path === '/recruiter/support/issues') {
    const auth = await authOrThrow(request);
    return services.support.recruiterGetSupportIssues(auth);
  }

  if (method === 'GET' && path === '/recruiter/support/issues/me') {
    const auth = await authOrThrow(request);
    return services.support.recruiterGetMySupportIssues(auth);
  }

  if (method === 'POST' && path === '/recruiter/support/issues') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    const created = await services.support.recruiterCreateSupportIssue(auth, validateSupportIssuePayload(body));
    logger.info('domain.support.issue.created', {
      module: 'support',
      userId: auth.uid,
      role: 'recruiter',
    });
    return created;
  }

  if (method === 'GET' && path === '/recruiter/support/feedback') {
    const auth = await authOrThrow(request);
    return services.support.recruiterGetMySupportFeedback(auth);
  }

  if (method === 'POST' && path === '/recruiter/support/feedback') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.support.recruiterCreateSupportFeedback(auth, body);
  }

  if (method === 'PATCH' && segments[0] === 'recruiter' && segments[1] === 'support' && segments[2] === 'issues' && segments[4] === 'status') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.support.recruiterUpdateSupportIssueStatus(
      auth,
      segments[3],
      String(body.status ?? ''),
      typeof body.response === 'string' ? body.response : undefined,
    );
  }

  if (method === 'GET' && path === '/recruiter/colleges') {
    const auth = await authOrThrow(request);
    const url = new URL(request.url);
    const query = url.searchParams.get('query') ?? undefined;
    const state = url.searchParams.get('state') ?? undefined;
    if (state && state.trim()) {
      return services.jobs.recruiterGetCollegesByState(auth, state, query);
    }
    return services.jobs.recruiterSearchColleges(auth, query);
  }

  if (method === 'GET' && path === '/recruiter/college-states') {
    const auth = await authOrThrow(request);
    return services.jobs.recruiterGetCollegeStates(auth);
  }

  if (method === 'POST' && path === '/recruiter/approvals') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.approvals.recruiterCreateApprovalRequest(auth, body);
  }

  if (method === 'DELETE' && segments[0] === 'recruiter' && segments[1] === 'approvals' && segments.length === 3) {
    const auth = await authOrThrow(request);
    return services.approvals.recruiterWithdrawApprovalRequest(auth, segments[2]);
  }

  if (method === 'GET' && path === '/recruiter/offers') {
    const auth = await authOrThrow(request);
    const url = new URL(request.url);
    return services.offers.recruiterGetOffers(auth, {
      state: url.searchParams.get('state') ?? undefined,
      college_id: url.searchParams.get('college_id') ?? undefined,
      department_id: url.searchParams.get('department_id') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
      job_id: url.searchParams.get('job_id') ?? undefined,
      role: url.searchParams.get('role') ?? undefined,
      search: url.searchParams.get('search') ?? undefined,
    });
  }

  if (method === 'GET' && segments[0] === 'recruiter' && segments[1] === 'offers' && segments.length === 3) {
    const auth = await authOrThrow(request);
    return services.offers.recruiterGetOffer(auth, segments[2]);
  }

  if (method === 'PATCH' && segments[0] === 'recruiter' && segments[1] === 'offers' && segments[3] === 'status') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.offers.recruiterUpdateOfferStatus(auth, segments[2], String(body.status ?? ''));
  }

  if ((method === 'POST' || method === 'PATCH') && segments[0] === 'recruiter' && segments[1] === 'offers' && segments[3] === 'revoke') {
    const auth = await authOrThrow(request);
    return services.offers.recruiterRevokeOffer(auth, segments[2]);
  }

  if (method === 'DELETE' && segments[0] === 'recruiter' && segments[1] === 'offers' && segments.length === 3) {
    const auth = await authOrThrow(request);
    return services.offers.recruiterRevokeOffer(auth, segments[2]);
  }

  if (method === 'GET' && path === '/notifications') {
    const auth = await authOrThrow(request);
    return services.notifications.getNotifications(auth);
  }

  if ((method === 'PUT' || method === 'POST') && segments[0] === 'notifications' && segments[2] === 'read') {
    const auth = await authOrThrow(request);
    return services.notifications.markNotificationRead(auth, Number(segments[1]));
  }

  if ((method === 'PUT' || method === 'POST') && path === '/notifications/read-all') {
    const auth = await authOrThrow(request);
    return services.notifications.markAllNotificationsRead(auth);
  }

  // ─── Announcements ──────────────────────────────────────────────────────────
  // Admin: create/update/delete own announcements
  if (method === 'POST' && path === '/announcements') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.social.createAnnouncement(auth, body);
  }

  if ((method === 'PATCH' || method === 'PUT') && segments[0] === 'announcements' && segments.length === 2) {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.social.updateAnnouncement(auth, segments[1], body);
  }

  if (method === 'DELETE' && segments[0] === 'announcements' && segments.length === 2) {
    const auth = await authOrThrow(request);
    const result = await services.social.deleteAnnouncement(auth, segments[1]);

    // Best-effort: remove the attached image from Supabase storage
    const imageUrl = typeof result.image_url === 'string' ? result.image_url.trim() : '';
    if (imageUrl) {
      try {
        const supabase = getSupabaseServerClient();
        const storageMatch = imageUrl.match(/\/storage\/v1\/object\/public\/([^/]+)\/(.+)/);
        if (storageMatch) {
          const bucket = storageMatch[1];
          const filePath = storageMatch[2]?.split('?')[0];
          if (bucket && filePath) {
            await supabase.storage.from(bucket).remove([filePath]);
          }
        }
      } catch {
        // Best-effort: do not fail the request if storage cleanup fails
      }
    }

    return { ok: true };
  }

  // GET /announcements — admin sees their college's; student sees filtered for their dept/batch
  if (method === 'GET' && path === '/announcements') {
    const auth = await authOrThrow(request);
    return services.social.listAnnouncementsForAdmin(auth);
  }

  // GET /student/announcements — student-scoped view (filtered by dept, batch, expiry)
  if (method === 'GET' && path === '/student/announcements') {
    const auth = await authOrThrow(request);
    return services.social.listAnnouncementsForStudent(auth);
  }

  if (method === 'GET' && segments[0] === 'announcements' && segments.length === 2) {
    const auth = await authOrThrow(request);
    return services.social.getAnnouncement(auth, segments[1]);
  }

  // Legacy /posts stub — returns empty so old cached calls don't 404
  if (method === 'GET' && path === '/posts') {
    return [];
  }

  if (method === 'POST' && path === '/support/issues') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    const created = await services.support.createSupportIssue(auth, validateSupportIssuePayload(body));
    logger.info('domain.support.issue.created', {
      module: 'support',
      userId: auth.uid,
    });
    return created;
  }


  if (method === 'GET' && path === '/support/issues/me') {
    const auth = await authOrThrow(request);
    return services.support.getMySupportIssues(auth);
  }

  if ((method === 'PATCH' || method === 'PUT') && segments[0] === 'support' && segments[1] === 'issues' && segments[3] === 'attachments' && segments.length === 4) {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.support.updateMySupportIssueAttachments(auth, segments[2], body?.attachment_urls);
  }

  if (method === 'POST' && path === '/support/feedback') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.support.createSupportFeedback(auth, body);
  }

  if (method === 'GET' && path === '/support/feedback/me') {
    const auth = await authOrThrow(request);
    return services.support.getMySupportFeedback(auth);
  }

  if (method === 'POST' && path === '/feedback/platform') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.support.submitPlatformFeedback(auth, body);
  }

  if (method === 'GET' && path === '/feedback/platform/me') {
    const auth = await authOrThrow(request);
    return services.support.fetchMyPlatformFeedback(auth);
  }




  if (method === 'GET' && path === '/admin/summary') {
    const auth = await authOrThrow(request);
    return services.analytics.adminSummary(auth);
  }

  if (method === 'GET' && path === '/admin/dashboard') {
    const auth = await authOrThrow(request);
    return services.analytics.adminDashboard(auth);
  }

  if (method === 'GET' && path === '/admin/dashboard/critical') {
    const auth = await authOrThrow(request);
    return services.analytics.adminDashboardCritical(auth);
  }

  if (method === 'GET' && path === '/admin/dashboard/secondary') {
    const auth = await authOrThrow(request);
    return services.analytics.adminDashboardSecondary(auth);
  }

  if (method === 'GET' && path === '/admin/users') {
    const auth = await authOrThrow(request);
    return services.admin.adminList(auth, 'users');
  }

  if (method === 'GET' && path === '/admin/recruiters') {
    const auth = await authOrThrow(request);
    return services.admin.adminList(auth, 'recruiters');
  }

  if (method === 'PATCH' && segments[0] === 'admin' && segments[1] === 'recruiters' && segments[3] === 'verify') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.admin.adminVerifyRecruiter(auth, segments[2], Boolean(body.verified));
  }

  if (method === 'DELETE' && segments[0] === 'admin' && segments[1] === 'recruiters' && segments.length === 3) {
    const auth = await authOrThrow(request);
    return services.admin.adminDeleteRecruiter(auth, segments[2]);
  }

  // ── Admin: alumni management ──────────────────────────────────────────────
  if (method === 'GET' && path === '/admin/alumni') {
    const auth = await authOrThrow(request);
    const url = new URL(request.url);
    const verified = url.searchParams.has('verified')
      ? url.searchParams.get('verified') === 'true'
      : undefined;
    const college_id = url.searchParams.get('college_id') ?? undefined;
    return services.admin.adminListAlumni(auth, { verified, college_id });
  }

  if (method === 'POST' && path === '/admin/alumni') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.admin.adminCreateAlumni(auth, body);
  }

  if (method === 'PATCH' && segments[0] === 'admin' && segments[1] === 'alumni' && segments[3] === 'verify') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.admin.adminVerifyAlumni(auth, segments[2], Boolean(body.verified));
  }

  if (method === 'GET' && path === '/admin/students') {
    const auth = await authOrThrow(request);
    const url = new URL(request.url);
    const departmentId = url.searchParams.get('department_id') ?? undefined;
    return services.admin.adminStudents(auth, { departmentId });
  }

  if (method === 'GET' && path === '/admin/companies/search') {
    const auth = await authOrThrow(request);
    const url = new URL(request.url);
    const companyQuery = url.searchParams.get('q') ?? url.searchParams.get('query') ?? undefined;
    return services.jobs.adminSearchCompanies(auth, companyQuery);
  }

  if (method === 'GET' && path === '/admin/companies') {
    const auth = await authOrThrow(request);
    return services.admin.adminList(auth, 'companies');
  }

  if (method === 'POST' && path === '/admin/companies') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.profiles.createMyCompany(auth, body);
  }

  if (method === 'POST' && path === '/admin/companies/extract-text') {
    const auth = await authOrThrow(request);
    void auth;
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      throw new AppError('file is required', 400);
    }

    if (file.size > 10 * 1024 * 1024) {
      throw new AppError('File must be 10MB or smaller', 400);
    }

    const fileName = file.name?.toLowerCase() ?? '';
    const fileType = file.type?.toLowerCase() ?? '';
    const buffer = Buffer.from(await file.arrayBuffer());

    if (fileType.includes('pdf') || fileName.endsWith('.pdf')) {
      try {
        const pdfParseModule = await import('pdf-parse/lib/pdf-parse.js');
        const pdfParse = (pdfParseModule as { default?: unknown }).default as
          | ((input: Buffer) => Promise<{ text?: string }>)
          | undefined;
        if (typeof pdfParse !== 'function') {
          throw new Error('pdf-parse function export not found');
        }
        const parsed = await pdfParse(buffer);
        return { text: typeof parsed?.text === 'string' ? parsed.text : '' };
      } catch (error) {
        throw new AppError(`Failed to extract PDF text: ${extractErrorMessage(error)}`, 400, error);
      }
    }

    if (fileType.startsWith('text/') || fileName.endsWith('.txt')) {
      return { text: buffer.toString('utf8') };
    }

    throw new AppError('Unsupported file type for text extraction. Upload a PDF or TXT file.', 400);
  }

  if (method === 'POST' && path === '/admin/companies/autofill') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);

    const rawText = String(body.raw_text ?? '').trim();
    if (!rawText) {
      return { error: 'raw_text is required' };
    }

    const coerceString = (v: unknown): string | null => {
      if (v === null || v === undefined) return null;
      const s = String(v).trim();
      const lower = s.toLowerCase();
      if (!s || lower === 'null' || lower === 'n/a' || lower === 'none' || lower === 'not mentioned' || lower === 'not specified') return null;
      return s;
    };

    try {
      const parserRes = await fetch('http://localhost:8080/api/pipeline/parse-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: rawText, type: 'company' }),
      });

      if (!parserRes.ok) {
        const errText = await parserRes.text();
        return { error: `Parser service error (HTTP ${parserRes.status}): ${errText.slice(0, 300)}` };
      }

      const parsed = await parserRes.json() as Record<string, unknown>;

      const result = {
        company_name:  coerceString(parsed.name),
        recruiter_name: null,
        email:         coerceString(parsed.company_email),
        contact_number: null,
        linkedin:      coerceString(parsed.linkedin_url),
        description:   coerceString(parsed.description),
        website:       coerceString(parsed.website),
        location:      coerceString(parsed.location),
        industry:      coerceString(parsed.industry),
        top_ctc:       coerceString(parsed.top_ctc),
      };

      logger.info('admin.companies.autofill.success', {
        module: 'companies',
        endpoint: '/admin/companies/autofill',
        userId: auth.uid,
        result,
      });

      return result;
    } catch (fetchError) {
      const msg = fetchError instanceof Error ? fetchError.message : String(fetchError);
      logger.error('admin.companies.autofill.fetch_error', {
        module: 'companies',
        endpoint: '/admin/companies/autofill',
        userId: auth.uid,
        error: msg,
      });
      return { error: `Autofill error: ${msg}` };
    }
  }

  if (method === 'POST' && path === '/admin/approvals/extract-text') {
    const auth = await authOrThrow(request);
    void auth;
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      throw new AppError('file is required', 400);
    }

    if (file.size > 10 * 1024 * 1024) {
      throw new AppError('File must be 10MB or smaller', 400);
    }

    const fileName = file.name?.toLowerCase() ?? '';
    const fileType = file.type?.toLowerCase() ?? '';
    const buffer = Buffer.from(await file.arrayBuffer());

    if (fileType.includes('pdf') || fileName.endsWith('.pdf')) {
      try {
        const pdfParseModule = await import('pdf-parse/lib/pdf-parse.js');
        const pdfParse = (pdfParseModule as { default?: unknown }).default as
          | ((input: Buffer) => Promise<{ text?: string }>)
          | undefined;
        if (typeof pdfParse !== 'function') {
          throw new Error('pdf-parse function export not found');
        }
        const parsed = await pdfParse(buffer);
        return { text: typeof parsed?.text === 'string' ? parsed.text : '' };
      } catch (error) {
        throw new AppError(`Failed to extract PDF text: ${extractErrorMessage(error)}`, 400, error);
      }
    }

    if (fileType.startsWith('text/') || fileName.endsWith('.txt')) {
      return { text: buffer.toString('utf8') };
    }

    throw new AppError('Unsupported file type for text extraction. Upload a PDF or TXT file.', 400);
  }
  if (method === 'POST' && path === '/admin/jobs/autofill') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);

    const rawText = String(body.raw_text ?? '').trim();
    if (!rawText) {
      return { error: 'raw_text is required' };
    }

    // Hardcoded test override for development.
    // Replace the rawText string below with the exact sample text you want to hardcode.
    const getHardcodedAutofill = (text: string) => {
      if (text === 'TEST') {
        return {
  "company_name": "Flexera",
  "recruiter_email": null,
  "role": "Software Engineer",
  "description": "We are looking for highly motivated Engineering Graduates with a strong foundation in Computer Science fundamentals to join our engineering team. The selected candidates will work closely with experienced engineers and gain hands-on exposure to real-world software development, testing, and engineering practices in a collaborative environment.",
  "location": "Bengaluru, Karnataka",
  "mode_of_work": "office",
  "ctc": null,
  "stipend": null,
  "min_cgpa": 7.5,
  "allowed_backlogs": 0,
  "eligible_departments": [
    {
      "department": "CSE",
      "specialisation": null
    },
    {
      "department": "ISE",
      "specialisation": null
    },
    {
      "department": "IT",
      "specialisation": null
    },
    {
      "department": "AI/ML",
      "specialisation": null
    },
    {
      "department": "Data Science",
      "specialisation": null
    },
    {
      "department": "AI",
      "specialisation": null
    },
    {
      "department": "ML",
      "specialisation": null
    },
    {
      "department": "CSE",
      "specialisation": "Data Science"
    }
  ],
  "eligible_batch_years": [
    {
      "year": 2026
    }
  ],
  "skills_required": {
    "technical": [
      "Strong understanding of Computer Science fundamentals",
      "Data Structures & Algorithms",
      "Object-Oriented Programming concepts",
      "Basic knowledge of anyone programming language such as Java / Python / C / C++ / .NET (or similar)",
      "Willingness to learn new technologies and tools"
    ],
    "soft_skills": [
      "Good analytical and problem-solving skills",
      "Good communication and teamwork skills"
    ]
  },
  "preferred_skills": null,
  "is_internship": true,
  "ppo_available": false,
  "service_agreement": false,
  "bond_period_months": null,
  "total_rounds": 3,
  "round_details": [
    {
      "round": 1,
      "name": "Online Test / Technical Assessment"
    },
    {
      "round": 2,
      "name": "Technical Interview"
    },
    {
      "round": 3,
      "name": "HR Round"
    }
  ],
  "current_deadline": null,
  "openings": 10,
  "application_count": null,
  "application_link": null,
  "contact_email": null,
  "contact_phone": null,
  "additional_information": "Candidates must be willing to work from office as per business requirements | Final selection is subject to verification of academic records"
};
      }
      return null;
    };

    if (process.env.NODE_ENV === 'development') {
      const hardcoded = getHardcodedAutofill(rawText);
      if (hardcoded) {
        return hardcoded;
      }
    }

    // Helper coercions
    const coerceString = (v: unknown): string | null => {
      if (v === null || v === undefined) return null;
      const s = String(v).trim();
      const lower = s.toLowerCase();
      if (!s || lower === 'null' || lower === 'n/a' || lower === 'none' || lower === 'not mentioned' || lower === 'not specified') return null;
      return s;
    };

    const coerceNumber = (v: unknown): number | null => {
      if (v === null || v === undefined) return null;
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string') {
        const s = v.trim();
        if (!s || s.toLowerCase() === 'null' || s.toLowerCase() === 'n/a') return null;
        // Handle range like "9 – 14" or "9-14" or "9 to 14" → take max
        const rangeMatch = s.match(/([\d.]+)\s*(?:[-–—]|to)\s*([\d.]+)/i);
        if (rangeMatch) {
          const a = parseFloat(rangeMatch[1]);
          const b = parseFloat(rangeMatch[2]);
          const max = Math.max(a, b);
          if (Number.isFinite(max)) return max;
        }
        const numMatch = s.match(/[\d.]+/);
        if (numMatch) {
          const n = parseFloat(numMatch[0]);
          if (Number.isFinite(n)) return n;
        }
      }
      return null;
    };

    const coerceInt = (v: unknown): number | null => {
      const n = coerceNumber(v);
      return n === null ? null : Math.round(n);
    };

    const coerceBool = (v: unknown, fallback = false): boolean => {
      if (typeof v === 'boolean') return v;
      if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        if (s === 'true' || s === 'yes') return true;
        if (s === 'false' || s === 'no') return false;
      }
      return fallback;
    };

    const normalizeMode = (v: unknown): 'office' | 'wfh' | 'hybrid' | null => {
      const s = coerceString(v)?.toLowerCase() ?? null;
      if (!s) return null;
      if (s.includes('office') || s.includes('onsite') || s.includes('on-site') || s.includes('on_site') || s === 'wfo') return 'office';
      if (s.includes('home') || s.includes('remote') || s === 'wfh') return 'wfh';
      if (s.includes('hybrid')) return 'hybrid';
      return null;
    };

    const normalizeEmploymentType = (v: unknown): 'full_time' | 'part_time' | 'contract' | 'internship' | null => {
      const s = coerceString(v)?.toLowerCase() ?? null;
      if (!s) return null;
      if (s.includes('full') || s.includes('permanent')) return 'full_time';
      if (s.includes('intern')) return 'internship';
      if (s.includes('contract')) return 'contract';
      if (s.includes('part')) return 'part_time';
      return null;
    };

    try {
      const parserRes = await fetch('http://localhost:8080/api/pipeline/parse-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: rawText, type: 'job' }),
      });

      if (!parserRes.ok) {
        const errText = await parserRes.text();
        return { error: `Parser service error (HTTP ${parserRes.status}): ${errText.slice(0, 300)}` };
      }

      const parsed = await parserRes.json() as Record<string, unknown>;

      const modeMap: Record<string, 'office' | 'wfh' | 'hybrid'> = {
        'Office': 'office',
        'Work From Home': 'wfh',
        'Hybrid': 'hybrid',
      };

      const isInternship = coerceBool(parsed.is_internship, false);
      const employmentType = normalizeEmploymentType(parsed.employment_type)
        ?? (isInternship ? 'internship' : null);

      const skillsRaw = parsed.skills_required;
      let skillsFlat: string[] = [];
      if (skillsRaw && typeof skillsRaw === 'object' && !Array.isArray(skillsRaw)) {
        const obj = skillsRaw as Record<string, unknown>;
        const tech = Array.isArray(obj.technical) ? (obj.technical as unknown[]).map(String) : [];
        const soft = Array.isArray(obj.soft_skills) ? (obj.soft_skills as unknown[]).map(String) : [];
        skillsFlat = [...tech, ...soft].filter(Boolean);
      } else if (Array.isArray(skillsRaw)) {
        skillsFlat = (skillsRaw as unknown[]).map(String).filter(Boolean);
      }

      const result = {
        role:                   coerceString(parsed.role),
        description:            coerceString(parsed.description),
        location:               coerceString(parsed.location),
        ctc:                    coerceNumber(parsed.ctc),
        min_cgpa:               coerceNumber(parsed.min_cgpa),
        allowed_backlogs:       coerceInt(parsed.allowed_backlogs),
        skills_required:        skillsFlat,
        mode_of_work:           typeof parsed.mode_of_work === 'string'
                                  ? (modeMap[parsed.mode_of_work] ?? normalizeMode(parsed.mode_of_work))
                                  : null,
        is_internship:          isInternship,
        employment_type:        employmentType,
        stipend:                coerceString(parsed.stipend),
        preferred_skills:       Array.isArray(parsed.preferred_skills)
                                  ? (parsed.preferred_skills as unknown[]).map(String).filter(Boolean)
                                  : null,
        eligible_departments:   parsed.eligible_departments ?? null,
        eligible_batch_years:   parsed.eligible_batch_years ?? null,
        service_agreement:      coerceBool(parsed.service_agreement, false),
        bond_period_months:     coerceInt(parsed.bond_period_months),
        current_deadline:       coerceString(parsed.current_deadline),
        total_openings:         coerceInt(parsed.openings ?? parsed.total_openings),
        application_link:       coerceString(parsed.application_link),
        contact_email:          coerceString(parsed.contact_email),
        contact_phone:          coerceString(parsed.contact_phone),
        ppo_available:          coerceBool(parsed.ppo_available, false),
        round_details:          parsed.round_details ?? null,
        job_source:             null as string | null,
        college_id:             null as string | null,
        referral_id:            null as string | null,
        diversity_hiring:       null as Record<string, boolean> | null,
        auto_generate_excel:    false,
        excel_template_url:     null as string | null,
        status:                 null as 'open' | 'closed' | 'draft' | null,
        additional_information: coerceString(parsed.additional_information),
        company_name:           coerceString(parsed.company_name),
        total_rounds:           coerceInt(parsed.total_rounds),
      };

      logger.info('admin.jobs.autofill.success', {
        module: 'jobs',
        endpoint: '/admin/jobs/autofill',
        userId: auth.uid,
        result,
      });

      return result;
    } catch (fetchError) {
      const msg = fetchError instanceof Error ? fetchError.message : String(fetchError);
      logger.error('admin.jobs.autofill.fetch_error', {
        module: 'jobs',
        endpoint: '/admin/jobs/autofill',
        userId: auth.uid,
        error: msg,
      });
      return { error: `Autofill error: ${msg}` };
    }
  }

  if (method === 'POST' && path === '/admin/jobs/parse-email') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);

    const messageId = String(body.messageId ?? '').trim();
    const threadId = String(body.threadId ?? '').trim();
    const cleanedText = String(body.cleaned_text ?? '').trim();
    const sourceEmail = String(body.source_email ?? '').trim();

    if (!messageId) throw new AppError('messageId is required', 400);
    if (!cleanedText) throw new AppError('cleaned_text is required', 400);

    // Resolve admin's DB UUID and college_id from Firebase UID
    const supabase = getSupabaseServerClient();
    const { data: adminRow, error: adminLookupErr } = await supabase
      .from('admins')
      .select('id, college_id')
      .eq('user_id', auth.uid)
      .maybeSingle();

    if (adminLookupErr || !adminRow) {
      // Fallback: try lookup by email
      const { data: adminByEmail } = auth.email
        ? await supabase
            .from('admins')
            .select('id, college_id')
            .ilike('email', auth.email)
            .maybeSingle()
        : { data: null };

      if (!adminByEmail) {
        throw new AppError('Admin profile not found — ensure this Firebase user has an admin record', 403);
      }
      Object.assign(adminRow ?? {}, adminByEmail);
    }

    const resolvedAdmin = (adminRow ?? {}) as { id?: string; college_id?: string | null };
    const resolvedAdminId = String(resolvedAdmin.id ?? '').trim();
    const resolvedCollegeId = resolvedAdmin.college_id ? String(resolvedAdmin.college_id) : null;

    if (!resolvedAdminId) {
      throw new AppError('Admin profile not found — ensure this Firebase user has an admin record', 403);
    }

    try {
      const result = await createJobFromParsedData(
        { messageId, threadId, sourceEmail, cleanedText },
        resolvedAdminId,
        resolvedCollegeId,
      );

      if (result.alreadyProcessed) {
        return {
          success: false,
          reason: 'Already processed',
          job_id: result.jobId,
          company_id: result.companyId,
          created: false,
        };
      }

      logger.info('admin.jobs.parse-email.success', {
        module: 'jobs',
        endpoint: '/admin/jobs/parse-email',
        userId: auth.uid,
        jobId: result.jobId,
        companyId: result.companyId,
      });

      return {
        success: true,
        job_id: result.jobId,
        company_id: result.companyId,
        created: true,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      logger.error('admin.jobs.parse-email.error', {
        module: 'jobs',
        endpoint: '/admin/jobs/parse-email',
        userId: auth.uid,
        messageId,
        error: msg,
      });

      // Best-effort: log failed parse in audit_logs
      try {
        await supabase.from('audit_logs').insert({
          actor_user_id: resolvedAdminId,
          actor_category: 'admin',
          action: 'email.job.parse_failed',
          title: 'Email job parse failed',
          description: msg,
          entity_type: 'email',
          entity_id: messageId,
          metadata: { message_id: messageId, source_email: sourceEmail, error: msg },
          created_at: new Date().toISOString(),
        });
      } catch { /* non-critical */ }

      throw err instanceof AppError ? err : new AppError(`Email parse pipeline failed: ${msg}`, 500);
    }
  }

  if (method === 'POST' && path === '/admin/approvals/autofill') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);

    const rawText = String(body.raw_text ?? '').trim();
    if (!rawText) {
      return { error: 'raw_text is required' };
    }

    const coerceString = (v: unknown): string | null => {
      if (v === null || v === undefined) return null;
      const s = String(v).trim();
      const lower = s.toLowerCase();
      if (!s || lower === 'null' || lower === 'n/a' || lower === 'none' || lower === 'not mentioned' || lower === 'not specified') return null;
      return s;
    };

    const coerceNumber = (v: unknown): number | null => {
      if (v === null || v === undefined) return null;
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string') {
        const s = v.trim();
        if (!s || s.toLowerCase() === 'null' || s.toLowerCase() === 'n/a') return null;
        const numMatch = s.match(/[\d.]+/);
        if (numMatch) {
          const n = parseFloat(numMatch[0]);
          if (Number.isFinite(n)) return n;
        }
      }
      return null;
    };

    const coerceInt = (v: unknown): number | null => {
      const n = coerceNumber(v);
      return n === null ? null : Math.round(n);
    };

    const normalizeMode = (v: unknown): 'online' | 'offline' | null => {
      const s = coerceString(v)?.toLowerCase() ?? null;
      if (!s) return null;
      if (s.includes('offline') || s.includes('in-person') || s.includes('in person') || s.includes('campus')) return 'offline';
      if (s.includes('online') || s.includes('virtual') || s.includes('remote')) return 'online';
      return null;
    };

    const normalizeSuggestedDates = (v: unknown): string[] => {
      if (Array.isArray(v)) {
        return v.map((entry) => String(entry ?? '').trim()).filter(Boolean);
      }
      if (typeof v === 'string') {
        return v.split(/[,;\n]/).map((entry) => entry.trim()).filter(Boolean);
      }
      return [];
    };

    try {
      const parserRes = await fetch('http://localhost:8080/api/pipeline/parse-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: rawText, type: 'approval' }),
      });

      if (!parserRes.ok) {
        const errText = await parserRes.text();
        return { error: `Parser service error (HTTP ${parserRes.status}): ${errText.slice(0, 300)}` };
      }

      const parsed = await parserRes.json() as Record<string, unknown>;

      // Extract round label from parser's jsonb round field
      const roundRaw = parsed.round as Record<string, unknown> | null | undefined;
      let roundLabel: string | null = null;
      if (roundRaw && typeof roundRaw === 'object') {
        const details = Array.isArray(roundRaw.details) ? roundRaw.details as Array<Record<string, unknown>> : [];
        if (details.length > 0) {
          roundLabel = coerceString(details[0].name ?? details[0].round);
        } else {
          roundLabel = coerceInt(roundRaw.total) !== null ? `Round ${roundRaw.total}` : null;
        }
      } else if (typeof roundRaw === 'string') {
        roundLabel = roundRaw || null;
      }

      // Convert ISO datetimes to YYYY-MM-DD dates
      const suggestedDates = normalizeSuggestedDates(parsed.suggested_dates_with_time).map((d) => {
        const match = d.match(/^(\d{4}-\d{2}-\d{2})/);
        return match ? match[1] : d;
      });

      const result = {
        company_name:         null as string | null,
        job_role:             null as string | null,
        round:                roundLabel,
        capacity:             coerceInt(parsed.capacity),
        panel:                coerceInt(parsed.panel),
        mode:                 normalizeMode(parsed.mode),
        suggested_dates:      suggestedDates,
        preferred_start_time: null as string | null,
        preferred_end_time:   null as string | null,
        location:             coerceString(parsed.location),
      };

      logger.info('admin.approvals.autofill.success', {
        module: 'approvals',
        endpoint: '/admin/approvals/autofill',
        userId: auth.uid,
        result,
      });

      return result;
    } catch (fetchError) {
      const msg = fetchError instanceof Error ? fetchError.message : String(fetchError);
      logger.error('admin.approvals.autofill.fetch_error', {
        module: 'approvals',
        endpoint: '/admin/approvals/autofill',
        userId: auth.uid,
        error: msg,
      });
      return { error: `Autofill error: ${msg}` };
    }
  }

  if (method === 'POST' && path === '/admin/jobs') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.jobs.adminCreateJob(auth, body);
  }

  if (method === 'GET' && path === '/admin/jobs') {
    const auth = await authOrThrow(request);
    const url = new URL(request.url);
    return services.admin.adminJobsExplorer(auth, {
      search: url.searchParams.get('search') ?? undefined,
      department_id: url.searchParams.get('department_id') ?? undefined,
      job_type: url.searchParams.get('job_type') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
      upcoming_rounds: url.searchParams.get('upcoming_rounds') === 'true' ? true : undefined,
      company_id: url.searchParams.get('company_id') ?? undefined,
      page: url.searchParams.has('page') ? Number(url.searchParams.get('page')) : undefined,
      page_size: url.searchParams.has('page_size') ? Number(url.searchParams.get('page_size')) : undefined,
    });
  }

  if (method === 'GET' && segments[0] === 'admin' && segments[1] === 'jobs' && segments.length === 3) {
    const auth = await authOrThrow(request);
    const url = new URL(request.url);
    return services.admin.adminJobDetails(auth, segments[2], {
      search: url.searchParams.get('search') ?? undefined,
      department_id: url.searchParams.get('department_id') ?? undefined,
      round: url.searchParams.get('round') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
      skills_match_min: url.searchParams.has('skills_match_min') ? Number(url.searchParams.get('skills_match_min')) : undefined,
      cgpa_min: url.searchParams.has('cgpa_min') ? Number(url.searchParams.get('cgpa_min')) : undefined,
      cgpa_max: url.searchParams.has('cgpa_max') ? Number(url.searchParams.get('cgpa_max')) : undefined,
      page: url.searchParams.has('page') ? Number(url.searchParams.get('page')) : undefined,
      page_size: url.searchParams.has('page_size') ? Number(url.searchParams.get('page_size')) : undefined,
    });
  }

  if (
    method === 'GET' &&
    segments[0] === 'admin' &&
    segments[1] === 'jobs' &&
    segments.length === 5 &&
    segments[3] === 'applicants' &&
    segments[4] === 'export'
  ) {
    const auth = await authOrThrow(request);
    const url = new URL(request.url);
    return services.admin.adminExportJobApplicants(auth, segments[2], {
      search: url.searchParams.get('search') ?? undefined,
      department_id: url.searchParams.get('department_id') ?? undefined,
      round: url.searchParams.get('round') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
      skills_match_min: url.searchParams.has('skills_match_min') ? Number(url.searchParams.get('skills_match_min')) : undefined,
      cgpa_min: url.searchParams.has('cgpa_min') ? Number(url.searchParams.get('cgpa_min')) : undefined,
      cgpa_max: url.searchParams.has('cgpa_max') ? Number(url.searchParams.get('cgpa_max')) : undefined,
    });
  }

  if (method === 'GET' && path === '/admin/attendance/options') {
    const auth = await authOrThrow(request);
    return services.drives.fetchDriveCreationOptionsForCollege(auth);
  }

  if (method === 'GET' && path === '/admin/attendance/drives') {
    const auth = await authOrThrow(request);
    const url = new URL(request.url);
    return services.drives.fetchPlacementDrivesForCollege(auth, url.searchParams.get('tab') ?? undefined);
  }

  if (method === 'GET' && path === '/admin/placement-reports') {
    const auth = await authOrThrow(request);
    return services.analytics.adminGetPlacementReports(auth);
  }

  if (method === 'GET' && segments[0] === 'admin' && segments[1] === 'placement-reports' && segments.length === 4 && segments[3] === 'pdf') {
    try {
      const auth = await authOrThrow(request);
      const report = await services.analytics.adminGetPlacementReportById(auth, segments[2]);
      const pdfBuffer = await createPlacementReportPdf(report as PlacementReportRow);
      await storePlacementReportPdf(report as PlacementReportRow, pdfBuffer);
      const fileName = `placement-report-${report.year}.pdf`;

      return new Response(new Uint8Array(pdfBuffer), {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename=\"${fileName}\"`,
          'Cache-Control': 'no-store',
        },
      });
    } catch (error) {
      throw new AppError(`Failed to generate placement report PDF: ${extractErrorMessage(error)}`, 500, error);
    }
  }

  if (method === 'POST' && path === '/admin/placement-reports/generate') {
    const auth = await authOrThrow(request);
    return services.analytics.adminGeneratePlacementReport(auth);
  }

  if (method === 'GET' && segments[0] === 'admin' && segments[1] === 'placement-reports' && segments.length === 4 && segments[3] === 'companies') {
    const auth = await authOrThrow(request);
    return services.analytics.adminGetPlacementReportCompanies(auth, segments[2]);
  }

  if (method === 'POST' && path === '/admin/attendance/drives') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.drives.createPlacementDrive(auth, body);
  }

  if (method === 'GET' && segments[0] === 'admin' && segments[1] === 'attendance' && segments[2] === 'drives' && segments.length === 4) {
    const auth = await authOrThrow(request);
    return services.drives.fetchPlacementDriveById(auth, segments[3]);
  }

  if (method === 'PATCH' && segments[0] === 'admin' && segments[1] === 'attendance' && segments[2] === 'drives' && segments.length === 4) {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.drives.updatePlacementDrive(auth, segments[3], body);
  }

  if (method === 'DELETE' && segments[0] === 'admin' && segments[1] === 'attendance' && segments[2] === 'drives' && segments.length === 4) {
    const auth = await authOrThrow(request);
    return services.drives.deletePlacementDrive(auth, segments[3]);
  }

  if (
    method === 'GET' &&
    segments[0] === 'admin' &&
    segments[1] === 'attendance' &&
    segments[2] === 'drives' &&
    segments.length === 5 &&
    segments[4] === 'participants'
  ) {
    const auth = await authOrThrow(request);
    const url = new URL(request.url);
    return services.drives.fetchDriveParticipants(auth, segments[3], {
      search: url.searchParams.get('search') ?? undefined,
      department_id: url.searchParams.get('department_id') ?? undefined,
      attendance_status: url.searchParams.get('attendance_status') ?? undefined,
      application_status: url.searchParams.get('application_status') ?? undefined,
      scope: url.searchParams.get('scope') ?? undefined,
    });
  }

  if (
    method === 'POST' &&
    segments[0] === 'admin' &&
    segments[1] === 'attendance' &&
    segments[2] === 'drives' &&
    segments.length === 5 &&
    segments[4] === 'announcement'
  ) {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.drives.sendPlacementDriveAnnouncement(auth, segments[3], body);
  }

  if (
    method === 'GET' &&
    segments[0] === 'admin' &&
    segments[1] === 'attendance' &&
    segments[2] === 'drives' &&
    segments.length === 5 &&
    segments[4] === 'attendance'
  ) {
    const auth = await authOrThrow(request);
    return services.drives.fetchDriveAttendance(auth, segments[3]);
  }

  if (
    method === 'POST' &&
    segments[0] === 'admin' &&
    segments[1] === 'attendance' &&
    segments[2] === 'drives' &&
    segments.length === 5 &&
    segments[4] === 'attendance'
  ) {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.drives.upsertDriveAttendance(auth, segments[3], body);
  }

  // New per-student mark API matching the one-row-per-drive jsonb-bucket shape.
  // Body: { student_id, attendance_status: 'present'|'absent'|'excused', excuse_reason? }
  if (
    method === 'POST' &&
    segments[0] === 'admin' &&
    segments[1] === 'attendance' &&
    segments[2] === 'drives' &&
    segments.length === 5 &&
    segments[4] === 'mark'
  ) {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.drives.markStudentAttendance(auth, segments[3], body);
  }

  if (
    method === 'GET' &&
    segments[0] === 'admin' &&
    segments[1] === 'attendance' &&
    segments[2] === 'drives' &&
    segments.length === 5 &&
    segments[4] === 'summary'
  ) {
    const auth = await authOrThrow(request);
    return services.drives.fetchDriveAttendanceSummary(auth, segments[3]);
  }

  if (
    method === 'GET' &&
    segments[0] === 'admin' &&
    segments[1] === 'attendance' &&
    segments[2] === 'drives' &&
    segments.length === 5 &&
    segments[4] === 'export'
  ) {
    const auth = await authOrThrow(request);
    const url = new URL(request.url);
    return services.drives.exportDriveAttendance(auth, segments[3], {
      search: url.searchParams.get('search') ?? undefined,
      department_id: url.searchParams.get('department_id') ?? undefined,
      attendance_status: url.searchParams.get('attendance_status') ?? undefined,
      application_status: url.searchParams.get('application_status') ?? undefined,
    });
  }

  if (method === 'GET' && path === '/admin/attendance/reports') {
    const auth = await authOrThrow(request);
    const url = new URL(request.url);
    return services.drives.fetchAttendanceReportsForCollege(auth, {
      company_id: url.searchParams.get('company_id') ?? undefined,
    });
  }

  if (method === 'GET' && path === '/admin/applications') {
    const auth = await authOrThrow(request);
    return services.admin.adminList(auth, 'applications');
  }

  if (method === 'GET' && path === '/admin/interviews') {
    const auth = await authOrThrow(request);
    return services.admin.adminList(auth, 'interviews');
  }

  if (method === 'GET' && path === '/admin/offers') {
    const auth = await authOrThrow(request);
    return services.admin.adminList(auth, 'offers');
  }

  if (method === 'GET' && path === '/admin/approvals') {
    const auth = await authOrThrow(request);
    return services.approvals.adminGetApprovals(auth);
  }

  if (method === 'POST' && path === '/admin/approvals') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.approvals.adminCreateApprovalRequest(auth, body);
  }

  if (method === 'PATCH' && segments[0] === 'admin' && segments[1] === 'approvals' && segments[3] === 'status') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.approvals.adminUpdateApprovalStatus(auth, segments[2], String(body.status ?? ''), {
      suggested_dates_with_time: Array.isArray(body.suggested_dates_with_time) ? body.suggested_dates_with_time : undefined,
      suggested_date: typeof body.suggested_date === 'string' ? body.suggested_date : undefined,
    });
  }

  if (method === 'PATCH' && segments[0] === 'admin' && segments[1] === 'approvals' && segments[3] === 'suggest-date') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.approvals.adminSuggestApprovalDate(auth, segments[2], {
      suggested_dates_with_time: Array.isArray(body.suggested_dates_with_time) ? body.suggested_dates_with_time : undefined,
      suggested_dates: Array.isArray(body.suggested_dates) ? body.suggested_dates : undefined,
      preferred_start_time: typeof body.preferred_start_time === 'string' ? body.preferred_start_time : undefined,
    });
  }

  if (method === 'PATCH' && segments[0] === 'admin' && segments[1] === 'applications' && segments[3] === 'status') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.applications.recruiterUpdateApplicationStatus(
      auth,
      segments[2],
      String(body.status ?? ''),
      typeof body.current_round === 'number' || typeof body.current_round === 'string'
        ? body.current_round
        : undefined,
    );
  }

  if (method === 'PATCH' && segments[0] === 'admin' && segments[1] === 'applications' && segments[3] === 'reinstate') {
    const auth = await authOrThrow(request);
    return services.applications.recruiterReinstateApplication(auth, segments[2]);
  }

  if (method === 'GET' && path === '/admin/support/issues') {
    const auth = await authOrThrow(request);
    return services.support.adminGetSupportIssues(auth);
  }

  if (method === 'GET' && path === '/admin/support/issues/me') {
    const auth = await authOrThrow(request);
    return services.support.adminGetMySupportIssues(auth);
  }

  if (method === 'POST' && path === '/admin/support/issues') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    const created = await services.support.adminCreateSupportIssue(auth, validateSupportIssuePayload(body));
    logger.info('domain.support.issue.created', {
      module: 'support',
      userId: auth.uid,
      role: 'admin',
    });
    return created;
  }

  if (method === 'POST' && path === '/admin/support/feedback') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.support.adminCreateSupportFeedback(auth, body);
  }

  if (method === 'PATCH' && segments[0] === 'admin' && segments[1] === 'support' && segments[2] === 'issues' && segments[4] === 'status') {
    const auth = await authOrThrow(request);
    const body = await parseJsonBody(request);
    return services.support.adminUpdateSupportIssueStatus(
      auth,
      segments[3],
      String(body.status ?? ''),
      typeof body.response === 'string' ? body.response : undefined,
    );
  }

  if (method === 'GET' && path === '/admin/support/feedback') {
    const auth = await authOrThrow(request);
    return services.support.adminGetSupportFeedback(auth);
  }

  throw new AppError('Endpoint not found', 404);
};
