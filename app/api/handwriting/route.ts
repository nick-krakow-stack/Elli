import { HTTPClientV2 } from "iink-ts";
import type { TExportV2, TStrokeMinimal } from "iink-ts";

type RuntimeEnv = {
  MYSCRIPT_APPLICATION_KEY?: string;
  MYSCRIPT_HMAC_KEY?: string;
};

async function getRuntimeEnv(): Promise<RuntimeEnv> {
  try {
    const cloudflare = await import("cloudflare:workers");
    return cloudflare.env as unknown as RuntimeEnv;
  } catch {
    return process.env as RuntimeEnv;
  }
}

type SubmittedStroke = {
  id?: unknown;
  pointerType?: unknown;
  pointers?: unknown;
};

const MAX_STROKES = 30;
const MAX_POINTS = 6_000;

function numberCandidate(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .replace(/\\(?:mathrm|mathbf|mathit|text)\{([^{}]*)\}/g, "$1")
    .replace(/[{}\s,]/g, "")
    .replace(/^\+/, "");
  if (!/^-?\d{1,3}$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? String(parsed) : null;
}

function collectLabels(value: unknown, labels: string[], depth = 0) {
  if (!value || depth > 5 || labels.length >= 40) return;
  if (typeof value === "string") {
    labels.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectLabels(item, labels, depth + 1));
    return;
  }
  if (typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  [record.label, record.candidates].forEach((item) =>
    collectLabels(item, labels, depth + 1),
  );
  [record.words, record.elements, record.lines, record.spans].forEach((item) =>
    collectLabels(item, labels, depth + 1),
  );
}

function candidatesFrom(exports: TExportV2, min: number, max: number) {
  const labels: string[] = [];
  collectLabels(exports["application/x-latex"], labels);
  collectLabels(exports["application/vnd.myscript.jiix"], labels);

  return [...new Set(labels.map(numberCandidate).filter(Boolean))]
    .filter((candidate): candidate is string => candidate !== null)
    .filter((candidate) => {
      const number = Number(candidate);
      return number >= min && number <= max;
    })
    .slice(0, 4);
}

function sanitizeStrokes(value: unknown): TStrokeMinimal[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_STROKES) {
    return null;
  }

  let pointCount = 0;
  const strokes: TStrokeMinimal[] = [];
  for (const [strokeIndex, submitted] of value.entries()) {
    const raw = submitted as SubmittedStroke;
    if (!Array.isArray(raw.pointers) || raw.pointers.length === 0) return null;
    const pointers = raw.pointers.map((item) => {
      const point = item as Record<string, unknown>;
      const x = Number(point.x);
      const y = Number(point.y);
      const t = Number(point.t);
      const p = Number(point.p);
      if (![x, y, t, p].every(Number.isFinite)) return null;
      return {
        x: Math.max(0, Math.min(720, x)),
        y: Math.max(0, Math.min(320, y)),
        t: Math.max(0, t),
        p: Math.max(0, Math.min(1, p)),
      };
    });
    if (pointers.some((point) => point === null)) return null;
    pointCount += pointers.length;
    if (pointCount > MAX_POINTS) return null;
    strokes.push({
      id:
        typeof raw.id === "string" && raw.id.length <= 100
          ? raw.id
          : `stroke-${strokeIndex}`,
      pointerType:
        typeof raw.pointerType === "string" && raw.pointerType.length <= 20
          ? raw.pointerType
          : "touch",
      pointers: pointers as TStrokeMinimal["pointers"],
    });
  }
  return strokes;
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return Response.json({ error: "Origin not allowed" }, { status: 403 });
  }

  const runtimeEnv = await getRuntimeEnv();
  const applicationKey = runtimeEnv.MYSCRIPT_APPLICATION_KEY?.trim();
  const hmacKey = runtimeEnv.MYSCRIPT_HMAC_KEY?.trim();
  if (!applicationKey || !hmacKey) {
    return Response.json(
      { error: "Handwriting service is not configured" },
      { status: 503 },
    );
  }

  try {
    const payload = (await request.json()) as {
      strokes?: unknown;
      minValue?: unknown;
      maxValue?: unknown;
    };
    const strokes = sanitizeStrokes(payload.strokes);
    if (!strokes) {
      return Response.json({ error: "Invalid strokes" }, { status: 400 });
    }

    const requestedMin = Number(payload.minValue);
    const requestedMax = Number(payload.maxValue);
    const min = Number.isFinite(requestedMin)
      ? Math.max(0, Math.min(999, Math.floor(requestedMin)))
      : 0;
    const max = Number.isFinite(requestedMax)
      ? Math.max(min, Math.min(999, Math.floor(requestedMax)))
      : 99;

    const client = new HTTPClientV2({
      server: {
        scheme: "https",
        host: "cloud.myscript.com",
        applicationKey,
        hmacKey,
      },
      recognition: {
        type: "MATH",
        lang: "en_US",
        math: {
          mimeTypes: [
            "application/x-latex",
            "application/vnd.myscript.jiix",
          ],
          solver: { enable: false },
        },
      },
    });
    const exports = await client.send(strokes, [
      "application/x-latex",
      "application/vnd.myscript.jiix",
    ]);
    const candidates = candidatesFrom(exports, min, max);

    return Response.json(
      { value: candidates[0] ?? "", candidates },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    console.error("MyScript recognition failed", error);
    return Response.json(
      { error: "Recognition unavailable" },
      { status: 502 },
    );
  }
}
