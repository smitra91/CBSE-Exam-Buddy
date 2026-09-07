import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  generateSection,
  gradeQuestion,
  type Question,
  type Section,
  type Grade,
} from "@/lib/exam.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "CBSE Exam Simulator" },
      {
        name: "description",
        content:
          "Upload a textbook PDF, generate a CBSE-format question paper, answer on screen, and get AI grading with partial marks and feedback.",
      },
    ],
  }),
  component: ExamApp,
});

type Phase = "setup" | "generating" | "exam" | "grading" | "results";

type SetupConfig = {
  grade: string;
  subject: string;
  chapters: string;
  totalMarks: number;
  duration: string; // e.g. "3 hours"
  durationMinutes: number;
  pdfBase64: string;
  pdfFilename: string;
};

const SECTION_KEYS = ["A", "B", "C", "D", "E"] as const;
type SectionKey = (typeof SECTION_KEYS)[number];

function plan(totalMarks: number): Record<SectionKey, number> {
  // Returns count per section so marks sum exactly to totalMarks.
  // Default 80 -> A:20*1, B:5*2, C:6*3, D:4*5, E:3*4 = 20+10+18+20+12 = 80
  if (totalMarks >= 70) {
    const a = Math.max(0, totalMarks - (5 * 2 + 6 * 3 + 4 * 5 + 3 * 4));
    return { A: a, B: 5, C: 6, D: 4, E: 3 };
  }
  if (totalMarks >= 40) {
    // scaled: A:10, B:3, C:4, D:2, E:1 -> 10+6+12+10+4 = 42; adjust A
    const a = Math.max(0, totalMarks - (3 * 2 + 4 * 3 + 2 * 5 + 1 * 4));
    return { A: a, B: 3, C: 4, D: 2, E: 1 };
  }
  // primary: simple
  const a = Math.max(0, totalMarks - (2 * 2 + 2 * 3));
  return { A: a, B: 2, C: 2, D: 0, E: 0 };
}

const SECTION_TITLES: Record<SectionKey, string> = {
  A: "Section A — Objective",
  B: "Section B — Very Short Answer",
  C: "Section C — Short Answer",
  D: "Section D — Long Answer",
  E: "Section E — Case / Source-based",
};

const PER_MARK: Record<SectionKey, number> = { A: 1, B: 2, C: 3, D: 5, E: 4 };

