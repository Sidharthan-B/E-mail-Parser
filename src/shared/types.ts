export type SectionMap = {
  eligibility_section?: string;
  compensation_section?: string;
  skills_section?: string;
  job_description_section?: string;
  dates_section?: string;
  registration_section?: string;
};

export type EligibleDepartment = {
  department: string;
  category: "core" | "circuit" | "specialization" | "degree" | "other";
};

export type EligibleBatchYear = {
  year?: number;
  label?: string;
};

export type SkillGroup = {
  technical: string[];
  soft_skills: string[];
};

export type RoundDetail = {
  round: number;
  name: string;
};

export type RecruiterEntity = {
  company_name: string | null;
  recruiter_email: string | null;
  role: string;
  description: string | null;
  location: string | null;
  mode_of_work: string | null;
  ctc: string | null;
  stipend: string | null;
  min_cgpa: number | null;
  allowed_backlogs: number | null;
  eligible_departments: EligibleDepartment[] | null;
  eligible_batch_years: EligibleBatchYear[] | null;
  skills_required: SkillGroup | null;
  preferred_skills: SkillGroup | null;
  is_internship: boolean | null;
  ppo_available: boolean | null;
  service_agreement: boolean | null;
  bond_period_months: number | null;
  total_rounds: number;
  round_details: RoundDetail[];
  current_deadline: number | null;
  total_positions: number | null;
  application_link: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  additional_information: string | null;
  job_source: string | null;
};

export type ParsedAttachment = {
  fileName: string;
  mimeType: string;
  text: string;
};

export type ParsedEmail = {
  messageId: string;
  threadId: string;
  subject: string;
  sender: string;
  recipients: string[];
  html: string;
  text: string;
  cleanedText: string;
  attachments: ParsedAttachment[];
};
