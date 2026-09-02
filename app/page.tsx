"use client";

import { FormEvent, useEffect, useState } from "react";
import {
  BookOpen,
  Calculator,
  Check,
  ChevronRight,
  LogOut,
  Plus,
  Shapes,
  Sparkles,
  Target,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Role = "admin" | "student";
type ExerciseKind = "subtract" | "add" | "triangle";
type Task = {
  id: number;
  title: string;
  subject: string;
  goal: number;
  min: number;
  max: number;
  kind: ExerciseKind;
};
type Result = { done: number; correct: number };
type MathQuestion = { kind: "math"; label: string; answer: number };
type TriangleQuestion = {
  kind: "triangle";
  inside: [number, number, number];
  outside: [number, number, number];
  givenInside: [boolean, boolean, boolean];
  givenOutside: [boolean, boolean, boolean];
};
type Question = MathQuestion | TriangleQuestion;
type FieldStatus = "right" | "wrong" | null;
type Feedback = "right" | "wrong" | "incomplete" | null;

const seed: Task[] = [
  {
    id: 1,
    title: "Minus über den Zehner",
    subject: "Mathe",
    goal: 10,
    min: 0,
    max: 20,
    kind: "subtract",
  },
  {
    id: 3,
    title: "Rechendreiecke",
    subject: "Mathe",
    goal: 8,
    min: 1,
    max: 9,
    kind: "triangle",
  },
];

function random(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function makeQuestion(task: Task): Question {
  if (task.kind === "triangle") {
    const inside: [number, number, number] = [
      random(task.min, task.max),
      random(task.min, task.max),
      random(task.min, task.max),
    ];
    const outside: [number, number, number] = [
      inside[0] + inside[1],
      inside[0] + inside[2],
      inside[1] + inside[2],
    ];
    const givenInside: [boolean, boolean, boolean] = [false, false, false];
    const givenOutside: [boolean, boolean, boolean] = [false, false, false];
    const pattern = random(0, 2);

    if (pattern === 0) {
      // Drei innere Zahlen: drei Plusaufgaben.
      givenInside.fill(true);
    } else if (pattern === 1) {
      // Zwei innere Zahlen und eine Außensumme: Minus und Plus gemischt.
      const missingInner = random(0, 2);
      givenInside.forEach((_, index) => {
        givenInside[index] = index !== missingInner;
      });
      const touchingEdges =
        missingInner === 0 ? [0, 1] : missingInner === 1 ? [0, 2] : [1, 2];
      givenOutside[touchingEdges[random(0, 1)]] = true;
    } else {
      // Eine innere Zahl und ihre beiden Seitensummen: zweimal Minus, einmal Plus.
      const knownInner = random(0, 2);
      givenInside[knownInner] = true;
      const touchingEdges =
        knownInner === 0 ? [0, 1] : knownInner === 1 ? [0, 2] : [1, 2];
      touchingEdges.forEach((index) => {
        givenOutside[index] = true;
      });
    }

    return {
      kind: "triangle",
      inside,
      outside,
      givenInside,
      givenOutside,
    };
  }

  if (task.kind === "add") {
    const a = random(task.min, task.max);
    const b = random(task.min, task.max);
    return { kind: "math", label: `${a} + ${b}`, answer: a + b };
  }

  // Zweite Klasse: über den Zehner, aber niemals unter 0.
  const a = random(11, Math.max(11, task.max));
  const result = random(0, Math.min(9, a - 1));
  const b = a - result;
  return { kind: "math", label: `${a} − ${b}`, answer: result };
}

function normalizeTasks(value: unknown): Task[] {
  if (!Array.isArray(value)) return seed;
  const normalized = value.map((raw) => {
    const task = raw as Partial<Task>;
    const title = task.title ?? "Rechenübung";
    const kind: ExerciseKind =
      task.kind ??
      (title.toLowerCase().includes("dreieck")
        ? "triangle"
        : title.toLowerCase().includes("plus")
          ? "add"
          : "subtract");
    return {
      id: task.id ?? Date.now(),
      title:
        kind === "subtract" && title === "Minus über Null"
          ? "Minus über den Zehner"
          : title,
      subject: task.subject ?? "Mathe",
      goal: task.goal ?? 10,
      min: task.min ?? (kind === "triangle" ? 1 : 0),
      max: kind === "subtract" ? 20 : (task.max ?? 9),
      kind,
    };
  });
  if (!normalized.some((task) => task.kind === "triangle")) {
    normalized.push(seed[1]);
  }
  return normalized;
}

export default function Home() {
  const [role, setRole] = useState<Role | null>(null);
  const [tasks, setTasks] = useState<Task[]>(seed);
  const [results, setResults] = useState<Record<number, Result>>({});
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("elli-tasks");
    const progress = localStorage.getItem("elli-progress");
    if (saved) {
      try {
        setTasks(normalizeTasks(JSON.parse(saved)));
      } catch {
        setTasks(seed);
      }
    }
    if (progress) {
      try {
        setResults(JSON.parse(progress));
      } catch {
        setResults({});
      }
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (ready) localStorage.setItem("elli-tasks", JSON.stringify(tasks));
  }, [tasks, ready]);
  useEffect(() => {
    if (ready) localStorage.setItem("elli-progress", JSON.stringify(results));
  }, [results, ready]);

  if (!ready) return <main className="min-h-screen bg-[#f5f7ff]" />;
  if (!role) return <Login onLogin={setRole} />;
  return role === "admin" ? (
    <Admin tasks={tasks} setTasks={setTasks} onLogout={() => setRole(null)} />
  ) : (
    <Student
      tasks={tasks}
      results={results}
      setResults={setResults}
      onLogout={() => setRole(null)}
    />
  );
}

function Shell({
  children,
  role,
  onLogout,
}: {
  children: React.ReactNode;
  role: string;
  onLogout: () => void;
}) {
  return (
    <main className="min-h-screen bg-[#f5f7ff] text-[#17203b]">
      <header className="border-b border-[#dfe3f4] bg-white/90 px-5 py-4 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-2xl bg-[#5b4ce6] text-white">
              <Sparkles size={21} />
            </div>
            <div>
              <div className="text-xl font-extrabold tracking-tight">Elli</div>
              <div className="text-xs font-semibold text-[#7c849f]">{role}</div>
            </div>
          </div>
          <Button
            variant="ghost"
            onClick={onLogout}
            className="rounded-xl text-[#626b86]"
          >
            <LogOut className="mr-2 size-4" />
            Abmelden
          </Button>
        </div>
      </header>
      {children}
    </main>
  );
}

function Login({ onLogin }: { onLogin: (role: Role) => void }) {
  const [email, setEmail] = useState("mia@elli.de");
  const [password, setPassword] = useState("lernen");
  const [error, setError] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    if (email === "admin@elli.de" && password === "admin") onLogin("admin");
    else if (email === "mia@elli.de" && password === "lernen")
      onLogin("student");
    else setError("Die Zugangsdaten stimmen noch nicht.");
  }

  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden bg-[#f5f7ff] p-5 text-[#17203b]">
      <div className="absolute -left-24 top-20 size-72 rounded-full bg-[#dff8ee] blur-2xl" />
      <div className="absolute -right-24 bottom-10 size-80 rounded-full bg-[#e2deff] blur-2xl" />
      <div className="relative w-full max-w-md rounded-[2rem] border border-white bg-white p-7 shadow-[0_30px_80px_rgba(76,65,170,.15)] sm:p-10">
        <div className="mb-8 flex items-center gap-3">
          <div className="grid size-12 place-items-center rounded-2xl bg-[#5b4ce6] text-white">
            <Sparkles />
          </div>
          <div>
            <h1 className="text-3xl font-black tracking-tight">Elli</h1>
            <p className="text-[#737c98]">Dein Lerntraining</p>
          </div>
        </div>
        <form onSubmit={submit} className="space-y-5">
          <label className="block text-sm font-bold">
            E-Mail
            <Input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="mt-2 h-12 rounded-xl border-[#dfe3f4] bg-[#f9faff]"
            />
          </label>
          <label className="block text-sm font-bold">
            Passwort
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-2 h-12 rounded-xl border-[#dfe3f4] bg-[#f9faff]"
            />
          </label>
          {error && (
            <p className="rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-700">
              {error}
            </p>
          )}
          <Button className="h-12 w-full rounded-xl bg-[#5b4ce6] text-base font-bold hover:bg-[#493bc9]">
            Einloggen <ChevronRight className="ml-1" />
          </Button>
        </form>
        <div className="mt-7 rounded-2xl bg-[#f5f7ff] p-4 text-sm text-[#626b86]">
          <p className="font-bold text-[#333c59]">Demo-Zugänge</p>
          <p>Schülerin: mia@elli.de · lernen</p>
          <p>Admin: admin@elli.de · admin</p>
        </div>
      </div>
    </main>
  );
}

function Admin({
  tasks,
  setTasks,
  onLogout,
}: {
  tasks: Task[];
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ExerciseKind>("subtract");
  const [title, setTitle] = useState("Minus über den Zehner");
  const [goal, setGoal] = useState(10);

  function changeKind(value: ExerciseKind) {
    setKind(value);
    setTitle(
      value === "triangle"
        ? "Rechendreiecke"
        : value === "add"
          ? "Plus bis 20"
          : "Minus über den Zehner",
    );
  }

  function add(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    setTasks((current) => [
      ...current,
      {
        id: Date.now(),
        title: title.trim(),
        subject: "Mathe",
        goal,
        min: kind === "triangle" ? 1 : 0,
        max: kind === "triangle" ? 9 : 20,
        kind,
      },
    ]);
    setOpen(false);
  }

  return (
    <Shell role="Adminbereich" onLogout={onLogout}>
      <div className="mx-auto max-w-6xl p-5 py-10 sm:p-8">
        <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="mb-2 text-sm font-extrabold uppercase tracking-[.18em] text-[#5b4ce6]">
              Klasse 2 · Mathe
            </p>
            <h1 className="text-3xl font-black tracking-tight sm:text-4xl">
              Was soll Mia üben?
            </h1>
          </div>
          <Button
            onClick={() => setOpen(true)}
            className="h-12 rounded-xl bg-[#5b4ce6] px-5 font-bold"
          >
            <Plus className="mr-2" />
            Aufgabe anlegen
          </Button>
        </div>

        <div className="grid gap-4">
          {tasks.map((task) => (
            <article
              key={task.id}
              className="flex items-center gap-4 rounded-3xl border border-[#dfe3f4] bg-white p-5 shadow-sm"
            >
              <TaskIcon kind={task.kind} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-[#7c849f]">
                  {task.subject} · {kindLabel(task.kind)}
                </p>
                <h2 className="truncate text-lg font-extrabold">{task.title}</h2>
                <p className="text-sm text-[#626b86]">
                  Ziel: {task.goal} richtige Antworten
                </p>
              </div>
              <Button
                aria-label={`${task.title} löschen`}
                variant="ghost"
                onClick={() =>
                  setTasks((current) =>
                    current.filter((item) => item.id !== task.id),
                  )
                }
                className="rounded-xl text-[#8b93aa] hover:bg-red-50 hover:text-red-600"
              >
                <Trash2 />
              </Button>
            </article>
          ))}
        </div>

        {open && (
          <div
            className="fixed inset-0 z-20 grid place-items-center bg-[#17203b]/40 p-5"
            onMouseDown={() => setOpen(false)}
          >
            <form
              onSubmit={add}
              onMouseDown={(event) => event.stopPropagation()}
              className="w-full max-w-lg rounded-[2rem] bg-white p-7 shadow-2xl"
            >
              <div className="mb-6 flex items-center justify-between">
                <h2 className="text-2xl font-black">Neue Aufgabe</h2>
                <Button
                  type="button"
                  variant="ghost"
                  aria-label="Schließen"
                  onClick={() => setOpen(false)}
                >
                  <X />
                </Button>
              </div>
              <label className="block text-sm font-bold">
                Aufgabentyp
                <Select
                  value={kind}
                  onValueChange={(value) => changeKind(value as ExerciseKind)}
                >
                  <SelectTrigger className="mt-2 h-12 w-full rounded-xl">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="subtract">Minus über den Zehner</SelectItem>
                    <SelectItem value="add">Plus bis 20</SelectItem>
                    <SelectItem value="triangle">Rechendreiecke</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <label className="mt-5 block text-sm font-bold">
                Titel
                <Input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  className="mt-2 h-12 rounded-xl"
                />
              </label>
              <label className="mt-5 block text-sm font-bold">
                Anzahl richtiger Antworten
                <Input
                  type="number"
                  min={1}
                  max={30}
                  value={goal}
                  onChange={(event) => setGoal(Number(event.target.value))}
                  className="mt-2 h-12 rounded-xl"
                />
              </label>
              <div className="mt-7 flex justify-end gap-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setOpen(false)}
                  className="rounded-xl"
                >
                  Abbrechen
                </Button>
                <Button className="rounded-xl bg-[#5b4ce6] font-bold">
                  Für Mia freigeben
                </Button>
              </div>
            </form>
          </div>
        )}
      </div>
    </Shell>
  );
}

function kindLabel(kind: ExerciseKind) {
  if (kind === "triangle") return "Rechendreieck";
  if (kind === "add") return "Plus";
  return "Minus";
}

function TaskIcon({ kind }: { kind: ExerciseKind }) {
  const styles =
    kind === "triangle"
      ? "bg-[#ddf7ed] text-[#13845c]"
      : kind === "add"
        ? "bg-[#fff1cf] text-[#9a6400]"
        : "bg-[#e5e1ff] text-[#5b4ce6]";
  return (
    <div className={`grid size-14 shrink-0 place-items-center rounded-2xl ${styles}`}>
      {kind === "triangle" ? (
        <Shapes />
      ) : kind === "add" ? (
        <Calculator />
      ) : (
        <BookOpen />
      )}
    </div>
  );
}

function useVisualViewport() {
  const [viewport, setViewport] = useState({
    height: 0,
    offsetTop: 0,
  });

  useEffect(() => {
    const visualViewport = window.visualViewport;
    const update = () =>
      setViewport({
        height: visualViewport?.height ?? window.innerHeight,
        offsetTop: visualViewport?.offsetTop ?? 0,
      });

    update();
    visualViewport?.addEventListener("resize", update);
    visualViewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      visualViewport?.removeEventListener("resize", update);
      visualViewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  return viewport;
}

function Student({
  tasks,
  results,
  setResults,
  onLogout,
}: {
  tasks: Task[];
  results: Record<number, Result>;
  setResults: React.Dispatch<React.SetStateAction<Record<number, Result>>>;
  onLogout: () => void;
}) {
  const [active, setActive] = useState<Task | null>(null);
  if (active)
    return (
      <Practice
        task={active}
        result={results[active.id]}
        save={(result) =>
          setResults((current) => ({ ...current, [active.id]: result }))
        }
        back={() => setActive(null)}
      />
    );

  return (
    <Shell role="Schülerbereich" onLogout={onLogout}>
      <div className="mx-auto max-w-6xl p-5 py-10 sm:p-8">
        <div className="mb-8">
          <div className="mb-5 inline-flex rounded-full bg-[#e5e1ff] px-4 py-2 text-sm font-extrabold text-[#5b4ce6]">
            Klasse 2 · Mathe
          </div>
          <p className="mb-2 text-sm font-extrabold uppercase tracking-[.18em] text-[#5b4ce6]">
            Hallo Mia 👋
          </p>
          <h1 className="text-3xl font-black tracking-tight sm:text-4xl">
            Deine Übungen
          </h1>
        </div>
        <div className="grid gap-5 md:grid-cols-2">
          {tasks.map((task) => {
            const result = results[task.id] ?? { done: 0, correct: 0 };
            const percentage = Math.min(
              100,
              Math.round((result.correct / task.goal) * 100),
            );
            return (
              <button
                key={task.id}
                onClick={() => setActive(task)}
                className="group rounded-[2rem] border border-[#dfe3f4] bg-white p-6 text-left shadow-sm transition hover:-translate-y-1 hover:shadow-xl"
              >
                <div className="mb-7 flex items-start justify-between">
                  <TaskIcon kind={task.kind} />
                  <div className="grid size-10 place-items-center rounded-full bg-[#f5f7ff] text-[#5b4ce6] transition group-hover:bg-[#5b4ce6] group-hover:text-white">
                    <ChevronRight />
                  </div>
                </div>
                <p className="text-sm font-bold text-[#7c849f]">
                  {kindLabel(task.kind)}
                </p>
                <h2 className="mt-1 text-2xl font-black">{task.title}</h2>
                <div className="mt-7 flex items-center gap-3">
                  <Progress
                    value={percentage}
                    className="h-2.5 flex-1 bg-[#e9ecf7]"
                  />
                  <span className="text-sm font-bold text-[#626b86]">
                    {percentage}%
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </Shell>
  );
}

function TriangleBoard({
  question,
  values,
  statuses,
  compact,
  onFocus,
  onBlur,
  onChange,
}: {
  question: TriangleQuestion;
  values: { inside: string[]; outside: string[] };
  statuses: { inside: FieldStatus[]; outside: FieldStatus[] };
  compact: boolean;
  onFocus: () => void;
  onBlur: () => void;
  onChange: (
    area: "inside" | "outside",
    index: number,
    value: string,
  ) => void;
}) {
  const insidePos = [
    { left: "50%", top: "34%" },
    { left: "36%", top: "65%" },
    { left: "64%", top: "65%" },
  ];
  const outsidePos = [
    { left: "8%", top: "57%" },
    { left: "92%", top: "57%" },
    { left: "50%", top: "91%" },
  ];
  function fieldClass(status: FieldStatus) {
    if (status === "right")
      return "border-[#27a875] text-[#086b48]";
    if (status === "wrong")
      return "border-red-500 text-red-800";
    return "border-[#aeb5ca] text-[#17203b]";
  }

  function fieldStyle(
    status: FieldStatus,
    position: { left: string; top: string },
  ) {
    return {
      ...position,
      backgroundColor:
        status === "right"
          ? "#eaf8f2"
          : status === "wrong"
            ? "#fff0f0"
            : "transparent",
      borderColor:
        status === "right"
          ? "#27a875"
          : status === "wrong"
            ? "#ef4444"
            : "#aeb5ca",
    };
  }

  return (
    <div
      className={`relative mx-auto aspect-[6/5] w-full transition-[max-width] duration-200 ${
        compact ? "max-w-[270px]" : "max-w-[440px]"
      }`}
    >
      <svg
        viewBox="0 0 120 100"
        className="absolute inset-0 size-full overflow-visible"
        aria-hidden="true"
      >
        <path
          d="M60 12 L15 74 L105 74 Z"
          fill="#fbfbfe"
          stroke="#7c849f"
          strokeWidth="1.15"
          strokeLinejoin="round"
        />
        <path
          d="M36 45 L60 60 L84 45 M60 60 L60 74"
          fill="none"
          stroke="#9aa1b5"
          strokeWidth="1"
        />
      </svg>

      {question.inside.map((number, index) => {
        const given = question.givenInside[index];
        return given ? (
          <span
            key={`inside-${index}`}
            className="absolute grid size-10 -translate-x-1/2 -translate-y-1/2 place-items-center text-xl font-semibold"
            style={insidePos[index]}
          >
            {number}
          </span>
        ) : (
          <Input
            key={`inside-${index}`}
            form="practice-form"
            inputMode="numeric"
            enterKeyHint="next"
            value={values.inside[index]}
            onChange={(event) =>
              onChange("inside", index, event.target.value)
            }
            onFocus={onFocus}
            onBlur={onBlur}
            aria-label={`Fehlende innere Zahl ${index + 1}`}
            className={`absolute z-10 size-12 -translate-x-1/2 -translate-y-1/2 rounded-xl border p-0 text-center text-lg font-semibold shadow-none transition-colors ${fieldClass(statuses.inside[index])}`}
            style={fieldStyle(statuses.inside[index], insidePos[index])}
          />
        );
      })}

      {question.outside.map((number, index) => {
        const given = question.givenOutside[index];
        return given ? (
          <span
            key={`outside-${index}`}
            className="absolute grid size-10 -translate-x-1/2 -translate-y-1/2 place-items-center text-lg font-semibold text-[#626b86]"
            style={outsidePos[index]}
          >
            {number}
          </span>
        ) : (
          <Input
            key={`outside-${index}`}
            form="practice-form"
            inputMode="numeric"
            enterKeyHint="next"
            value={values.outside[index]}
            onChange={(event) =>
              onChange("outside", index, event.target.value)
            }
            onFocus={onFocus}
            onBlur={onBlur}
            aria-label={`Fehlende äußere Zahl ${index + 1}`}
            className={`absolute z-10 size-12 -translate-x-1/2 -translate-y-1/2 rounded-lg border p-0 text-center text-lg font-semibold shadow-none transition-colors ${fieldClass(statuses.outside[index])}`}
            style={fieldStyle(statuses.outside[index], outsidePos[index])}
          />
        );
      })}
    </div>
  );
}

function Practice({
  task,
  result,
  save,
  back,
}: {
  task: Task;
  result?: Result;
  save: (result: Result) => void;
  back: () => void;
}) {
  const [question, setQuestion] = useState<Question>(() => makeQuestion(task));
  const [input, setInput] = useState("");
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [triangleValues, setTriangleValues] = useState({
    inside: ["", "", ""],
    outside: ["", "", ""],
  });
  const [triangleStatuses, setTriangleStatuses] = useState<{
    inside: FieldStatus[];
    outside: FieldStatus[];
  }>({
    inside: [null, null, null],
    outside: [null, null, null],
  });
  const [editing, setEditing] = useState(false);
  const viewport = useVisualViewport();
  const current = result ?? { done: 0, correct: 0 };
  const finished = current.correct >= task.goal;
  const percentage = Math.min(100, (current.correct / task.goal) * 100);
  const compact = editing && viewport.height > 0 && viewport.height < 650;

  useEffect(() => {
    const previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.documentElement.style.overflow = previousOverflow;
    };
  }, []);

  function answer(event: FormEvent) {
    event.preventDefault();
    if (question.kind === "math") {
      if (input === "" || feedback) return;
      const correct = Number(input) === question.answer;
      setFeedback(correct ? "right" : "wrong");
      save({
        done: current.done + 1,
        correct: current.correct + (correct ? 1 : 0),
      });
      return;
    }

    const insideStatuses: FieldStatus[] = question.inside.map(
      (answerValue, index) => {
        if (question.givenInside[index]) return null;
        const value = triangleValues.inside[index];
        if (value === "") return null;
        return Number(value) === answerValue ? "right" : "wrong";
      },
    );
    const outsideStatuses: FieldStatus[] = question.outside.map(
      (answerValue, index) => {
        if (question.givenOutside[index]) return null;
        const value = triangleValues.outside[index];
        if (value === "") return null;
        return Number(value) === answerValue ? "right" : "wrong";
      },
    );
    setTriangleStatuses({
      inside: insideStatuses,
      outside: outsideStatuses,
    });

    const allFilled =
      question.givenInside.every(
        (given, index) => given || triangleValues.inside[index] !== "",
      ) &&
      question.givenOutside.every(
        (given, index) => given || triangleValues.outside[index] !== "",
      );
    if (!allFilled) {
      setFeedback("incomplete");
      return;
    }

    const correct =
      insideStatuses.every((status) => status !== "wrong") &&
      outsideStatuses.every((status) => status !== "wrong");
    setFeedback(correct ? "right" : "wrong");
    save({
      done: current.done + 1,
      correct: current.correct + (correct ? 1 : 0),
    });
  }

  function changeTriangleValue(
    area: "inside" | "outside",
    index: number,
    value: string,
  ) {
    if (question.kind !== "triangle") return;
    const expected = question[area][index];
    const status: FieldStatus =
      value === "" ? null : Number(value) === expected ? "right" : "wrong";
    setTriangleValues((currentValues) => ({
      ...currentValues,
      [area]: currentValues[area].map((item, itemIndex) =>
        itemIndex === index ? value : item,
      ),
    }));
    setTriangleStatuses((currentStatuses) => ({
      ...currentStatuses,
      [area]: currentStatuses[area].map((currentStatus, statusIndex) =>
        statusIndex === index ? status : currentStatus,
      ),
    }));
    setFeedback(null);
  }

  function next() {
    setQuestion(makeQuestion(task));
    setInput("");
    setTriangleValues({
      inside: ["", "", ""],
      outside: ["", "", ""],
    });
    setTriangleStatuses({
      inside: [null, null, null],
      outside: [null, null, null],
    });
