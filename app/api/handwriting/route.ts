type RuntimeEnv = {
  MOONSHOT_API_KEY?: string;
  KIMI_MODEL?: string;
  OCR_SPACE_API_KEY?: string;
};

type KimiResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
};

type OcrSpaceResponse = {
  ParsedResults?: Array<{
    ParsedText?: string | null;
  }>;
  IsErroredOnProcessing?: boolean;
};

type RecognitionResult = {
  value: string;
  alternatives: string[];
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
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= min && value <= max
      ? String(value)
      : "";
  }
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

function recognitionCandidates(values: unknown[], min: number, max: number) {
  return [
    ...new Set(
      values.map((value) => numberCandidate(value, min, max)).filter(Boolean),
    ),
  ].slice(0, 4);
}

function parseKimiContent(content: string | null | undefined) {
  if (!content) return null;
  const json = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(json) as {
      value?: unknown;
      alternatives?: unknown;
    };
  } catch {
    return null;
  }
}

async function recognizeWithKimi(
  image: string,
  min: number,
  max: number,
  apiKey: string,
  model: string,
): Promise<RecognitionResult> {
  const body = JSON.stringify({
    model,
    messages: [
      {
        role: "system",
        content:
          "You recognize handwritten whole numbers for a German primary-school math app. Read the child's intended numeral from the image. Do not solve or correct any math problem. Return JSON only.",
      },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: image },
          },
          {
            type: "text",
            text: `The image contains exactly one handwritten whole number from ${min} through ${max}. It may contain one to three digits. A German handwritten 1 may be a plain vertical stroke without a hook, and a 7 may have a crossbar. Inspect the complete shape and separated digit groups. Return {"value":"most likely number","alternatives":["up to three genuinely plausible alternatives"]}.`,
          },
        ],
      },
    ],
    // Kimi K2.6 rejects arbitrary temperature values. Disabling thinking is
    // faster for this short visual classification task and lets the model
    // answer directly without spending the small output budget on reasoning.
    thinking: { type: "disabled" },
    max_tokens: 64,
    response_format: { type: "json_object" },
    stream: false,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9_000);
  let response: Response;
  try {
    response = await fetch("https://api.moonshot.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    console.error("Kimi endpoint rejected the request", {
      host: "api.moonshot.ai",
      status: response.status,
    });
    throw new Error(`Kimi returned ${response.status}`);
  }

  const result = (await response.json()) as KimiResponse;
  const parsed = parseKimiContent(result.choices?.[0]?.message?.content);
  const alternatives = Array.isArray(parsed?.alternatives)
    ? parsed.alternatives
    : [];
  const candidates = recognitionCandidates(
    [parsed?.value, ...alternatives],
    min,
    max,
  );
  return {
    value: candidates[0] ?? "",
    alternatives: candidates.slice(1),
  };
}

async function recognizeWithOcrSpace(
  image: string,
  min: number,
  max: number,
  apiKey: string,
): Promise<RecognitionResult> {
  const form = new FormData();
  form.set("base64Image", image);
  form.set("language", "eng");
  form.set("OCREngine", "3");
  form.set("scale", "true");
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
  return {
    value: numberCandidate(parsedText, min, max),
    alternatives: [],
  };
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
    const runtimeEnv = await getRuntimeEnv();
    const kimiKey = runtimeEnv.MOONSHOT_API_KEY?.trim();
    const ocrSpaceKey = runtimeEnv.OCR_SPACE_API_KEY?.trim();
    if (!kimiKey && !ocrSpaceKey) {
      return Response.json(
        { error: "Handwriting service is not configured" },
        { status: 503 },
      );
    }

    if (kimiKey) {
      try {
        const result = await recognizeWithKimi(
          payload.image,
          min,
          max,
          kimiKey,
          runtimeEnv.KIMI_MODEL?.trim() || "kimi-k2.6",
        );
        if (result.value) {
          return Response.json(
            { ...result, provider: "kimi" },
            { headers: { "cache-control": "no-store" } },
          );
        }
      } catch (error) {
        console.error("Kimi handwriting recognition failed", error);
      }
    }

    if (ocrSpaceKey) {
      try {
        const result = await recognizeWithOcrSpace(
          payload.image,
          min,
          max,
          ocrSpaceKey,
        );
        return Response.json(
          { ...result, provider: "ocrspace" },
          { headers: { "cache-control": "no-store" } },
        );
      } catch (error) {
        console.error("OCR.space recognition failed", error);
      }
    }

    return Response.json({ error: "Recognition unavailable" }, { status: 502 });
  } catch (error) {
    console.error("Handwriting request failed", error);
    return Response.json({ error: "Recognition unavailable" }, { status: 502 });
  }
}