function ExamApp() {
  const [phase, setPhase] = useState<Phase>("setup");
  const [config, setConfig] = useState<SetupConfig | null>(null);
  const [sections, setSections] = useState<Section[]>([]);
  const [genStatus, setGenStatus] = useState("");
  const [genError, setGenError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [choices, setChoices] = useState<Record<string, "main" | "or">>({});
  const [grades, setGrades] = useState<Grade[]>([]);
  const [gradeStatus, setGradeStatus] = useState("");
  const [gradeError, setGradeError] = useState<string | null>(null);

  const genFn = useServerFn(generateSection);
  const gradeFn = useServerFn(gradeQuestion);

  const reset = () => {
    setPhase("setup");
    setConfig(null);
    setSections([]);
    setAnswers({});
    setChoices({});
    setGrades([]);
    setGenError(null);
    setGradeError(null);
  };

  const retake = () => {
    setAnswers({});
    setChoices({});
    setGrades([]);
    setGradeError(null);
    setPhase("exam");
  };

  async function handleStart(cfg: SetupConfig) {
    setConfig(cfg);
    setSections([]);
    setGenError(null);
    setPhase("generating");
    const counts = plan(cfg.totalMarks);
    const out: Section[] = [];
    for (const key of SECTION_KEYS) {
      if (counts[key] <= 0) continue;
      setGenStatus(`Generating ${SECTION_TITLES[key]} (${out.length + 1} of ${SECTION_KEYS.filter((k) => counts[k] > 0).length})...`);
      try {
        const sec = await genFn({
          data: {
            pdfBase64: cfg.pdfBase64,
            pdfFilename: cfg.pdfFilename,
            grade: cfg.grade,
            subject: cfg.subject,
            chapters: cfg.chapters,
            totalMarks: cfg.totalMarks,
            duration: cfg.duration,
            section: key,
            questionCount: counts[key],
          },
        });
        out.push(sec);
        setSections([...out]);
      } catch (e) {
        setGenError((e as Error).message || "Generation failed");
        return;
      }
    }
    setGenStatus("");
    setPhase("exam");
  }

  async function handleSubmit() {
    if (!config) return;
    setPhase("grading");
    setGradeError(null);
    setGrades([]);
    const allQs: { q: Question; sec: SectionKey }[] = [];
    for (const sec of sections) {
      const k = sec.section as SectionKey;
      for (const q of sec.questions) allQs.push({ q, sec: k });
    }
    const out: Grade[] = [];
    for (let i = 0; i < allQs.length; i++) {
      const { q } = allQs[i];
      setGradeStatus(`Grading question ${i + 1} of ${allQs.length}...`);
      const ans = answers[q.id] || "";
      const pickedOr = q.choiceOr && choices[q.id] === "or";
      const activeQuestion = pickedOr ? q.choiceOr! : q.text;
      try {
        const g = await gradeFn({
          data: {
            questionId: q.id,
            questionText:
              (q.passage ? `Passage: ${q.passage}\n\n` : "") +
              activeQuestion +
              (q.subParts && q.subParts.length
                ? "\n" + q.subParts.map((s) => `(${s.id}) [${s.marks}] ${s.text}`).join("\n")
                : "") +
              (q.options && q.options.length ? "\nOptions:\n" + q.options.join("\n") : ""),
            maxMarks: q.marks,
            type: q.type,
            studentAnswer: ans,
          },
        });
        out.push(g);
        setGrades([...out]);
      } catch (e) {
        setGradeError((e as Error).message || "Grading failed");
        return;
      }
    }
    setGradeStatus("");
    setPhase("results");
  }

  if (phase === "setup") return <SetupScreen onStart={handleStart} />;

  if (phase === "generating")
    return (
      <ProgressScreen
        title="Generating your paper"
        status={genStatus}
        sections={sections}
        error={genError}
        onRetry={() => config && handleStart(config)}
        onCancel={reset}
      />
    );

  if (phase === "exam" && config)
    return (
      <ExamScreen
        config={config}
        sections={sections}
        answers={answers}
        setAnswers={setAnswers}
        choices={choices}
        setChoices={setChoices}
        onSubmit={handleSubmit}
      />
    );

  if (phase === "grading")
    return (
      <ProgressScreen
        title="Grading your answers"
        status={gradeStatus}
        sections={sections}
        error={gradeError}
        onRetry={handleSubmit}
        onCancel={() => setPhase("exam")}
        cancelLabel="Back to paper"
      />
    );

  if (phase === "results" && config)
    return (
      <ResultsScreen
        config={config}
        sections={sections}
        answers={answers}
        grades={grades}
        onRetake={retake}
        onNew={reset}
      />
    );

  return null;
}

function SetupScreen({ onStart }: { onStart: (c: SetupConfig) => void }) {
  const [grade, setGrade] = useState("Class 10");
  const [subject, setSubject] = useState("Science");
  const [chapters, setChapters] = useState("");
  const [totalMarks, setTotalMarks] = useState(80);
  const [duration, setDuration] = useState("3 hours");
  const [pdfBase64, setPdfBase64] = useState("");
  const [pdfName, setPdfName] = useState("");
  const [pdfSizeMB, setPdfSizeMB] = useState(0);
  const [error, setError] = useState<string | null>(null);

  function durationToMinutes(d: string): number {
    const m = d.match(/(\d+(?:\.\d+)?)\s*h/i);
    const mm = d.match(/(\d+)\s*m/i);
    let mins = 0;
    if (m) mins += parseFloat(m[1]) * 60;
    if (mm) mins += parseInt(mm[1]);
    if (!m && !mm) {
      const n = parseFloat(d);
      if (!isNaN(n)) mins = n * 60;
    }
    return Math.max(5, Math.round(mins) || 180);
  }

  async function handleFile(f: File) {
    setError(null);
    setPdfName(f.name);
    setPdfSizeMB(+(f.size / (1024 * 1024)).toFixed(2));
    const buf = await f.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buf);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
    }
    const b64 = btoa(binary);
    setPdfBase64(b64);
  }

  function submit() {
    if (!pdfBase64) return setError("Please upload a textbook PDF.");
    if (!chapters.trim()) return setError("Please list at least one chapter.");
    if (totalMarks < 10) return setError("Total marks must be at least 10.");
    onStart({
      grade,
      subject,
      chapters,
      totalMarks,
      duration,
      durationMinutes: durationToMinutes(duration),
      pdfBase64,
      pdfFilename: pdfName || "textbook.pdf",
    });
  }

  return (
    <div className="min-h-screen bg-background py-12 px-4">
      <div className="mx-auto max-w-2xl">
        <header className="mb-8 text-center">
          <h1 className="font-serif text-4xl font-bold tracking-tight text-foreground">
            CBSE Exam Simulator
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Upload a textbook chapter PDF — generate a real CBSE-style paper — answer on screen — get AI-graded results with partial marks.
          </p>
        </header>

        <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
          <div className="space-y-5">
            <div>
              <label className="mb-1 block text-sm font-medium text-foreground">Textbook PDF</label>
              <input
                type="file"
                accept="application/pdf"
                onChange={(e) => e.target.files && handleFile(e.target.files[0])}
                className="block w-full text-sm text-foreground file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-2 file:text-sm file:font-medium file:text-primary-foreground hover:file:bg-primary/90"
              />
              {pdfName && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {pdfName} · {pdfSizeMB} MB
                  {pdfSizeMB > 8 && (
                    <span className="ml-2 text-amber-600">
                      (large file — generation may be slow or fail)
                    </span>
                  )}
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Field label="Grade / Class">
                <input
                  value={grade}
                  onChange={(e) => setGrade(e.target.value)}
                  className="input"
                  placeholder="Class 10"
                />
              </Field>
              <Field label="Subject">
                <input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="input"
                  placeholder="Science"
                />
              </Field>
            </div>

            <Field label="Chapters to cover">
              <textarea
                value={chapters}
                onChange={(e) => setChapters(e.target.value)}
                rows={3}
                className="input"
                placeholder="e.g. Chapter 1: Light — Reflection and Refraction; Chapter 2: The Human Eye"
              />
            </Field>

            <div className="grid grid-cols-2 gap-4">
              <Field label="Total marks">
                <input
                  type="number"
                  min={10}
                  max={100}
                  value={totalMarks}
                  onChange={(e) => setTotalMarks(parseInt(e.target.value) || 80)}
                  className="input"
                />
              </Field>
              <Field label="Duration">
                <input
                  value={duration}
                  onChange={(e) => setDuration(e.target.value)}
                  className="input"
                  placeholder="3 hours"
                />
              </Field>
            </div>

            {error && (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}

            <button
              onClick={submit}
              className="w-full rounded-md bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90"
            >
              Generate Paper
            </button>
            <p className="text-center text-xs text-muted-foreground">
              The paper is generated section-by-section, drawing only from your PDF.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-foreground">{label}</span>
      {children}
    </label>
  );
}

function ProgressScreen({
  title,
  status,
  sections,
  error,
  onRetry,
  onCancel,
  cancelLabel = "Start over",
}: {
  title: string;
  status: string;
  sections: Section[];
  error: string | null;
  onRetry: () => void;
  onCancel: () => void;
  cancelLabel?: string;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-center shadow-sm">
        <h2 className="font-serif text-2xl font-semibold text-foreground">{title}</h2>
        {!error && (
          <>
            <div className="mx-auto mt-6 h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
            </div>
            <p className="mt-4 text-sm text-muted-foreground">{status || "Working..."}</p>
            {sections.length > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                {sections.length} section{sections.length === 1 ? "" : "s"} ready
              </p>
            )}
          </>
        )}
        {error && (
          <div className="mt-6 space-y-3">
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
            <div className="flex gap-2">
              <button
                onClick={onRetry}
                className="flex-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                Retry
              </button>
              <button
                onClick={onCancel}
                className="flex-1 rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-accent"
              >
                {cancelLabel}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ExamScreen({
  config,
  sections,
  answers,
  setAnswers,
  choices,
  setChoices,
  onSubmit,
}: {
  config: SetupConfig;
  sections: Section[];
  answers: Record<string, string>;
  setAnswers: (a: Record<string, string>) => void;
  choices: Record<string, "main" | "or">;
  setChoices: (c: Record<string, "main" | "or">) => void;
  onSubmit: () => void;
}) {
  const [started, setStarted] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(config.durationMinutes * 60);
  const submittedRef = useRef(false);

  useEffect(() => {
    if (!started) return;
    const id = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [started]);

  useEffect(() => {
    if (started && secondsLeft === 0 && !submittedRef.current) {
      submittedRef.current = true;
      onSubmit();
    }
  }, [started, secondsLeft, onSubmit]);

  const totalQs = sections.reduce((n, s) => n + s.questions.length, 0);
  const answered = Object.values(answers).filter((v) => v.trim()).length;

  const hh = Math.floor(secondsLeft / 3600);
  const mm = Math.floor((secondsLeft % 3600) / 60);
  const ss = secondsLeft % 60;
  const timeStr = `${hh}:${mm.toString().padStart(2, "0")}:${ss.toString().padStart(2, "0")}`;
  const lowTime = secondsLeft < 5 * 60;

  if (!started) {
    const totalMarks = sections.reduce(
      (n, s) => n + s.questions.reduce((m, q) => m + q.marks, 0),
      0,
    );
    const qCount = sections.reduce((n, s) => n + s.questions.length, 0);
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
        <div className="w-full max-w-lg rounded-xl border border-border bg-card p-8 text-center shadow-sm">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Your paper is ready</p>
          <h2 className="mt-2 font-serif text-3xl font-bold text-foreground">
            {config.subject} — {config.grade}
          </h2>
          <div className="mt-6 grid grid-cols-3 gap-3 text-sm">
            <div className="rounded-md bg-muted p-3">
              <p className="text-xs text-muted-foreground">Duration</p>
              <p className="mt-1 font-semibold">{config.duration}</p>
            </div>
            <div className="rounded-md bg-muted p-3">
              <p className="text-xs text-muted-foreground">Questions</p>
              <p className="mt-1 font-semibold">{qCount}</p>
            </div>
            <div className="rounded-md bg-muted p-3">
              <p className="text-xs text-muted-foreground">Total marks</p>
              <p className="mt-1 font-semibold">{totalMarks}</p>
            </div>
          </div>
          <p className="mt-6 text-sm text-muted-foreground">
            The timer starts the moment you click below. The paper auto-submits when time runs out.
          </p>
          <button
            onClick={() => setStarted(true)}
            className="mt-6 w-full rounded-md bg-primary px-6 py-3 text-base font-semibold text-primary-foreground hover:bg-primary/90"
          >
            Start Exam
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-32">
      <div className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">CBSE Exam Simulator</p>
            <p className="text-sm font-medium text-foreground">
              {answered} / {totalQs} answered
            </p>
          </div>
          <div
            className={`rounded-md px-3 py-1.5 font-mono text-lg font-semibold ${
              lowTime ? "bg-destructive/10 text-destructive" : "bg-muted text-foreground"
            }`}
          >
            {timeStr}
          </div>
        </div>
      </div>

      <main className="mx-auto max-w-3xl px-4 py-8">
        <PaperHeader config={config} />

        {sections.map((sec) => (
          <section key={sec.section} className="mt-10">
            <div className="mb-3 border-b-2 border-foreground pb-2">
              <h3 className="font-serif text-xl font-bold text-foreground">
                {SECTION_TITLES[sec.section as SectionKey] || `Section ${sec.section}`}
              </h3>
              <p className="mt-1 text-sm italic text-muted-foreground">{sec.instructions}</p>
            </div>

            {sec.questions.map((q, i) => (
              <QuestionBlock
                key={q.id}
                index={i + 1}
                q={q}
                answer={answers[q.id] || ""}
                onAnswer={(v) => setAnswers({ ...answers, [q.id]: v })}
                choice={choices[q.id] || "main"}
                onChoice={(c) => setChoices({ ...choices, [q.id]: c })}
              />
            ))}
          </section>
        ))}
      </main>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background/95 p-4 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4">
          <p className="text-xs text-muted-foreground">
            Unanswered questions auto-score 0. You can submit any time.
          </p>
          <button
            onClick={() => {
              if (!submittedRef.current) {
                submittedRef.current = true;
                onSubmit();
              }
            }}
            className="rounded-md bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
          >
            Submit Paper
          </button>
        </div>
      </div>
    </div>
  );
}

function PaperHeader({ config }: { config: SetupConfig }) {
  return (
    <div className="border-2 border-foreground p-6 text-center font-serif">
      <p className="text-sm font-semibold tracking-wider">CENTRAL BOARD OF SECONDARY EDUCATION</p>
      <h2 className="mt-1 text-2xl font-bold">{config.subject.toUpperCase()}</h2>
      <p className="mt-1 text-sm">{config.grade}</p>
      <div className="mt-3 flex justify-between text-sm">
        <span>Time Allowed: {config.duration}</span>
        <span>Maximum Marks: {config.totalMarks}</span>
      </div>
      <div className="mt-4 border-t border-foreground pt-3 text-left text-xs">
        <p className="font-semibold">General Instructions:</p>
        <ol className="mt-1 list-decimal space-y-0.5 pl-5">
          <li>All questions are compulsory.</li>
          <li>The question paper consists of five sections — A, B, C, D and E.</li>
          <li>Internal choices have been provided in some questions. Attempt only one of the choices.</li>
          <li>Read each question carefully and write answers in the space provided.</li>
          <li>Marks for each question are indicated against it.</li>
        </ol>
      </div>
    </div>
  );
}

function QuestionBlock({
  index,
  q,
  answer,
  onAnswer,
  choice,
  onChoice,
}: {
  index: number;
  q: Question;
  answer: string;
  onAnswer: (v: string) => void;
  choice: "main" | "or";
  onChoice: (c: "main" | "or") => void;
}) {
  const hasChoice = Boolean(q.choiceOr);
  const pickedOr = hasChoice && choice === "or";
  return (
    <div className="mt-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <p className="font-serif text-base leading-relaxed text-foreground">
            <span className="font-semibold">Q{index}.</span>{" "}
            {q.passage && (
              <span className="my-2 block rounded-md bg-muted/60 p-3 text-sm italic">
                {q.passage}
              </span>
            )}
          </p>
          {hasChoice ? (
            <div className="mt-1 space-y-2">
              <label
                className={`flex cursor-pointer items-start gap-2 rounded-md border p-3 transition ${
                  !pickedOr ? "border-primary bg-primary/5" : "border-border"
                }`}
              >
                <input
                  type="radio"
                  name={`choice-${q.id}`}
                  className="mt-1"
                  checked={!pickedOr}
                  onChange={() => onChoice("main")}
                />
                <span className="font-serif text-base leading-relaxed">{q.text}</span>
              </label>
              <p className="my-1 text-center text-xs font-semibold text-muted-foreground">OR</p>
              <label
                className={`flex cursor-pointer items-start gap-2 rounded-md border p-3 transition ${
                  pickedOr ? "border-primary bg-primary/5" : "border-border"
                }`}
              >
                <input
                  type="radio"
                  name={`choice-${q.id}`}
                  className="mt-1"
                  checked={pickedOr}
                  onChange={() => onChoice("or")}
                />
                <span className="font-serif text-base leading-relaxed">{q.choiceOr}</span>
              </label>
            </div>
          ) : (
            <p className="font-serif text-base leading-relaxed">{q.text}</p>
          )}
          {q.options && q.options.length > 0 && (
            <ul className="mt-2 space-y-1 pl-6 font-serif text-sm">
              {q.options.map((o, i) => (
                <li key={i}>{o}</li>
              ))}
            </ul>
          )}
          {q.subParts && q.subParts.length > 0 && (
            <ol className="mt-2 space-y-1 pl-6 font-serif text-sm">
              {q.subParts.map((s) => (
                <li key={s.id}>
                  ({s.id.slice(-1)}) {s.text}{" "}
                  <span className="text-muted-foreground">[{s.marks}]</span>
                </li>
              ))}
            </ol>
          )}
        </div>
        <span className="shrink-0 font-serif text-sm font-semibold text-foreground">
          [{q.marks}]
        </span>
      </div>
      <textarea
        value={answer}
        onChange={(e) => onAnswer(e.target.value)}
        rows={q.marks <= 1 ? 2 : q.marks <= 3 ? 4 : 7}
        placeholder={hasChoice ? "Write your answer to the selected option..." : "Write your answer here..."}
        className="mt-3 w-full rounded-md border border-input bg-background p-3 font-sans text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      />
    </div>
  );
}

function ResultsScreen({
  config,
  sections,
  answers,
  grades,
  onRetake,
  onNew,
}: {
  config: SetupConfig;
  sections: Section[];
  answers: Record<string, string>;
  grades: Grade[];
  onRetake: () => void;
  onNew: () => void;
}) {
  const gradeMap = useMemo(() => {
    const m: Record<string, Grade> = {};
    for (const g of grades) m[g.id] = g;
    return m;
  }, [grades]);

  const totalAwarded = grades.reduce((s, g) => s + g.marksAwarded, 0);
  const totalMax = grades.reduce((s, g) => s + g.maxMarks, 0) || config.totalMarks;
  const pct = Math.round((totalAwarded / totalMax) * 100);
  const band = cbseBand(pct);

  return (
    <div className="min-h-screen bg-background py-10 px-4">
      <div className="mx-auto max-w-3xl">
        <header className="rounded-xl border border-border bg-card p-6 text-center shadow-sm">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Result</p>
          <h1 className="mt-1 font-serif text-4xl font-bold">
            {totalAwarded} <span className="text-muted-foreground">/ {totalMax}</span>
          </h1>
          <p className="mt-2 text-lg">
            <span className="font-semibold">{pct}%</span>{" "}
            <span className="text-muted-foreground">· Grade {band}</span>
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {config.subject} · {config.grade}
          </p>

          <div className="mt-5 flex justify-center gap-2">
            <button
              onClick={onRetake}
              className="rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent"
            >
              Retake same paper
            </button>
            <button
              onClick={onNew}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              New paper
            </button>
          </div>
        </header>

        <section className="mt-8">
          <h2 className="font-serif text-xl font-semibold">Section-wise breakdown</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {sections.map((sec) => {
              const ids = sec.questions.map((q) => q.id);
              const awarded = ids.reduce((s, id) => s + (gradeMap[id]?.marksAwarded || 0), 0);
              const max = sec.questions.reduce((s, q) => s + q.marks, 0);
              return (
                <div key={sec.section} className="rounded-lg border border-border bg-card p-4">
                  <p className="text-sm font-semibold">
                    {SECTION_TITLES[sec.section as SectionKey]}
                  </p>
                  <p className="mt-1 font-serif text-2xl">
                    {awarded} <span className="text-muted-foreground">/ {max}</span>
                  </p>
                </div>
              );
            })}
          </div>
        </section>

        <section className="mt-10 space-y-6">
          <h2 className="font-serif text-xl font-semibold">Per-question review</h2>
          {sections.map((sec, si) => (
            <div key={sec.section}>
              <h3 className="mt-4 border-b border-border pb-1 font-serif text-lg font-semibold">
                {SECTION_TITLES[sec.section as SectionKey]}
              </h3>
              {sec.questions.map((q, i) => {
                const g = gradeMap[q.id];
                const ans = answers[q.id] || "";
                return (
                  <div key={q.id} className="mt-3 rounded-lg border border-border bg-card p-4">
                    <div className="flex items-start justify-between gap-3">
                      <p className="font-serif text-sm font-semibold">
                        Q{si + 1}.{i + 1}{" "}
                        <span className="font-normal">
                          {q.passage ? `[${q.passage.slice(0, 80)}…] ` : ""}
                          {q.text}
                        </span>
                      </p>
                      <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-xs font-semibold">
                        {g ? g.marksAwarded : 0} / {q.marks}
                      </span>
                    </div>

                    <div className="mt-3 grid gap-3 text-sm md:grid-cols-2">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Your answer
                        </p>
                        <p className="mt-1 whitespace-pre-wrap rounded-md bg-muted/40 p-2">
                          {ans || <span className="italic text-muted-foreground">(blank)</span>}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Ideal answer
                        </p>
                        <p className="mt-1 whitespace-pre-wrap rounded-md bg-muted/40 p-2">
                          {g?.idealAnswer || "—"}
                        </p>
                      </div>
                    </div>
                    {g?.feedback && (
                      <p className="mt-3 rounded-md border-l-2 border-primary bg-primary/5 px-3 py-2 text-sm">
                        {g.feedback}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

function cbseBand(pct: number): string {
  if (pct >= 91) return "A1";
  if (pct >= 81) return "A2";
  if (pct >= 71) return "B1";
  if (pct >= 61) return "B2";
  if (pct >= 51) return "C1";
  if (pct >= 41) return "C2";
  if (pct >= 33) return "D";
  return "E";
}
