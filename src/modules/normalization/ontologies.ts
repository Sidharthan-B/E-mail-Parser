export const CIRCUIT_BRANCHES = ["ECE", "EEE", "EIE"] as const;
export const CORE_DEPARTMENTS = ["CSE", "IT", "Mechanical", "Civil"] as const;
export const DEGREE_DEPARTMENTS = ["MCA", "BCA"] as const;

export const BRANCH_ALIASES: Record<string, string[]> = {
  CSE: [
    "cse",
    "cs",
    "computer science",
    "computer science engineering",
    "computer engineering",
    "computer science and engineering",
    "allied cs streams",
    "allied computer science"
  ],
  IT: ["it", "information technology"],
  ISE: ["ise", "information science", "information science engineering"],
  ECE: ["ece", "electronics and communication", "electronics communication"],
  EEE: ["eee", "electrical and electronics", "electrical"],
  EIE: ["eie", "electronics and instrumentation", "instrumentation"],
  Mechanical: ["me", "mechanical", "mechanical engineering"],
  Civil: ["civil", "civil engineering"],
  MCA: ["mca"],
  BCA: ["bca"],
  "AI & DS": ["ai ds", "ai&ds", "artificial intelligence and data science", "aids"],
  "AI/ML": ["aiml", "ai ml", "artificial intelligence and machine learning"],
  "Data Science": ["data science", "ds"],
  "Cyber Security": ["cyber security", "cybersecurity"],
  "Embedded Systems": ["embedded systems", "embedded"]
};

export const SPECIALISATION_ALIASES: Record<string, string[]> = {
  "AI/ML": BRANCH_ALIASES["AI/ML"] ?? [],
  "Data Science": BRANCH_ALIASES["Data Science"] ?? [],
  "Cyber Security": BRANCH_ALIASES["Cyber Security"] ?? [],
  "Embedded Systems": BRANCH_ALIASES["Embedded Systems"] ?? []
};

export const WORK_MODE_ALIASES: Record<"Remote" | "Hybrid" | "Onsite", string[]> = {
  Remote: ["remote", "wfh", "work from home", "virtual work"],
  Hybrid: ["hybrid", "hybrid working", "hybrid model"],
  Onsite: ["onsite", "on-site", "office based", "office-based", "in office", "work from office", "wfo"]
};

export const INTERNSHIP_TERMS = [
  "internship",
  "intern",
  "summer intern",
  "winter intern",
  "trainee"
];

export const PPO_TERMS = [
  "ppo",
  "pre placement offer",
  "pre-placement offer",
  "conversion opportunity",
  "conversion to full time",
  "conversion to full-time",
  "full time conversion",
  "full-time conversion"
];

export const ROLE_ALIASES: Record<string, string[]> = {
  Analyst: ["analyst", "analyst or equivalent"],
  "SDE Intern": ["sde intern", "software development engineer intern", "software engineer intern"],
  "Software Engineer": ["software engineer", "sde", "software developer"],
  "Java Developer": ["java developer", "java developer fresher"],
  "Associate Consultant": ["associate consultant"],
  Consultant: ["consultant"]
};

export const SERVICE_AGREEMENT_TERMS = [
  "service agreement",
  "employment bond",
  "bond period",
  "mandatory commitment",
  "commitment period",
  "training agreement"
];

export const ROUND_ALIASES: Record<string, string[]> = {
  "Online Assessment": ["online assessment", "online coding assessment", "coding assessment", "proctored online assessment"],
  "Aptitude Test": ["aptitude test", "aptitude round"],
  "Technical Interview": ["technical interview", "technical round"],
  "HR Round": ["hr round", "hr discussion", "hr interview"],
  "Virtual Interview": ["virtual interview", "virtual interviews"],
  "Group Discussion": ["group discussion", "gd"]
};
