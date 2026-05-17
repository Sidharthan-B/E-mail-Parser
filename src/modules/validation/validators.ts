import { RecruiterEntity, RoundDetail } from "../../shared/types";

function validNumber(value: number | null, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function cleanString(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function cleanRounds(rounds: RoundDetail[]): RoundDetail[] {
  return rounds
    .filter((round) => round.name?.trim())
    .map((round, index) => ({ round: index + 1, name: round.name.trim() }));
}

export function validateRecruiterEntity(entity: RecruiterEntity): RecruiterEntity {
  entity.company_name = cleanString(entity.company_name);
  entity.recruiter_email = cleanString(entity.recruiter_email);
  entity.role = cleanString(entity.role) ?? "Unknown Role";
  entity.description = cleanString(entity.description);
  entity.location = cleanString(entity.location);
  entity.mode_of_work = entity.mode_of_work && ["Remote", "Hybrid", "Onsite"].includes(entity.mode_of_work) ? entity.mode_of_work : null;
  entity.ctc = cleanString(entity.ctc);
  entity.stipend = cleanString(entity.stipend);
  entity.min_cgpa = validNumber(entity.min_cgpa, 0, 10);
  entity.allowed_backlogs = validNumber(entity.allowed_backlogs, 0, 50);
  entity.eligible_departments = entity.eligible_departments?.length ? entity.eligible_departments : null;
  entity.eligible_batch_years = entity.eligible_batch_years?.length ? entity.eligible_batch_years : null;
  entity.skills_required = entity.skills_required ?? { technical: [], soft_skills: [] };
  entity.preferred_skills = entity.preferred_skills?.technical.length || entity.preferred_skills?.soft_skills.length ? entity.preferred_skills : null;
  entity.is_internship = entity.is_internship ?? null;
  entity.ppo_available = entity.is_internship ? Boolean(entity.ppo_available) : false;
  entity.service_agreement = Boolean(entity.service_agreement);
  entity.bond_period_months = validNumber(entity.bond_period_months, 1, 120);
  entity.round_details = cleanRounds(entity.round_details);
  entity.total_rounds = entity.round_details.length;
  entity.current_deadline = validNumber(entity.current_deadline, 0, 4102444800);
  entity.total_positions = validNumber(entity.total_positions, 1, 100000);
  entity.application_link = cleanString(entity.application_link);
  entity.contact_email = cleanString(entity.contact_email);
  entity.contact_phone = cleanString(entity.contact_phone);
  entity.additional_information = cleanString(entity.additional_information);
  entity.job_source = cleanString(entity.job_source) ?? "campus";

  return entity;
}
