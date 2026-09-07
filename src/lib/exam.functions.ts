import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const MODEL = "google/gemini-3-flash-preview";

async function callGateway(body: Record<string, unknown>) {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("Missing LOVABLE_API_KEY");
  const res = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Lovable-API-Key": key,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 429) throw new Error("Rate limit hit. Please wait and retry.");
    if (res.status === 402) throw new Error("AI credits exhausted. Add credits in workspace billing.");
    throw new Error(`AI gateway error ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices: { message: { content: string } }[];
  };
  return data.choices?.[0]?.message?.content ?? "";
}

function stripJson(s: string): string {
  let t = s.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  }
  // Try to locate first { or [
  const i = t.search(/[\[{]/);
  if (i > 0) t = t.slice(i);
  return t.trim();
}

/**
 * Walk a (possibly-truncated) JSON string and produce the longest valid prefix
 * by cutting at the last "safe" boundary and closing any still-open brackets.
 *
 * Safe boundaries are points where the partial parse is structurally complete
 * given the current bracket stack:
 *   - immediately after `{` or `[`   (an empty container is valid)
 *   - immediately after `}` or `]`   (a value just closed)
 *   - immediately BEFORE a `,`       (the previous element is complete)
 * We never treat the inside of a string or a bare number/identifier as safe,
 * which avoids corrupting valid data.
 */
function repairTruncatedJson(input: string): string {
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  let safeIdx = -1;
  let safeStack: string[] = [];

  const snapshot = (idx: number) => {
    safeIdx = idx;
    safeStack = stack.slice();
  };

  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{" || c === "[") {
      stack.push(c);
      snapshot(i + 1);
    } else if (c === "}" || c === "]") {
      stack.pop();
      snapshot(i + 1);
    } else if (c === ",") {
      // cut BEFORE the comma so the trailing partial element is dropped
      snapshot(i);
    }
  }

  // Already valid — nothing to repair.
  if (!inStr && stack.length === 0) return input;
  // No safe point found — caller will surface the parse error.
  if (safeIdx < 0) return input;

  let out = input.slice(0, safeIdx).replace(/\s+$/, "");
  for (let i = safeStack.length - 1; i >= 0; i--) {
    out += safeStack[i] === "{" ? "}" : "]";
  }
  return out;
}

function isLikelyTruncated(s: string): boolean {
  // Quick structural check: unbalanced brackets or unterminated string.
  let inStr = false, esc = false, depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
  }
  return inStr || depth !== 0;
}

function parseJsonLoose<T>(s: string): T {
  const cleaned = stripJson(s);
  // Fast path: valid JSON.
  if (!isLikelyTruncated(cleaned)) {
    try { return JSON.parse(cleaned) as T; } catch { /* fall through */ }
  }
  // Repair path: only invoked when structure is incomplete.
  const repaired = repairTruncatedJson(cleaned);
  try {
    return JSON.parse(repaired) as T;
  } catch {
    // Last resort: try parsing the original anyway to surface a clear error.
    try { return JSON.parse(cleaned) as T; } catch (e) {
      throw new Error(
        `Could not parse JSON from model response: ${(e as Error).message}`
      );
    }
  }
}


const SectionSpec = {
  A: {
    name: "Section A — Objective",
    perMark: 1,
    description: "MCQs, assertion-reason, fill-in-the-blank, one-word, true/false. Mix types. Include 'options' arrays for MCQs.",
    type: "OBJ",
  },
  B: {
    name: "Section B — Very Short Answer",
    perMark: 2,
    description: "Very short answer questions. Optionally include OR internal choice on 1-2 questions.",
    type: "VSA",
  },
  C: {
    name: "Section C — Short Answer",
    perMark: 3,
    description: "Short answer questions. Include OR internal choice on 1-2 questions.",
    type: "SA",
  },
  D: {
    name: "Section D — Long Answer",
    perMark: 5,
    description: "Long answer questions. Include OR internal choice on 1-2 questions. Mix application/competency-based.",
    type: "LA",
  },
  E: {
    name: "Section E — Case/Source-based",
    perMark: 4,
    description: "Case/source-based integrated questions. Each must include a 'passage' (3-6 sentences) and 'subParts' (2-3 sub-questions with their own marks summing to question marks).",
    type: "CASE",
  },
} as const;

type SectionKey = keyof typeof SectionSpec;

export type Question = {
  id: string;
  marks: number;
  type: string;
  text: string;
  options?: string[];
  choiceOr?: string | null;
  passage?: string | null;
  subParts?: { id: string; marks: number; text: string }[];
};

export type Section = {
  section: string;
  instructions: string;
  questions: Question[];
};

export type Grade = {
  id: string;
  marksAwarded: number;
  maxMarks: number;
  idealAnswer: string;
  feedback: string;
};

const GenInput = z.object({
  pdfBase64: z.string().min(10),
  pdfFilename: z.string().default("textbook.pdf"),
  grade: z.string(),
  subject: z.string(),
  chapters: z.string(),
  totalMarks: z.number(),
  duration: z.string(),
  section: z.enum(["A", "B", "C", "D", "E"]),
  questionCount: z.number(),
});

export const generateSection = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => GenInput.parse(d))
  .handler(async ({ data }) => {
    const spec = SectionSpec[data.section as SectionKey];
    const sysPrompt = `You are a CBSE question paper setter. You ONLY draw from the provided textbook PDF for the chapters specified. Never invent content outside the PDF. Return STRICT JSON ONLY (no prose, no markdown fences).`;

    const userPrompt = `Generate ${spec.name} for a CBSE ${data.grade} ${data.subject} paper.
Chapters to cover: ${data.chapters}
Total paper marks: ${data.totalMarks}. This section: ${data.questionCount} question(s), each worth ${spec.perMark} mark(s).
${spec.description}
Use the attached PDF as the SOLE source of truth. If a chapter is missing, omit it (do not fabricate).

Return JSON exactly:
{
  "section": "${data.section}",
  "instructions": "string — section-level instructions",
  "questions": [
    {
      "id": "${data.section}1",
      "marks": ${spec.perMark},
      "type": "${spec.type}",
      "text": "the question text",
      "options": ["A) ...","B) ...","C) ...","D) ..."] ${data.section === "A" ? "// include for MCQs only" : "// omit unless MCQ"},
      "choiceOr": null,
      "passage": null,
      "subParts": []
    }
  ]
}
For OR-choice questions set "choiceOr" to the alternate question text (not null). For Section E populate "passage" and "subParts": [{"id":"E1a","marks":N,"text":"..."}]. IDs must be ${data.section}1, ${data.section}2, ...`;

    const content: unknown[] = [
      { type: "text", text: userPrompt },
      {
        type: "file",
        file: {
          filename: data.pdfFilename,
          file_data: `data:application/pdf;base64,${data.pdfBase64}`,
        },
      },
    ];

    const body = {
      model: MODEL,
      max_tokens: 1000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: sysPrompt },
        { role: "user", content },
      ],
    };

    let raw = "";
    try {
      raw = await callGateway(body);
      return parseJsonLoose<Section>(raw);
    } catch {
      raw = await callGateway(body);
      return parseJsonLoose<Section>(raw);
    }
  });

const GradeInput = z.object({
  questionId: z.string(),
  questionText: z.string(),
  maxMarks: z.number(),
  type: z.string(),
  studentAnswer: z.string(),
  pdfBase64: z.string().optional(),
});

export const gradeQuestion = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => GradeInput.parse(d))
  .handler(async ({ data }) => {
    if (!data.studentAnswer.trim()) {
      return {
        id: data.questionId,
        marksAwarded: 0,
        maxMarks: data.maxMarks,
        idealAnswer: "(not graded — no answer provided)",
        feedback: "No answer was written.",
      };
    }
    const sys = `You are a CBSE examiner. Grade strictly per CBSE step-marking spirit:
- Award PARTIAL marks for partially correct answers (method/steps matter).
- Be lenient on phrasing/spelling, strict on concepts and required keywords.
- For MCQ/objective: full marks if correct, else 0.
- Never exceed maxMarks. Feedback must be specific, actionable, 1-2 sentences.
Return STRICT JSON ONLY, no markdown fences.`;

    const user = `Question (${data.type}, max ${data.maxMarks} marks):
"""${data.questionText}"""

Student's answer:
"""${data.studentAnswer}"""

Return JSON:
{
  "id": "${data.questionId}",
  "marksAwarded": <number 0..${data.maxMarks}>,
  "maxMarks": ${data.maxMarks},
  "idealAnswer": "the model/ideal answer (concise)",
  "feedback": "1-2 sentence specific feedback on what was missing or wrong"
}`;

    const body = {
      model: MODEL,
      max_tokens: 1000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
    };

    let raw = "";
    try {
      raw = await callGateway(body);
      const r = parseJsonLoose<Grade>(raw);
      r.marksAwarded = Math.max(0, Math.min(data.maxMarks, Number(r.marksAwarded) || 0));
      r.maxMarks = data.maxMarks;
      return r;
    } catch {
      raw = await callGateway(body);
      const r = parseJsonLoose<Grade>(raw);
      r.marksAwarded = Math.max(0, Math.min(data.maxMarks, Number(r.marksAwarded) || 0));
      r.maxMarks = data.maxMarks;
      return r;
    }
  });
