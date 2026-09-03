"use client";

import {
  PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { Delete, Eraser, PencilLine, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { classifyDigit } from "@/lib/digit-model";

type HandwritingInputProps = {
  open: boolean;
  initialValue?: string;
  minValue?: number;
  maxValue?: number;
  onOpenChange: (open: boolean) => void;
  onSubmit: (value: string) => void;
};

type InkPoint = { x: number; y: number; t: number; p: number };
type InkStroke = {
  id: string;
  pointerType: string;
  pointers: InkPoint[];
};
type RecognitionMode =
  | "idle"
  | "recognizing"
  | "native"
  | "ocrspace"
  | "local";

type NativeHandwritingPoint = { x: number; y: number; t?: number };
type NativeHandwritingStroke = {
  addPoint: (point: NativeHandwritingPoint) => void;
};
type NativeHandwritingPrediction = { text: string };
type NativeHandwritingDrawing = {
  addStroke: (stroke: NativeHandwritingStroke) => void;
  getPrediction: () => Promise<NativeHandwritingPrediction[]>;
  clear: () => void;
};
type NativeHandwritingRecognizer = {
  startDrawing: (hints?: {
    recognitionType?: "text" | "per-character";
    inputType?: "mouse" | "touch" | "stylus";
    alternatives?: number;
  }) => NativeHandwritingDrawing;
  finish: () => void;
};
type HandwritingNavigator = Navigator & {
  createHandwritingRecognizer?: (constraint: {
    languages: string[];
  }) => Promise<NativeHandwritingRecognizer>;
};
type HandwritingWindow = Window & {
  HandwritingStroke?: new () => NativeHandwritingStroke;
};

type ColumnRun = { start: number; end: number };
type DigitBounds = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
};

const CANVAS_WIDTH = 720;
const CANVAS_HEIGHT = 320;
const SAME_DIGIT_GAP = 10;
const RECOGNITION_DELAY = 900;

function normalizedNumberCandidate(
  value: unknown,
  minValue: number,
  maxValue: number,
) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s/g, "").replace(/^\+/, "");
  if (!/^\d{1,3}$/.test(normalized)) return null;
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < minValue || parsed > maxValue) {
    return null;
  }
  return String(parsed);
}

function nativeInputType(pointerType: string) {
  return (["mouse", "touch", "stylus"] as const).find(
    (type) => type === pointerType,
  );
}

function normalizedCanvasImage(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d");
  if (!context) return "";
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  let left = canvas.width;
  let right = -1;
  let top = canvas.height;
  let bottom = -1;

  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      if (image.data[(y * canvas.width + x) * 4 + 3] > 18) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  }
  if (right < left || bottom < top) return "";

  const padding = 22;
  const sourceLeft = Math.max(0, left - padding);
  const sourceTop = Math.max(0, top - padding);
  const sourceRight = Math.min(canvas.width, right + padding);
  const sourceBottom = Math.min(canvas.height, bottom + padding);
  const sourceWidth = sourceRight - sourceLeft;
  const sourceHeight = sourceBottom - sourceTop;
  const target = document.createElement("canvas");
  target.width = CANVAS_WIDTH;
  target.height = CANVAS_HEIGHT;
  const targetContext = target.getContext("2d");
  if (!targetContext) return "";

  targetContext.fillStyle = "#ffffff";
  targetContext.fillRect(0, 0, target.width, target.height);
  const scale = Math.min(
    (target.width - 72) / sourceWidth,
    (target.height - 48) / sourceHeight,
  );
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  targetContext.drawImage(
    canvas,
    sourceLeft,
    sourceTop,
    sourceWidth,
    sourceHeight,
    (target.width - width) / 2,
    (target.height - height) / 2,
    width,
    height,
  );
  return target.toDataURL("image/png");
}

function inkAt(data: Uint8ClampedArray, width: number, x: number, y: number) {
  return data[(y * width + x) * 4 + 3] > 18;
}

