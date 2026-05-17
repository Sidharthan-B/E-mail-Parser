import json
import re
import sys
from rapidfuzz import process, fuzz

try:
    import spacy
except Exception:
    spacy = None

try:
    from gliner import GLiNER
except Exception:
    GLiNER = None

LABELS = [
    "COMPANY_NAME",
    "ROLE",
    "REQUIRED_SKILL",
    "PREFERRED_SKILL",
    "BRANCH",
    "SPECIALISATION",
    "ELIGIBLE_YEAR",
    "LOCATION",
]
BRANCH_CANON = ["CSE", "IT", "ECE", "EEE", "EIE", "Mechanical", "Civil", "MCA", "BCA", "AI & DS"]
SPECIALISATION_CANON = ["AI/ML", "Data Science", "Cyber Security", "Embedded Systems"]


def heuristic_extract(text: str):
    company = ""
    role = ""
    location = ""

    company_match = re.search(r"(?:company|organization|client)\s*[:\-]\s*([^\n,]+)", text, re.I)
    role_match = re.search(r"(?:role|position|designation)\s*[:\-]\s*([^\n,]+)", text, re.I)
    location_match = re.search(r"(?:location|base location)\s*[:\-]\s*([^\n,]+)", text, re.I)

    if company_match:
      company = company_match.group(1).strip()
    if role_match:
      role = role_match.group(1).strip()
    if location_match:
      location = location_match.group(1).strip()

    skill_hits = re.findall(r"\b(Java|Python|C\+\+|SQL|React|Node\.js|AWS|Azure|DSA|ML|Data Science)\b", text, re.I)
    branch_hits = re.findall(r"\b(CSE|IT|ECE|EEE|EIE|MCA|BCA|Mechanical|Civil|AIML|AI[- &]?DS)\b", text, re.I)
    year_hits = re.findall(r"\b20\d{2}\b", text)

    norm_branches = []
    for b in branch_hits:
        mapped = process.extractOne(b.upper().replace(" ", "").replace("-", ""), BRANCH_CANON, scorer=fuzz.ratio)
        if mapped and mapped[1] >= 60:
            norm_branches.append(mapped[0])

    return {
        "company_name": company,
        "role": role,
        "location": location,
        "skills_required": sorted(set([x.upper() for x in skill_hits])),
        "eligible_streams": sorted(set(norm_branches)),
        "eligible_specialisations": sorted(set([x for x in SPECIALISATION_CANON if re.search(x.replace("/", r"[/ ]?"), text, re.I)])),
        "eligible_years": sorted(set(year_hits)),
        "preferred_skills": [],
    }


def gliner_extract(text: str):
    if GLiNER is None:
        return {}
    try:
        model = GLiNER.from_pretrained("urchade/gliner_small-v2.1")
        entities = model.predict_entities(text, LABELS, threshold=0.5)
    except Exception:
        return {}

    out = {
        "company_name": "",
        "role": "",
        "location": "",
        "skills_required": [],
        "preferred_skills": [],
        "eligible_streams": [],
        "eligible_specialisations": [],
        "eligible_years": [],
    }
    for ent in entities:
        label = ent.get("label", "")
        text_val = ent.get("text", "").strip()
        if not text_val:
            continue
        if label == "COMPANY_NAME" and not out["company_name"]:
            out["company_name"] = text_val
        elif label == "ROLE" and not out["role"]:
            out["role"] = text_val
        elif label == "LOCATION" and not out["location"]:
            out["location"] = text_val
        elif label == "REQUIRED_SKILL":
            out["skills_required"].append(text_val)
        elif label == "PREFERRED_SKILL":
            out["preferred_skills"].append(text_val)
        elif label == "BRANCH":
            out["eligible_streams"].append(text_val)
        elif label == "SPECIALISATION":
            out["eligible_specialisations"].append(text_val)
        elif label == "ELIGIBLE_YEAR":
            out["eligible_years"].append(text_val)
    out["skills_required"] = sorted(set(out["skills_required"]))
    out["preferred_skills"] = sorted(set(out["preferred_skills"]))
    out["eligible_streams"] = sorted(set(out["eligible_streams"]))
    out["eligible_specialisations"] = sorted(set(out["eligible_specialisations"]))
    out["eligible_years"] = sorted(set(out["eligible_years"]))
    return out


def run(text: str):
    result = heuristic_extract(text)
    gliner = gliner_extract(text)
    for key in ["company_name", "role", "location"]:
        if gliner.get(key):
            result[key] = gliner[key]
    result["skills_required"] = sorted(set(result["skills_required"] + gliner.get("skills_required", [])))
    result["preferred_skills"] = sorted(set(result.get("preferred_skills", []) + gliner.get("preferred_skills", [])))
    result["eligible_streams"] = sorted(set(result.get("eligible_streams", []) + gliner.get("eligible_streams", [])))
    result["eligible_specialisations"] = sorted(set(result.get("eligible_specialisations", []) + gliner.get("eligible_specialisations", [])))
    result["eligible_years"] = sorted(set(result.get("eligible_years", []) + gliner.get("eligible_years", [])))
    return result


if __name__ == "__main__":
    input_text = sys.argv[1] if len(sys.argv) > 1 else ""
    print(json.dumps(run(input_text)))
