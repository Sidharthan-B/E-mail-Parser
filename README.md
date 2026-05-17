# Aarambh Recruiter Document Intelligence Pipeline



Local-only, production-oriented recruiter document extraction and information recognition system for placement automation.



## Stack



- Node.js + TypeScript + Express

- `mailparser` + `cheerio`

- In-process text extraction: `pdf-parse`, `word-extractor` (Word `.doc` / `.docx`), `jszip` (PowerPoint `.pptx`)

- spaCy + GLiNER + RapidFuzz (Python sidecar, optional)

- Optional Docker image for hosting the API only (`docker compose`)



## Architecture



`src/modules` contains:



- `parser`: MIME parsing, HTML cleaning, attachment text extraction, end-to-end orchestrator

- `localFolder`: local inbox file processing

- `normalization`: text and field normalization

- `segmentation`: semantic section detection

- `extraction`: deterministic + NLP hybrid extractor

- `semantic`: Ollama (`qwen2.5`) semantic assistant (optional)

- `validation`: post-extraction guards



## Quick Start



1. Install dependencies:



```bash

npm install

```



2. Configure env:



```bash

cp .env.example .env

```



3. (Optional but recommended) Install Python NLP dependencies:



```bash

pip install -r python/requirements.txt

python -m spacy download en_core_web_sm

```



4. (Optional) Enable Ollama semantic assistant:



```bash

ollama pull qwen2.5:7b-instruct

```



Set in `.env`:



```env

OLLAMA_ENABLED=true

OLLAMA_MODEL=qwen2.5:7b-instruct

```



5. Run API:



```bash

npm run dev

```



## File upload → JSON



`POST /api/pipeline/parse-upload` with multipart form field **`file`**. Supported: `.eml`, `.mime`, `.pdf`, `.docx`, `.doc`, `.pptx`, `.txt`, `.text`, `.md`.



Example:



```bash

curl -s -X POST http://localhost:8080/api/pipeline/parse-upload -F "file=@./uploads/inbox/placement.pdf"

```



Response body is the same `RecruiterEntity` JSON as `parse-text` (company, role, CTC, branches, etc.).



## Local Inbox Processing



Process all files in the local `uploads/inbox` directory automatically.



1. List files in inbox:

```bash

GET /api/local/inbox

```



2. Process all inbox files:

```bash

POST /api/local/process-inbox

Body: { "moveToProcessed": true }  // optional: moves parsed files to uploads/processed

```



Supported file types: `.txt`, `.text`, `.md`, `.pdf`, `.docx`, `.doc`, `.pptx`, `.eml`, `.mime`



## Text-only Testing



`POST /api/pipeline/parse-text`



Body:



```json

{

  "text": "CGPA of 6.5 and above No active backlogs CTC INR 7,60,000 CSE and IT students eligible",

  "source_email": "placement@cet.ac.in"

}

```



## Output Schema



The API returns:

- `company_name`, `recruiter_email`, `role`, `description`
- `location`, `mode_of_work`, `ctc`, `stipend`
- `min_cgpa`, `allowed_backlogs`
- `eligible_departments`, `eligible_batch_years`
- `skills_required`, `preferred_skills`
- `is_internship`, `ppo_available`
- `service_agreement`, `bond_period_months`
- `total_rounds`, `round_details`
- `current_deadline`, `total_positions`
- `application_link`, `contact_email`, `contact_phone`
- `additional_information`, `job_source`



## Sample Run



```bash

npm run sample

```



## Notes



- No external AI APIs are used.

- Ollama runs fully local and is optional.

- Pipeline is modular for future Redis queues, audit logs, and retraining.

- If Python NLP dependencies are missing, deterministic extraction still works.

