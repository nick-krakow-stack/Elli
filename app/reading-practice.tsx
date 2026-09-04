"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, Mic, Square, Volume2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

type ReadingMode = "word" | "sentence";
type ReadingState =
  | "idle"
  | "listening"
  | "right"
  | "retry"
  | "unsupported";
type WordState = "right" | "wrong" | null;

type SpeechAlternativeLike = {
  transcript: string;
  confidence: number;
};

type SpeechResultLike = {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechAlternativeLike;
};

type SpeechEventLike = {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: SpeechResultLike;
  };
};

type SpeechErrorLike = { error: string };

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechEventLike) => void) | null;
  onerror: ((event: SpeechErrorLike) => void) | null;
  onend: (() => void) | null;
  onspeechstart: (() => void) | null;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function speechRecognitionConstructor() {
  const speechWindow = window as typeof window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return (
    speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition
  );
}

export function readingUnits(content: string, mode: ReadingMode) {
  const compact = content.replace(/\s+/g, " ").trim();
  if (!compact) return [];
  if (mode === "word") return compact.split(" ").filter(Boolean);
  return (compact.match(/[^.!?]+[.!?]?/g) ?? [])
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function normalizedWord(value: string) {
  return value
    .toLocaleLowerCase("de-DE")
    .replace(/[^a-zäöüß]/gi, "")
    .trim();
}

function spokenWords(value: string) {
  return value
    .split(/\s+/)
    .map(normalizedWord)
    .filter(Boolean);
}

function distance(left: string, right: string) {
  const rows = Array.from({ length: left.length + 1 }, () =>
    Array(right.length + 1).fill(0),
  );
  for (let index = 0; index <= left.length; index += 1) rows[index][0] = index;
  for (let index = 0; index <= right.length; index += 1) rows[0][index] = index;
  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      rows[row][column] = Math.min(
        rows[row - 1][column] + 1,
        rows[row][column - 1] + 1,
        rows[row - 1][column - 1] +
          (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
  }
  return rows[left.length][right.length];
}

function wordsMatch(expected: string, heard: string) {
  if (!expected || !heard) return false;
  if (expected === heard) return true;
  if (expected.length >= 5 && distance(expected, heard) <= 1) return true;
  return expected.length >= 8 && distance(expected, heard) <= 2;
}

function alignWords(expected: string[], heard: string[]) {
  const scores = Array.from({ length: expected.length + 1 }, () =>
    Array(heard.length + 1).fill(0),
  );
  for (let row = 1; row <= expected.length; row += 1) {
    for (let column = 1; column <= heard.length; column += 1) {
      scores[row][column] = wordsMatch(
        expected[row - 1],
        heard[column - 1],
      )
        ? scores[row - 1][column - 1] + 1
        : Math.max(scores[row - 1][column], scores[row][column - 1]);
    }
  }

  const matched = Array(expected.length).fill(false) as boolean[];
  let row = expected.length;
  let column = heard.length;
  while (row > 0 && column > 0) {
    if (wordsMatch(expected[row - 1], heard[column - 1])) {
      matched[row - 1] = true;
      row -= 1;
      column -= 1;
    } else if (scores[row - 1][column] >= scores[row][column - 1]) {
      row -= 1;
    } else {
      column -= 1;
    }
  }
  return matched;
}

function assess(expectedText: string, alternatives: string[]) {
  const expected = spokenWords(expectedText);
  let best = {
    transcript: alternatives[0] ?? "",
    matched: Array(expected.length).fill(false) as boolean[],
    score: 0,
  };
  alternatives.forEach((transcript) => {
    const matched = alignWords(expected, spokenWords(transcript));
    const score = matched.filter(Boolean).length / Math.max(1, expected.length);
    if (score > best.score) best = { transcript, matched, score };
  });
  return best;
}

function displayWords(value: string) {
  return value.split(/\s+/).filter(Boolean);
}

export function ReadingPractice({
  title,
  content,
  mode,
  result,
  save,
  back,
}: {
  title: string;
  content: string;
  mode: ReadingMode;
  result?: { done: number; correct: number };
  save: (result: { done: number; correct: number }) => void;
  back: () => void;
}) {
  const units = useMemo(() => readingUnits(content, mode), [content, mode]);
  const initialIndex = Math.min(result?.correct ?? 0, units.length);
  const [index, setIndex] = useState(initialIndex);
  const [state, setState] = useState<ReadingState>("idle");
  const [wordStates, setWordStates] = useState<WordState[]>([]);
  const [attempts, setAttempts] = useState(0);
  const [sessionActive, setSessionActive] = useState(false);
  const [detail, setDetail] = useState("");
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const indexRef = useRef(initialIndex);
  const sessionActiveRef = useRef(false);
  const attemptsRef = useRef(0);
  const transitioningRef = useRef(false);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finished = index >= units.length;
  const percentage = units.length
    ? Math.min(100, (index / units.length) * 100)
    : 0;

  function clearTimers() {
    if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
    if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current);
  }

  function stopListening() {
    sessionActiveRef.current = false;
    setSessionActive(false);
    clearTimers();
    recognitionRef.current?.abort();
    recognitionRef.current = null;
    setState((currentState) =>
      currentState === "listening" ? "idle" : currentState,
    );
  }

  useEffect(() => {
    return () => {
      sessionActiveRef.current = false;
      clearTimers();
      recognitionRef.current?.abort();
    };
  }, []);

  function completeCurrent(recognition: SpeechRecognitionLike) {
    if (transitioningRef.current) return;
    transitioningRef.current = true;
    const expectedCount = spokenWords(units[indexRef.current]).length;
    setWordStates(Array(expectedCount).fill("right"));
    setState("right");
    setDetail("Richtig!");
    if (mode === "sentence") {
      sessionActiveRef.current = false;
      setSessionActive(false);
      recognition.stop();
    }

    transitionTimerRef.current = setTimeout(() => {
      const nextIndex = indexRef.current + 1;
      indexRef.current = nextIndex;
      setIndex(nextIndex);
      save({ done: nextIndex, correct: nextIndex });
      attemptsRef.current = 0;
      setAttempts(0);
      setWordStates([]);
      setDetail("");
      transitioningRef.current = false;
      if (nextIndex >= units.length) {
        sessionActiveRef.current = false;
        setSessionActive(false);
        recognition.abort();
        recognitionRef.current = null;
        return;
      }
      setState(mode === "word" ? "listening" : "idle");
    }, 650);
  }

  function handleResult(
    recognition: SpeechRecognitionLike,
    event: SpeechEventLike,
  ) {
    if (transitioningRef.current || indexRef.current >= units.length) return;
    for (let resultIndex = event.resultIndex; resultIndex < event.results.length; resultIndex += 1) {
      const resultItem = event.results[resultIndex];
      const alternatives = Array.from(
        { length: resultItem.length },
        (_, alternativeIndex) => resultItem[alternativeIndex].transcript,
      );
      const evaluation = assess(units[indexRef.current], alternatives);
      setDetail(evaluation.transcript);
      if (evaluation.score === 1) {
        completeCurrent(recognition);
        return;
      }
      if (!resultItem.isFinal) continue;

      const nextAttempts = attemptsRef.current + 1;
      attemptsRef.current = nextAttempts;
      setAttempts(nextAttempts);
      setWordStates(
        evaluation.matched.map((matched) => (matched ? "right" : "wrong")),
      );
      setState("retry");
      if (mode === "sentence") {
        sessionActiveRef.current = false;
        setSessionActive(false);
        recognition.stop();
      }
    }
  }

  function startListening() {
    const Recognition = speechRecognitionConstructor();
    if (!Recognition) {
      setState("unsupported");
      setDetail("Die Spracherkennung ist in diesem Browser nicht verfügbar.");
      return;
    }

    clearTimers();
    recognitionRef.current?.abort();
    const recognition = new Recognition();
    recognitionRef.current = recognition;
    recognition.lang = "de-DE";
    recognition.continuous = mode === "word";
    recognition.interimResults = true;
    recognition.maxAlternatives = 5;
    sessionActiveRef.current = true;
    setSessionActive(true);
    setState("listening");
    setWordStates([]);
    setDetail("");

    recognition.onspeechstart = () => {
      if (!transitioningRef.current) {
        setState("listening");
        setWordStates([]);
      }
    };
    recognition.onresult = (event) => handleResult(recognition, event);
    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        sessionActiveRef.current = false;
        setSessionActive(false);
        setState("unsupported");
        setDetail("Bitte erlaube Elli den Zugriff auf das Mikrofon.");
      } else if (event.error !== "no-speech") {
        setState("retry");
        setDetail("Ich konnte dich noch nicht sicher verstehen.");
      }
    };
    recognition.onend = () => {
      if (mode === "sentence") {
        if (sessionActiveRef.current && !transitioningRef.current) {
          sessionActiveRef.current = false;
          setSessionActive(false);
          setState("retry");
          setDetail("Ich konnte dich noch nicht sicher verstehen.");
        }
        return;
      }
      if (
        !sessionActiveRef.current ||
        indexRef.current >= units.length
      ) {
        return;
      }
      restartTimerRef.current = setTimeout(() => {
        if (!sessionActiveRef.current || indexRef.current >= units.length) return;
        try {
          recognition.start();
        } catch {
          setState("retry");
          setDetail("Tippe noch einmal auf Start.");
          sessionActiveRef.current = false;
          setSessionActive(false);
        }
      }, transitioningRef.current ? 800 : 250);
    };

    try {
      recognition.start();
    } catch {
      sessionActiveRef.current = false;
      setSessionActive(false);
      setState("retry");
      setDetail("Tippe noch einmal auf Start.");
    }
  }

  function readAloud() {
    if (!("speechSynthesis" in window) || !units[index]) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(units[index]);
    utterance.lang = "de-DE";
    utterance.rate = 0.78;
    window.speechSynthesis.speak(utterance);
  }

  function leave() {
    stopListening();
    back();
  }

  if (!units.length) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#f5f7ff] p-5 text-[#17203b]">
        <div className="w-full max-w-lg rounded-[2rem] bg-white p-9 text-center shadow-xl">
          <h1 className="text-3xl font-black">Noch kein Text</h1>
          <p className="mt-3 text-[#626b86]">
            Im Adminbereich kann ein Lesetext hinterlegt werden.
          </p>
          <Button onClick={leave} className="mt-7 rounded-xl bg-[#5b4ce6]">
            Zur Übersicht
          </Button>
        </div>
      </main>
    );
  }

  if (finished) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#f5f7ff] p-5 text-[#17203b]">
        <div className="w-full max-w-lg rounded-[2rem] bg-white p-9 text-center shadow-xl">
          <div className="mx-auto grid size-24 place-items-center rounded-full bg-[#dff8ee] text-[#13845c]">
            <Check size={48} strokeWidth={3} />
          </div>
          <h1 className="mt-7 text-4xl font-black">Super gelesen!</h1>
          <p className="mt-3 text-lg text-[#626b86]">
            Du hast {units.length} {mode === "word" ? "Wörter" : "Sätze"} geschafft.
          </p>
          <Button onClick={leave} className="mt-8 h-12 rounded-xl bg-[#5b4ce6] px-8 font-bold">
            Zur Übersicht
          </Button>
        </div>
      </main>
    );
  }

  const shownWords = displayWords(units[index]);
  const colorClass = (wordIndex: number) => {
    if (wordStates[wordIndex] === "right") return "bg-[#dff8ee] text-[#086b48]";
    if (wordStates[wordIndex] === "wrong") return "bg-red-100 text-red-700";
    return "bg-transparent";
  };

  return (
    <main className="fixed inset-0 overflow-y-auto bg-[#5b4ce6] text-[#17203b]">
      <div className="mx-auto flex min-h-full max-w-3xl flex-col px-3 sm:px-5">
        <div className="flex shrink-0 items-center justify-between py-4 text-white sm:py-5">
          <Button variant="ghost" onClick={leave} className="text-white hover:bg-white/10 hover:text-white">
            ← Beenden
          </Button>
          <span className="font-bold">{index} von {units.length}</span>
        </div>
        <Progress value={percentage} className="mb-5 h-3 shrink-0 bg-white/25 sm:mb-8" />

        <section className="mb-4 flex min-h-[34rem] flex-1 flex-col rounded-[2rem] bg-white p-5 shadow-2xl sm:mb-5 sm:p-10">
          <p className="text-center text-sm font-extrabold uppercase tracking-[.18em] text-[#7c849f]">
            {title}
          </p>
          <p className="mt-3 text-center font-semibold text-[#626b86]">
            {mode === "word"
              ? "Lies das Wort laut vor. Elli geht danach automatisch weiter."
              : "Lies den Satz laut vor."}
          </p>

          <div className="flex flex-1 flex-col items-center justify-center py-8">
            <div
              className={`w-full rounded-[2rem] border-2 px-5 py-10 text-center transition-colors sm:px-8 sm:py-14 ${
                state === "right"
                  ? "border-[#27a875] bg-[#eaf8f2]"
                  : state === "retry"
                    ? "border-red-400 bg-red-50"
                    : state === "listening"
                      ? "border-[#5b4ce6] bg-[#f7f6ff]"
                      : "border-[#dfe3f4] bg-[#fbfbfe]"
              }`}
            >
              <div className={`flex flex-wrap justify-center gap-x-3 gap-y-3 font-black ${mode === "word" ? "text-6xl sm:text-7xl" : "text-3xl leading-relaxed sm:text-4xl"}`}>
                {shownWords.map((word, wordIndex) => (
                  <span
                    key={`${word}-${wordIndex}`}
                    className={`rounded-xl px-2 py-1 transition-colors ${colorClass(wordIndex)}`}
                  >
                    {word}
                  </span>
                ))}
              </div>
            </div>

            <div className="mt-6 min-h-16 text-center">
              {state === "listening" && (
                <p className="flex items-center justify-center gap-2 text-lg font-extrabold text-[#5b4ce6]">
                  <span className="size-3 animate-pulse rounded-full bg-[#5b4ce6]" />
                  Elli hört zu …
                </p>
              )}
              {state === "right" && (
                <p className="flex items-center justify-center gap-2 text-xl font-black text-[#13845c]">
                  <Check /> Richtig!
                </p>
              )}
              {state === "retry" && (
                <p className="flex items-center justify-center gap-2 text-xl font-black text-red-600">
                  <X /> Nochmal lesen
                </p>
              )}
              {state === "unsupported" && (
                <p className="max-w-md font-semibold text-red-600">{detail}</p>
              )}
            </div>

            {attempts >= 2 && state === "retry" && (
              <Button type="button" variant="outline" onClick={readAloud} className="mb-3 rounded-xl border-[#dfe3f4] font-bold text-[#5b4ce6]">
                <Volume2 className="mr-2 size-5" /> Wort anhören
              </Button>
            )}

            {mode === "word" && sessionActive ? (
              <Button type="button" variant="outline" onClick={stopListening} className="h-12 rounded-xl border-[#dfe3f4] px-6 font-bold">
                <Square className="mr-2 size-4" /> Hören beenden
              </Button>
            ) : (
              <Button type="button" onClick={startListening} disabled={state === "right"} className="h-14 w-full max-w-sm rounded-2xl bg-[#5b4ce6] text-lg font-bold hover:bg-[#493bc9]">
                <Mic className="mr-2 size-5" />
                {state === "retry" ? "Nochmal lesen" : mode === "word" ? "Lesen starten" : "Satz vorlesen"}
                <ChevronRight className="ml-1 size-5" />
              </Button>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
