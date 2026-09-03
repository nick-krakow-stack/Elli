type RuntimeEnv = {
  OCR_SPACE_API_KEY?: string;
};

type OcrSpaceResponse = {
  ParsedResults?: Array<{
    ParsedText?: string | null;
  }>;
  IsErroredOnProcessing?: boolean;
};

const MAX_IMAGE_LENGTH = 1_400_000;

async function getRuntimeEnv(): Promise<RuntimeEnv> {
  try {
    const cloudflare = await import("cloudflare:workers");
    return cloudflare.env as unknown as RuntimeEnv;
  } catch {
    return process.env as RuntimeEnv;
  }
}

function sanitizeLimit(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(0, Math.min(999, Math.floor(number)))
    : fallback;
}

function numberCandidate(value: unknown, min: number, max: number) {
  if (typeof value !== "string") return "";

  // OCR engines frequently read a handwritten 1 as I, l, | or ! and 0 as O.
  const normalized = value
    .toUpperCase()
    .replace(/\s/g, "")
    .replace(/[IL|!]/g, "1")
    .replace(/O/g, "0")
    .replace(/^\+/, "")
    .replace(/[^0-9]/g, "");
  if (!/^\d{1,3}$/.test(normalized)) return "";

  const number = Number(normalized);
  if (!Number.isSafeInteger(number) || number < min || number > max) return "";
  return String(number);
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return Response.json({ error: "Origin not allowed" }, { status: 403 });
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_IMAGE_LENGTH + 10_000) {
    return Response.json({ error: "Image too large" }, { status: 413 });
  }

  const runtimeEnv = await getRuntimeEnv();
  const apiKey = runtimeEnv.OCR_SPACE_API_KEY?.trim();
  if (!apiKey) {
    return Response.json(
      { error: "Handwriting service is not configured" },
      { status: 503 },
    );
  }

  try {
    const payload = (await request.json()) as {
      image?: unknown;
      minValue?: unknown;
      maxValue?: unknown;
    };
    if (
      typeof payload.image !== "string" ||
      payload.image.length > MAX_IMAGE_LENGTH ||
      !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(payload.image)
    ) {
      return Response.json({ error: "Invalid image" }, { status: 400 });
    }

    const min = sanitizeLimit(payload.minValue, 0);
    const max = Math.max(min, sanitizeLimit(payload.maxValue, 99));
    const form = new FormData();
    form.set("base64Image", payload.image);
    form.set("language", "eng");
    form.set("OCREngine", "3");
    form.set("isOverlayRequired", "false");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let response: Response;
    try {
      response = await fetch("https://api.ocr.space/parse/image", {
        method: "POST",
        headers: { apikey: apiKey },
        body: form,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) throw new Error(`OCR.space returned ${response.status}`);
    const result = (await response.json()) as OcrSpaceResponse;
    if (result.IsErroredOnProcessing) {
      throw new Error("OCR.space could not process the image");
    }

    const parsedText = result.ParsedResults?.map((item) => item.ParsedText ?? "")
      .join(" ")
      .trim();
    const value = numberCandidate(parsedText, min, max);
    return Response.json(
      { value },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    console.error("OCR.space recognition failed", error);
    return Response.json({ error: "Recognition unavailable" }, { status: 502 });
  }
}
