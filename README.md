# Exam Buddy AI

Prompt — CBSE Exam Simulator (Claude.ai Artifact)

> Paste everything below this line into Claude to generate the app.

---

Build a single-file **React artifact** called **"CBSE Exam Simulator"**. It lets a student upload a textbook/subject PDF, pick the chapters, and generates a full CBSE-format question paper that the student answers on screen. The app then grades every typed answer using AI, awards partial marks, and shows feedback and a final score.

Use the built-in Anthropic API (no API key, no backend). Model: `claude-sonnet-4-6`, `max_tokens: 1000` on every call.

## Critical constraint — work around the 1000-token cap
A full CBSE paper and full grading will NOT fit in one API response. Build around this:
- **Generate the paper one section at a time** (one API call per section), then assemble client-side into the complete paper. Show a progress bar ("Generating Section B of E...").
- **Grade one question per API call** (or batch 2 short questions max), looping with a visible "Grading question X of Y" progress indicator.
- Every API call must request **JSON only** (no prose, no markdown fences). Strip any stray ```json fences before `JSON.parse`, and wrap all parsing in try/catch with a retry-once fallback.

## App flow (4 screens)
1. **Setup**
   - Upload PDF (convert to base64, send as a `document` block to the API).
   - Inputs: Grade/Class (free text, e.g. "Class 10"), Subject (free text), Chapters to cover (free text or multi-line list), Total marks (default 80), Duration (default 3 hours).
   - "Generate Paper" button.
2. **Exam**
   - Renders the full paper, section by section, exactly in CBSE layout (see blueprint below).
   - A textarea under each question for the answer. Show marks allocation `[1]`, `[2]`, `[3]`, `[5]`, `[4]` beside each question.
   - A live countdown timer matching the duration. Sticky "Submit Paper" button.
3. **Grading**
   - Loops through answered questions, calling the API per question. Progress indicator. Unanswered questions auto-score 0 without an API call.
4. **Results**
   - Total score (e.g. 63 / 80) + percentage + indicative CBSE grade band.
   - Section-wise breakdown.
   - Per-question review card: the question, student's answer, marks awarded / max, the model/ideal answer, and specific feedback on what was missing.
   - "Retake" and "New Paper" buttons.

## CBSE blueprint (full pattern — adapt to the grade entered)
Default to the standard senior-grade 80-mark theory pattern, scaling down sensibly for primary grades:
- **Section A — Objective (1 mark each):** MCQs, assertion-reason, fill-in-the-blank, one-word/true-false. ~16-20 questions.
- **Section B — Very Short Answer (2 marks each):** ~5-6 questions.
- **Section C — Short Answer (3 marks each):** ~6-7 questions.
- **Section D — Long Answer (5 marks each):** ~3-4 questions.
- **Section E — Case-/Source-based integrated (4 marks each):** ~3 questions, each with a passage/scenario and 2-3 sub-parts.
Include **internal choice** ("OR") in some Section C, D, E questions, as real CBSE papers do. Mix in competency/application-based questions, not just recall. Add a standard header block: board name, subject, grade, max marks, time allowed, and the usual "General Instructions" list. Ensure the marks across all sections sum exactly to the chosen total.

Generation must draw **only from the uploaded PDF content for the specified chapters** — do not pull in outside syllabus. If a chapter is not found in the PDF, flag it on the Setup screen rather than inventing questions.

## Generation API call (per section) — instruct the model to return JSON like:
```json
{
  "section": "B",
  "instructions": "All questions carry 2 marks each.",
  "questions": [
    {
      "id": "B1",
      "marks": 2,
      "text": "...",
      "type": "VSA",
      "choiceOr": null,
      "subParts": []
    }
  ]
}
```
(For Section E, populate `passage` and `subParts`. For MCQs, include an `options` array.)

## Grading API call (per question) — send the question, max marks, the ideal-answer expectation, and the student's typed answer. Instruct JSON only:
```json
{
  "id": "C3",
  "marksAwarded": 2,
  "maxMarks": 3,
  "idealAnswer": "...",
  "feedback": "Correct method but missed the final unit and one step."
}
```
Grading rules to put in the system prompt of that call:
- Award **partial marks** for partially correct answers, following CBSE step-marking spirit (method/steps matter, not just the final answer).
- Be lenient on phrasing/spelling, strict on concepts and required keywords.
- For MCQs/objective: full marks if correct, else 0, with a one-line reason.
- Never award more than maxMarks. Feedback must be specific and actionable, 1-2 sentences.

## Design / UX
- Clean, exam-paper aesthetic: serif headings for the paper, readable line length, clear section dividers, marks right-aligned. Print-friendly.
- Use React state only — **no localStorage/sessionStorage** (unsupported in artifacts). Keep all paper data, answers, and results in memory.
- Handle errors gracefully: failed API call → retry button, never a blank screen. Large PDF → warn if base64 looks oversized.
- Mobile-responsive.

## Acceptance test
A user uploads a Class 1-10 any subject PDF, selects two chapters, total 80 marks. The app produces a 5-section paper summing to 80, lets them type answers, grades each with partial marks and feedback, and shows a 63/80-style result with section breakdown and per-question review.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://paper-pro-pilot.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/8505b04a-8f5d-4bca-b974-b852bcb62081).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
