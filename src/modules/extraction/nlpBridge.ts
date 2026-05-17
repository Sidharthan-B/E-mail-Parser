import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { env } from "../../config/env";

const execFileAsync = promisify(execFile);

export type NlpExtraction = {
  company_name?: string;
  role?: string;
  location?: string;
  skills_required?: string[];
  preferred_skills?: string[];
  eligible_streams?: string[];
  eligible_specialisations?: string[];
  eligible_years?: string[];
  eligible_branches?: string[];
  round_details?: string[];
};

export async function extractWithLocalNlp(text: string): Promise<NlpExtraction> {
  try {
    const { stdout } = await execFileAsync(env.NLP_PYTHON_CMD, [env.NLP_SERVICE_SCRIPT, text], {
      maxBuffer: 1024 * 1024
    });
    if (!stdout.trim()) {
      return {};
    }
    return JSON.parse(stdout) as NlpExtraction;
  } catch {
    return {};
  }
}