function findRuns(
  data: Uint8ClampedArray,
  width: number,
  height: number,
) {
  const occupied = Array.from({ length: width }, (_, x) => {
    for (let y = 0; y < height; y += 1) {
      if (inkAt(data, width, x, y)) return true;
    }
    return false;
  });
  const runs: ColumnRun[] = [];
  let start = -1;
  occupied.forEach((filled, x) => {
    if (filled && start < 0) start = x;
    if (!filled && start >= 0) {
      runs.push({ start, end: x - 1 });
      start = -1;
    }
  });
  if (start >= 0) runs.push({ start, end: width - 1 });

  const merged: ColumnRun[] = [];
  runs.forEach((run) => {
    const previous = merged.at(-1);
    if (previous && run.start - previous.end < SAME_DIGIT_GAP) {
      previous.end = run.end;
    } else merged.push({ ...run });
  });

  while (merged.length > 3) {
    let smallestGap = Number.POSITIVE_INFINITY;
    let mergeAt = 0;
    for (let index = 0; index < merged.length - 1; index += 1) {
      const gap = merged[index + 1].start - merged[index].end;
      if (gap < smallestGap) {
        smallestGap = gap;
        mergeAt = index;
      }
    }
    merged.splice(mergeAt, 2, {
      start: merged[mergeAt].start,
      end: merged[mergeAt + 1].end,
    });
  }
  return merged;
}

