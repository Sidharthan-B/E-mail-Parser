# Semantic-First Extraction Examples

The final extraction payload must match the frontend/database schema exactly. Ollama/Qwen and GLiNER may produce intermediate candidates, but the final JSON uses only the normalized schema fields.

## Circuit Branches

Input:

```text
B.E/B.Tech - CS/IT, all Circuit Branches, Mechanical and Civil streams; MCA
```

Expected final fields:

```json
{
  "eligible_departments": [
    { "department": "CSE", "category": "core" },
    { "department": "IT", "category": "core" },
    { "department": "ECE", "category": "circuit" },
    { "department": "EEE", "category": "circuit" },
    { "department": "EIE", "category": "circuit" },
    { "department": "Mechanical", "category": "core" },
    { "department": "Civil", "category": "core" },
    { "department": "MCA", "category": "degree" }
  ],
  "additional_information": "Circuit branches inferred semantically."
}
```

## Internship With PPO

Input:

```text
Summer Internship with PPO / full-time conversion opportunity.
Stipend: Rs. 40k per month
```

Expected final fields:

```json
{
  "is_internship": true,
  "ppo_available": true,
  "stipend": "Rs. 40,000/month"
}
```

## Selection Rounds

Input:

```text
Selection Process:
1. Online Coding Assessment
2. Technical Interview
3. HR Discussion
```

Expected final fields:

```json
{
  "total_rounds": 3,
  "round_details": [
    { "round": 1, "name": "Online Assessment" },
    { "round": 2, "name": "Technical Interview" },
    { "round": 3, "name": "HR Round" }
  ]
}
```

## Missing Registration URL

Input:

```text
Registration link: Click here to register
```

Expected final fields:

```json
{
  "application_link": null,
  "additional_information": "Registration link referenced but actual URL missing."
}
```