function getDigitBounds(image: ImageData, run: ColumnRun): DigitBounds {
  let top = image.height;
  let bottom = 0;
  for (let x = run.start; x <= run.end; x += 1) {
    for (let y = 0; y < image.height; y += 1) {
      if (inkAt(image.data, image.width, x, y)) {
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  }
  return {
    left: run.start,
    right: run.end,
    top,
    bottom,
    width: Math.max(1, run.end - run.start + 1),
    height: Math.max(1, bottom - top + 1),
  };
}

function countEnclosedAreas(image: ImageData, bounds: DigitBounds) {
  const paddedWidth = bounds.width + 2;
  const paddedHeight = bounds.height + 2;
  const size = paddedWidth * paddedHeight;
  const solid = new Uint8Array(size);
  const visited = new Uint8Array(size);
  const queue = new Int32Array(size);

  for (let y = 0; y < bounds.height; y += 1) {
    for (let x = 0; x < bounds.width; x += 1) {
      if (inkAt(image.data, image.width, bounds.left + x, bounds.top + y)) {
        solid[(y + 1) * paddedWidth + x + 1] = 1;
      }
    }
  }

  function flood(start: number) {
    let read = 0;
    let write = 0;
    let area = 0;
    queue[write] = start;
    write += 1;
    visited[start] = 1;

    while (read < write) {
      const index = queue[read];
      read += 1;
      area += 1;
      const x = index % paddedWidth;
      const y = Math.floor(index / paddedWidth);
      const neighbors = [
        x > 0 ? index - 1 : -1,
        x < paddedWidth - 1 ? index + 1 : -1,
        y > 0 ? index - paddedWidth : -1,
        y < paddedHeight - 1 ? index + paddedWidth : -1,
      ];
      neighbors.forEach((neighbor) => {
        if (neighbor >= 0 && !solid[neighbor] && !visited[neighbor]) {
          visited[neighbor] = 1;
          queue[write] = neighbor;
          write += 1;
        }
      });
    }
    return area;
  }

  flood(0);
  const minimumArea = Math.max(
    16,
    Math.floor(bounds.width * bounds.height * 0.005),
  );
  let enclosedAreas = 0;
  for (let index = 0; index < size; index += 1) {
    if (!solid[index] && !visited[index] && flood(index) >= minimumArea) {
      enclosedAreas += 1;
    }
  }
  return enclosedAreas;
}

function hasStrongTopStroke(image: ImageData, bounds: DigitBounds) {
  if (bounds.width / bounds.height < 0.6) return false;
  const lastRow = bounds.top + Math.ceil(bounds.height * 0.35);
  let longest = 0;
  for (let y = bounds.top; y <= lastRow; y += 1) {
    let current = 0;
    for (let x = bounds.left; x <= bounds.right; x += 1) {
      current = inkAt(image.data, image.width, x, y) ? current + 1 : 0;
      longest = Math.max(longest, current);
    }
  }
  return longest / bounds.width >= 0.7;
}

function hasStrongBottomStroke(image: ImageData, bounds: DigitBounds) {
  if (bounds.width / bounds.height < 0.75) return false;
  const firstRow = bounds.bottom - Math.ceil(bounds.height * 0.3);
  let longest = 0;
  for (let y = firstRow; y <= bounds.bottom; y += 1) {
    let current = 0;
    for (let x = bounds.left; x <= bounds.right; x += 1) {
      current = inkAt(image.data, image.width, x, y) ? current + 1 : 0;
      longest = Math.max(longest, current);
    }
  }
  return longest / bounds.width >= 0.52;
}

function recognizeDigit(
  canvas: HTMLCanvasElement,
  image: ImageData,
  run: ColumnRun,
) {
  const bounds = getDigitBounds(image, run);
  const target = document.createElement("canvas");
  target.width = 8;
  target.height = 8;
  const context = target.getContext("2d");
  if (!context) return 0;
  context.clearRect(0, 0, 8, 8);

  const scale = Math.min(6 / bounds.width, 6 / bounds.height);
  const drawWidth = Math.max(1, bounds.width * scale);
  const drawHeight = Math.max(1, bounds.height * scale);
  context.drawImage(
    canvas,
    bounds.left,
    bounds.top,
    bounds.width,
    bounds.height,
    1 + (6 - drawWidth) / 2,
    1 + (6 - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
  const small = context.getImageData(0, 0, 8, 8).data;
  const pixels = Array.from({ length: 64 }, (_, index) =>
    Math.min(1, (small[index * 4 + 3] / 255) * 1.8),
  );
  const ranked = classifyDigit(pixels);
  const enclosedAreas = countEnclosedAreas(image, bounds);
  const strongTopStroke = hasStrongTopStroke(image, bounds);
  const strongBottomStroke = hasStrongBottomStroke(image, bounds);

  // Die in Deutschland übliche durchgestrichene 7 ähnelt im Datensatz oft
  // einer 4. Breite, offene Dreien wurden bisher häufig als 4, 5 oder 6
  // gelesen. Zwei geschlossene Flächen sind dagegen eindeutig eine 8.
  if (enclosedAreas >= 2) return 8;
  if (
    enclosedAreas === 0 &&
    strongTopStroke &&
    (ranked[0].digit === 4 || ranked[0].digit === 9)
  ) {
    return 7;
  }
  if (
    enclosedAreas === 0 &&
    strongBottomStroke &&
    bounds.width / bounds.height >= 0.9 &&
    [2, 3, 4, 5, 6].includes(ranked[0].digit)
  ) {
    return 2;
  }
  if (
    enclosedAreas === 0 &&
    !strongTopStroke &&
    !strongBottomStroke &&
    bounds.width / bounds.height >= 1.15 &&
    [3, 4, 5, 6].includes(ranked[0].digit)
  ) {
    return 3;
  }
  return ranked[0].digit;
}

export function HandwritingInput({
  open,
  initialValue = "",
  minValue = 0,
  maxValue = 99,
  onOpenChange,
  onSubmit,
}: HandwritingInputProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const recognizeTimer = useRef<number | null>(null);
  const strokes = useRef<InkStroke[]>([]);
  const activeStroke = useRef<InkStroke | null>(null);
  const writingStartedAt = useRef<number | null>(null);
  const recognitionRequest = useRef(0);
  const nativeRecognitionAvailability = useRef<
    "unknown" | "available" | "missing"
  >(
    "unknown",
  );
  const ocrSpaceAvailability = useRef<"unknown" | "available" | "missing">(
    "unknown",
  );
  const [value, setValue] = useState(initialValue);
  const [hasInk, setHasInk] = useState(false);
  const [alternatives, setAlternatives] = useState<string[]>([]);
  const [recognitionMode, setRecognitionMode] =
    useState<RecognitionMode>("idle");

  useEffect(
    () => () => {
      recognitionRequest.current += 1;
      if (recognizeTimer.current !== null) {
        window.clearTimeout(recognizeTimer.current);
      }
    },
    [],
  );

  function clearWriting(keepValue = false) {
    recognitionRequest.current += 1;
    if (recognizeTimer.current !== null) {
      window.clearTimeout(recognizeTimer.current);
      recognizeTimer.current = null;
    }
    canvasRef.current
      ?.getContext("2d")
      ?.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    strokes.current = [];
    activeStroke.current = null;
    writingStartedAt.current = null;
    setHasInk(false);
    setAlternatives([]);
    setRecognitionMode("idle");
    if (!keepValue) setValue("");
  }

  function recognizeLocally() {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return "";
    const image = context.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    const runs = findRuns(image.data, image.width, image.height);
    if (!runs.length) return "";
    return runs
      .map((run) => recognizeDigit(canvas, image, run))
      .join("")
      .replace(/^0+(?=\d)/, "");
  }

  function applyLocalRecognition(requestId: number) {
    if (requestId !== recognitionRequest.current) return;
    const recognized = normalizedNumberCandidate(
      recognizeLocally(),
      minValue,
      maxValue,
    );
    setValue(recognized ?? "");
    setAlternatives([]);
    setRecognitionMode("local");
  }

  async function recognize() {
    if (!strokes.current.length) return;
    const requestId = recognitionRequest.current + 1;
    recognitionRequest.current = requestId;

    const handwritingNavigator = navigator as HandwritingNavigator;
    const handwritingWindow = window as HandwritingWindow;
    setRecognitionMode("recognizing");
    setValue("");
    setAlternatives([]);

    const capturedStrokes = strokes.current.map((stroke) => ({
      ...stroke,
      pointers: stroke.pointers.map((pointer) => ({ ...pointer })),
    }));

    if (
      nativeRecognitionAvailability.current !== "missing" &&
      typeof handwritingNavigator.createHandwritingRecognizer === "function" &&
      typeof handwritingWindow.HandwritingStroke === "function"
    ) {
      let recognizer: NativeHandwritingRecognizer | null = null;
      let nativeDrawing: NativeHandwritingDrawing | null = null;
      try {
        recognizer = await handwritingNavigator.createHandwritingRecognizer({
          languages: ["en"],
        });
        nativeDrawing = recognizer.startDrawing({
          recognitionType: "per-character",
          inputType: nativeInputType(capturedStrokes[0]?.pointerType ?? "touch"),
          alternatives: 8,
        });

        capturedStrokes.forEach((capturedStroke) => {
          const nativeStroke = new handwritingWindow.HandwritingStroke!();
          capturedStroke.pointers.forEach(({ x, y, t }) => {
            nativeStroke.addPoint({ x, y, t });
          });
          nativeDrawing?.addStroke(nativeStroke);
        });

        const predictions = await nativeDrawing.getPrediction();
        if (requestId !== recognitionRequest.current) return;
        const candidates = [
          ...new Set(
            predictions
              .map((prediction) =>
                normalizedNumberCandidate(prediction.text, minValue, maxValue),
              )
              .filter((candidate): candidate is string => candidate !== null),
          ),
        ].slice(0, 4);
        const recognized = candidates[0] ?? "";
        if (recognized) {
          nativeRecognitionAvailability.current = "available";
          setValue(recognized);
          setAlternatives(candidates.slice(1));
          setRecognitionMode("native");
          return;
        }
      } catch {
        nativeRecognitionAvailability.current = "missing";
      } finally {
        nativeDrawing?.clear();
        recognizer?.finish();
      }
    } else {
      nativeRecognitionAvailability.current = "missing";
    }

    if (requestId !== recognitionRequest.current) return;
    if (ocrSpaceAvailability.current === "missing") {
      applyLocalRecognition(requestId);
      return;
    }

    try {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const image = normalizedCanvasImage(canvas);
      if (!image) {
        applyLocalRecognition(requestId);
        return;
      }
      const response = await fetch("/api/handwriting", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image, minValue, maxValue }),
      });
      if (response.status === 503) {
        ocrSpaceAvailability.current = "missing";
        applyLocalRecognition(requestId);
        return;
      }
      if (!response.ok) throw new Error("OCR.space recognition failed");
      const result = (await response.json()) as { value?: string };
      if (requestId !== recognitionRequest.current) return;
      const recognized = normalizedNumberCandidate(
        result.value,
        minValue,
        maxValue,
      );
      if (!recognized) {
        applyLocalRecognition(requestId);
        return;
      }

      ocrSpaceAvailability.current = "available";
      setValue(recognized);
      setAlternatives([]);
      setRecognitionMode("ocrspace");
    } catch {
      applyLocalRecognition(requestId);
    }
  }

  function pointFromClient(
    canvas: HTMLCanvasElement,
    clientX: number,
    clientY: number,
  ) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * CANVAS_WIDTH,
      y: ((clientY - rect.top) / rect.height) * CANVAS_HEIGHT,
    };
  }

  function inkPoint(
    canvas: HTMLCanvasElement,
    event: PointerEvent | ReactPointerEvent<HTMLCanvasElement>,
  ): InkPoint {
    const current = pointFromClient(canvas, event.clientX, event.clientY);
    const timestamp = Number(event.timeStamp);
    writingStartedAt.current ??= timestamp;
    return {
      ...current,
      t: Math.max(0, Math.round(timestamp - writingStartedAt.current)),
      p: event.pressure > 0 ? event.pressure : 0.5,
    };
  }

  function startDrawing(event: ReactPointerEvent<HTMLCanvasElement>) {
    const context = event.currentTarget.getContext("2d");
    if (!context) return;
    if (recognizeTimer.current !== null) {
      window.clearTimeout(recognizeTimer.current);
      recognizeTimer.current = null;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const current = inkPoint(event.currentTarget, event);
    drawing.current = true;
    setHasInk(true);
    setValue("");
    setAlternatives([]);
    setRecognitionMode("idle");
    activeStroke.current = {
      id:
        typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `stroke-${strokes.current.length}-${current.t}`,
      pointerType: event.pointerType || "touch",
      pointers: [current],
    };
    context.beginPath();
    context.moveTo(current.x, current.y);
    context.strokeStyle = "#333c59";
    context.lineWidth = 18;
    context.lineCap = "round";
    context.lineJoin = "round";
  }

  function continueDrawing(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const context = event.currentTarget.getContext("2d");
    if (!context) return;
    const coalesced = event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent];
    coalesced.forEach((pointerEvent) => {
      const current = inkPoint(event.currentTarget, pointerEvent);
      activeStroke.current?.pointers.push(current);
      context.lineTo(current.x, current.y);
      context.stroke();
    });
  }

  function finishDrawing(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    continueDrawing(event);
    drawing.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (activeStroke.current) strokes.current.push(activeStroke.current);
    activeStroke.current = null;
    recognizeTimer.current = window.setTimeout(() => {
      recognizeTimer.current = null;
      void recognize();
    }, RECOGNITION_DELAY);
  }

  function typeDigit(digit: number) {
    clearWriting(true);
    setValue((current) =>
      current.length >= 3 ? String(digit) : `${current}${digit}`,
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        className="bottom-auto left-1/2 top-[max(0.5rem,env(safe-area-inset-top))] grid max-h-[calc(100svh-1rem)] w-[calc(100%-1rem)] max-w-lg -translate-x-1/2 translate-y-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-[2rem] border-0 bg-white p-0 shadow-[0_24px_70px_rgba(23,32,59,0.22)] data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100"
      >
        <DialogHeader className="px-5 pb-3 pt-4 text-left">
          <div className="flex items-start justify-between gap-4">
            <div>
              <DialogTitle className="flex items-center gap-2 text-xl font-black text-[#17203b]">
                <PencilLine className="size-5 text-[#5b4ce6]" />
                Zahl schreiben
              </DialogTitle>
              <DialogDescription className="sr-only">
                Schreibe die ganze Zahl mit dem Finger in das Feld.
              </DialogDescription>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => clearWriting()}
                className="rounded-xl p-2 text-[#737c98] hover:bg-[#f5f7ff]"
                aria-label="Schreibfeld leeren"
              >
                <Eraser className="size-5" />
              </button>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="rounded-xl p-2 text-[#737c98] hover:bg-[#f5f7ff]"
                aria-label="Schreibfeld schließen"
              >
                <X className="size-5" />
              </button>
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto overscroll-contain px-4">
          <canvas
            ref={canvasRef}
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            onPointerDown={startDrawing}
            onPointerMove={continueDrawing}
            onPointerUp={finishDrawing}
            onPointerCancel={finishDrawing}
            aria-label="Schreibfeld für die Zahl"
            className="h-[clamp(6.5rem,15svh,8.5rem)] w-full touch-none rounded-2xl border-2 border-dashed border-[#cfd4e5] bg-[#f9faff]"
          />

          <div className="mt-3 flex min-h-14 items-center justify-between rounded-2xl bg-[#f5f7ff] px-4">
            <span className="text-sm font-bold text-[#737c98]">
              {recognitionMode === "recognizing"
                ? "Elli schaut genau …"
                : hasInk
                  ? "Elli erkennt:"
                  : "Erkannte Zahl:"}
            </span>
            <span className="text-3xl font-black text-[#17203b]">
              {recognitionMode === "recognizing" ? "…" : value || "–"}
            </span>
          </div>

          {alternatives.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
              <span className="text-sm font-semibold text-[#737c98]">
                Oder meinst du:
              </span>
              {alternatives.map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  onClick={() => {
                    recognitionRequest.current += 1;
                    setValue(candidate);
                    setAlternatives((current) =>
                      current.filter((item) => item !== candidate),
                    );
                  }}
                  className="min-h-10 min-w-12 rounded-xl border border-[#dfe3f4] bg-white px-3 text-lg font-black text-[#333c59] active:bg-[#e5e1ff]"
                >
                  {candidate}
                </button>
              ))}
            </div>
          )}

          <details className="group mt-3">
            <summary className="cursor-pointer list-none text-center text-sm font-bold text-[#5b4ce6]">
              Zahl lieber tippen
            </summary>
            <div className="mt-3 grid grid-cols-6 gap-2">
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((digit) => (
                <button
                  key={digit}
                  type="button"
                  onClick={() => typeDigit(digit)}
                  className="h-11 rounded-xl bg-[#f5f7ff] text-lg font-bold text-[#333c59] active:bg-[#e5e1ff]"
                >
                  {digit}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setValue((current) => current.slice(0, -1))}
                className="col-span-2 flex h-11 items-center justify-center rounded-xl bg-[#f5f7ff] text-[#626b86] active:bg-[#e5e1ff]"
                aria-label="Letzte Ziffer löschen"
              >
                <Delete className="size-5" />
              </button>
            </div>
          </details>
        </div>

        <div className="bg-white px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
          <Button
            type="button"
            disabled={!value}
            onClick={() => {
              onSubmit(value);
              onOpenChange(false);
            }}
            className="h-13 w-full rounded-2xl bg-[#5b4ce6] text-base font-bold hover:bg-[#493bc9]"
          >
            {value ? `${value} übernehmen` : "Zahl übernehmen"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
