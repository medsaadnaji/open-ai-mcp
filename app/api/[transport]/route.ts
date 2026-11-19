import { createMcpHandler } from "mcp-handler";
import { put } from "@vercel/blob";
import { z } from "zod";

/**
 * Remote MCP server for image generation.
 *
 * Exposed by Vercel at:
 *   POST /api/mcp   (Streamable HTTP — this is the URL you give claude.ai)
 *   GET  /api/sse   (legacy SSE, also handled)
 *
 * Auth: every request must carry the shared secret, either as
 *   ?k=<MCP_SECRET>   query param   (this is what the connector URL uses)
 *   Authorization: Bearer <MCP_SECRET>   header
 * Missing/wrong secret -> 401. This keeps strangers from spending your OpenAI credits.
 *
 * Required env vars (set in Vercel project settings):
 *   OPENAI_API_KEY          your OpenAI key
 *   MCP_SECRET              a long random string you invent
 *   BLOB_READ_WRITE_TOKEN   token of a PUBLIC Vercel Blob store
 * Optional:
 *   OPENAI_IMAGE_MODEL      default model for 'auto' at low/medium quality (default "gpt-image-1.5")
 *   OPENAI_IMAGE_MODEL_HQ   model for 'auto' at high/xhigh/max quality (default "gpt-image-2.6-sunburst")
 *   OPENAI_IMAGE_MODERATION default content filtering, "low" or "auto" (default "low")
 *   OPENAI_CHAT_MODEL       chat model for design_chat (default "gpt-6.2-astra")
 */

const API_BASE = "https://api.openai.com/v1";

// Cheaper/faster default for drafts. Overridable via env.
const DEFAULT_MODEL = process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-1.5";
// Used by 'auto' when quality is high or above. 2.6 Sunburst high costs far less than gpt-image-2 high.
const HQ_MODEL = process.env.OPENAI_IMAGE_MODEL_HQ ?? "gpt-image-2.6-sunburst";

// Every OpenAI image model this server can call. Add new IDs here when OpenAI releases them.
const MODELS = [
  "auto",
  "gpt-image-1",
  "gpt-image-1-mini",
  "gpt-image-1.5",
  "gpt-image-2",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "gpt-image-2.6-flare",
  "gpt-image-2.6-sunburst",
] as const;

const MODEL_GUIDE =
  "Which OpenAI image model. 'auto' (default): gpt-image-1.5 for low/medium quality, gpt-image-2.6-sunburst for " +
  "high/xhigh/max, gpt-image-2 when the prompt contains Bengali text. " +
  "Newest: gpt-image-2.6-sunburst (best detail and edit consistency) and gpt-image-2.6-flare (fastest). " +
  "Previous generation: gpt-image-2.5-sunburst / gpt-image-2.5-flare (much cheaper than 2.6 at low/medium quality). " +
  "Older: gpt-image-2, gpt-image-1.5, gpt-image-1, gpt-image-1-mini (cheapest). Always use the model the user names.";

// Quality levels. xhigh and max only work on gpt-image-2.5 and newer.
const QUALITIES = ["low", "medium", "high", "xhigh", "max", "auto"] as const;
const QUALITY_GUIDE =
  "Cost scales with quality. Use low/medium by default; only use high or above when detail genuinely matters. " +
  "xhigh and max work only on gpt-image-2.5 and newer. Note: on 2.5/2.6 the tiers are shifted down one rung " +
  "(2.5/2.6 'high' costs about what gpt-image-2 'medium' cost; their 'max' matches the old 'high').";

const SIZE_GUIDE =
  "Image size as WIDTHxHEIGHT in pixels, or 'auto'. Presets that work on every model: 1024x1024 (square), " +
  "1024x1536 (portrait), 1536x1024 (landscape). gpt-image-2 and newer also accept custom sizes: both sides " +
  "multiples of 16, up to 3840 on the long side (e.g. 1920x1088 or 1536x864 for 16:9, 1088x1920 for 9:16, " +
  "3840x2160 for 4K). gpt-image-1, 1-mini and 1.5 only accept the three presets. Bigger sizes cost more: default to " +
  "1024x1024 unless the user asks for a size, aspect ratio or use (e.g. YouTube thumbnail, phone wallpaper, banner).";

const BACKGROUNDS = ["auto", "transparent", "opaque"] as const;
const BACKGROUND_GUIDE =
  "'transparent' gives a see-through background (logos, stickers, icons, cut-out products). Needs format png or " +
  "webp. Not every model supports it: if one refuses, retry with gpt-image-1.5 or gpt-image-2.5-sunburst.";

// Content filtering. "low" is less restrictive than OpenAI's "auto"; OpenAI's usage policies still apply.
const MODERATIONS = ["low", "auto"] as const;
type Moderation = (typeof MODERATIONS)[number];
const DEFAULT_MODERATION: Moderation =
  process.env.OPENAI_IMAGE_MODERATION === "auto" ? "auto" : "low";
const MODERATION_GUIDE =
  "Content filtering strictness. Default 'low' (less restrictive). Use 'auto' only if the user asks for the " +
  "standard, stricter filter.";

const FORMATS = ["png", "jpeg", "webp"] as const;
type Format = (typeof FORMATS)[number];
const FORMAT_GUIDE =
  "File type. png (default, lossless, supports transparency), jpeg (much smaller, good for photos and websites), " +
  "webp (small, supports transparency).";

/** Accepts 'auto' or WIDTHxHEIGHT (digits only). No regex literal, per this file's minification note. */
function isValidSize(s: string): boolean {
  if (s === "auto") return true;
  const parts = s.toLowerCase().split("x");
  if (parts.length !== 2) return false;
  return parts.every(
    (p) =>
      p.length >= 2 &&
      p.length <= 4 &&
      [...p].every((ch) => ch >= "0" && ch <= "9"),
  );
}
const sizeSchema = z
  .string()
  .refine(isValidSize, "Use WIDTHxHEIGHT, e.g. 1024x1024, or 'auto'.");

// Bengali/Bangla script renders far better on gpt-image-2. Detect by numeric
// codepoint (U+0980–U+09FF) — no regex literal, so it survives minification.
function hasBengali(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x0980 && c <= 0x09ff) return true;
  }
  return false;
}

/**
 * Model rotation.
 *  - An explicit model always wins.
 *  - Prompt contains Bengali text -> gpt-image-2 (best at that script).
 *  - "auto" + quality high/xhigh/max -> HQ_MODEL (gpt-image-2.6-sunburst).
 *  - Otherwise the cheaper/faster DEFAULT_MODEL (gpt-image-1.5).
 */
function pickModel(
  model: string | undefined,
  quality: string | undefined,
  prompt: string,
): string {
  if (model && model !== "auto") return model;
  if (hasBengali(prompt)) return "gpt-image-2";
  if (quality === "high" || quality === "xhigh" || quality === "max")
    return HQ_MODEL;
  return DEFAULT_MODEL;
}

const MIME: Record<Format, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** Work out an image's type from its first bytes (falls back to png). */
function sniffImage(buf: Buffer): { mime: string; ext: string } {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
    return { mime: "image/jpeg", ext: "jpg" };
  if (
    buf.length > 11 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  )
    return { mime: "image/webp", ext: "webp" };
  return { mime: "image/png", ext: "png" };
}

/** Download an image by URL; fail clearly if the link is a web page rather than an image. */
async function fetchImage(
  url: string,
  label: string,
): Promise<{ buf: Buffer; mime: string; ext: string }> {
  const res = await fetch(url);
  if (!res.ok)
    throw new Error(`Could not download ${label} (HTTP ${res.status}): ${url}`);
  const type = (res.headers.get("content-type") ?? "").toLowerCase();
  if (type.includes("text/html")) {
    throw new Error(
      `${label} link opened a web page, not an image. Use a direct link to the image file.`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, ...sniffImage(buf) };
}

// Image generation can take a while; give the function room (seconds).
export const maxDuration = 300;

type OpenAIImageResponse = {
  data?: Array<{ b64_json?: string; url?: string }>;
  error?: { message?: string };
};

/** Pull base64 payloads out of an OpenAI images response (also handles url-style responses). */
async function extractImages(json: OpenAIImageResponse): Promise<string[]> {
  const out: string[] = [];
  for (const item of json.data ?? []) {
    if (item.b64_json) out.push(item.b64_json);
    else if (item.url) {
      const buf = Buffer.from(await (await fetch(item.url)).arrayBuffer());
      out.push(buf.toString("base64"));
    }
  }
  if (!out.length) throw new Error("OpenAI returned no image data.");
  return out;
}

/** Upload each base64 image to Vercel Blob and return public URLs. */
async function hostImages(
  b64List: string[],
  prompt: string,
  format: Format,
): Promise<string[]> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const slug =
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "image";
  const ext = format === "jpeg" ? "jpg" : format;
  const urls: string[] = [];
  for (let i = 0; i < b64List.length; i++) {
    const name = `images/${stamp}-${slug}${b64List.length > 1 ? `-${i + 1}` : ""}.${ext}`;
    const { url } = await put(name, Buffer.from(b64List[i], "base64"), {
      access: "public",
      contentType: MIME[format],
      // BLOB_READ_WRITE_TOKEN is read from env automatically.
    });
    urls.push(url);
  }
  return urls;
}

type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

function ok(
  urls: string[],
  b64List: string[],
  modelUsed: string,
  includeB64: boolean,
  format: Format,
) {
  const header =
    urls.length === 1
      ? `Image generated with ${modelUsed}. Public URL (embed in <img src> / markdown):\n${urls[0]}`
      : `Images generated with ${modelUsed}. Public URLs:\n${urls.join("\n")}`;

  const content: Content[] = [
    { type: "text", text: header },
    // First image inline so the model can also see what it made.
    { type: "image", data: b64List[0], mimeType: MIME[format] },
  ];

  if (includeB64) {
    // For egress-restricted sandboxes that get a 403 fetching the Blob URL:
    // hand over the raw base64 so they can decode it to a file locally.
    content.push({
      type: "text",
      text:
        `Raw base64 ${format.toUpperCase()} (decode to a file for in-sandbox compositing, no network fetch):\n` +
        b64List
          .map((b, i) => `--- image ${i + 1} (base64) ---\n${b}`)
          .join("\n"),
    });
  }

  return { content };
}

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [
      { type: "text" as const, text: `Image request failed: ${message}` },
    ],
    isError: true,
  };
}

/** Shared output options: background, file format, compression. */
function outputOptions(
  background: (typeof BACKGROUNDS)[number] | undefined,
  output_format: Format | undefined,
  output_compression: number | undefined,
): { format: Format; opts: Record<string, string | number> } {
  let format: Format = output_format ?? "png";
  // Transparency needs png or webp; quietly fix a jpeg + transparent request.
  if (background === "transparent" && format === "jpeg") format = "png";
  const opts: Record<string, string | number> = {};
  if (background) opts.background = background;
  if (format !== "png") opts.output_format = format;
  if (output_compression !== undefined && format !== "png")
    opts.output_compression = output_compression;
  return { format, opts };
}

const compressionSchema = z
  .number()
  .int()
  .min(0)
  .max(100)
  .optional()
  .describe(
    "For jpeg/webp only: 0-100, higher = better quality and bigger file. Leave unset normally.",
  );

// Conversational design through the Responses API (design_chat tool).
const DEFAULT_CHAT_MODEL = process.env.OPENAI_CHAT_MODEL ?? "gpt-6.2-astra";
// Image models the Responses API image_generation tool accepts (no 2.6 there).
const CHAT_IMAGE_MODELS = [
  "gpt-image-2.5-sunburst",
  "gpt-image-2.5-flare",
  "gpt-image-2",
  "gpt-image-1.5",
  "gpt-image-1-mini",
] as const;

type ResponsesResult = {
  id: string;
  output?: Array<{
    type: string;
    result?: string;
    revised_prompt?: string;
    content?: Array<{ type: string; text?: string }>;
  }>;
  error?: { message?: string };
};

const handler = createMcpHandler(
  (server) => {
    server.tool(
      "generate_image",
      "Generate an image from a text prompt using OpenAI, host it, and return a PUBLIC URL you can embed " +
        "directly in HTML pages, slides, or markdown. Write a detailed prompt — subject, style, lighting, composition. " +
        "Leave model 'auto' unless the user names one. Supports custom sizes (newer models), transparent backgrounds, " +
        "and png/jpeg/webp output. Match size and quality to the NEED — do NOT default to high quality or large sizes. " +
        "If a sandbox gets a 403 fetching the returned URL, pass include_base64=true and decode the base64 to a file.",
      {
        prompt: z
          .string()
          .describe("Detailed description of the image to generate."),
        size: sizeSchema.optional().describe(SIZE_GUIDE),
        quality: z.enum(QUALITIES).optional().describe(QUALITY_GUIDE),
        n: z
          .number()
          .int()
          .min(1)
          .max(4)
          .optional()
          .describe("How many variations (default 1)."),
        model: z.enum(MODELS).optional().describe(MODEL_GUIDE),
        background: z.enum(BACKGROUNDS).optional().describe(BACKGROUND_GUIDE),
        output_format: z.enum(FORMATS).optional().describe(FORMAT_GUIDE),
        output_compression: compressionSchema,
        moderation: z.enum(MODERATIONS).optional().describe(MODERATION_GUIDE),
        include_base64: z
          .boolean()
          .optional()
          .describe(
            "Also return the raw base64 image. Use when a sandbox can't fetch the URL (403 allowlist) and you need " +
              "the bytes to composite or edit the image locally.",
          ),
      },
      async ({
        prompt,
        size,
        quality,
        n,
        model,
        background,
        output_format,
        output_compression,
        moderation,
        include_base64,
      }) => {
        try {
          const key = process.env.OPENAI_API_KEY;
          if (!key) throw new Error("OPENAI_API_KEY not set on the server.");
          const chosen = pickModel(model, quality, prompt);
          const { format, opts } = outputOptions(
            background,
            output_format,
            output_compression,
          );
          const body: Record<string, unknown> = {
            model: chosen,
            prompt,
            n: n ?? 1,
            moderation: moderation ?? DEFAULT_MODERATION,
            ...opts,
          };
          if (size) body.size = size;
          if (quality) body.quality = quality;

          const res = await fetch(`${API_BASE}/images/generations`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${key}`,
            },
            body: JSON.stringify(body),
          });
          const json = (await res.json()) as OpenAIImageResponse;
          if (!res.ok)
            throw new Error(json?.error?.message ?? `HTTP ${res.status}`);

          const images = await extractImages(json);
          return ok(
            await hostImages(images, prompt, format),
            images,
            chosen,
            !!include_base64,
            format,
          );
        } catch (err) {
          return fail(err);
        }
      },
    );

    server.tool(
      "edit_image",
      "Edit an existing image, or combine several reference images into a new one, using a text instruction. " +
        "Images are given by PUBLIC URL (direct image links). Pass extra images in reference_urls, e.g. 'put the " +
        "product from image 2 into the scene of image 1'. Optionally supply a mask URL (transparent pixels mark the " +
        "region to change; applies to the first image). Hosts the result and returns a new PUBLIC URL.",
      {
        image_url: z
          .string()
          .url()
          .describe("Public URL of the main image (image 1)."),
        reference_urls: z
          .array(z.string().url())
          .max(15)
          .optional()
          .describe(
            "Extra reference images (public URLs), in order: image 2, image 3, ... Refer to them by number in the prompt.",
          ),
        prompt: z
          .string()
          .describe("What to change, or how to combine the images."),
        mask_url: z
          .string()
          .url()
          .optional()
          .describe("Public URL of an optional PNG mask (for image 1)."),
        size: sizeSchema.optional().describe(SIZE_GUIDE),
        quality: z.enum(QUALITIES).optional().describe(QUALITY_GUIDE),
        model: z.enum(MODELS).optional().describe(MODEL_GUIDE),
        input_fidelity: z
          .enum(["low", "high"])
          .optional()
          .describe(
            "'high' keeps faces, logos and fine details from the input images more faithfully (costs a little more). " +
              "Not every model supports it (e.g. 2.6 does not); if the model refuses it, the tool drops it and retries.",
          ),
        background: z.enum(BACKGROUNDS).optional().describe(BACKGROUND_GUIDE),
        output_format: z.enum(FORMATS).optional().describe(FORMAT_GUIDE),
        output_compression: compressionSchema,
        moderation: z.enum(MODERATIONS).optional().describe(MODERATION_GUIDE),
        include_base64: z
          .boolean()
          .optional()
          .describe(
            "Also return the raw base64 image (for sandboxes that get a 403 fetching the URL).",
          ),
      },
      async ({
        image_url,
        reference_urls,
        prompt,
        mask_url,
        size,
        quality,
        model,
        input_fidelity,
        background,
        output_format,
        output_compression,
        moderation,
        include_base64,
      }) => {
        try {
          const key = process.env.OPENAI_API_KEY;
          if (!key) throw new Error("OPENAI_API_KEY not set on the server.");
          const chosen = pickModel(model, quality, prompt);
          const { format, opts } = outputOptions(
            background,
            output_format,
            output_compression,
          );

          const urls = [image_url, ...(reference_urls ?? [])];
          const inputs = await Promise.all(
            urls.map((u, i) => fetchImage(u, `Image ${i + 1}`)),
          );

          const mask = mask_url ? await fetchImage(mask_url, "Mask") : null;
          // Optional settings some models reject. If OpenAI names one, drop it and try again.
          const optional = {
            moderation: true,
            input_fidelity: !!input_fidelity,
          };
          const buildForm = () => {
            const form = new FormData();
            form.append("model", chosen);
            form.append("prompt", prompt);
            const field = inputs.length > 1 ? "image[]" : "image";
            inputs.forEach((img, i) => {
              form.append(
                field,
                new Blob([new Uint8Array(img.buf)], { type: img.mime }),
                `image-${i + 1}.${img.ext}`,
              );
            });
            if (mask) {
              form.append(
                "mask",
                new Blob([new Uint8Array(mask.buf)], { type: mask.mime }),
                `mask.${mask.ext}`,
              );
            }
            if (size) form.append("size", size);
            if (quality) form.append("quality", quality);
            if (optional.input_fidelity && input_fidelity)
              form.append("input_fidelity", input_fidelity);
            for (const [k, v] of Object.entries(opts))
              form.append(k, String(v));
            if (optional.moderation)
              form.append("moderation", moderation ?? DEFAULT_MODERATION);
            return form;
          };

          const send = async () => {
            const res = await fetch(`${API_BASE}/images/edits`, {
              method: "POST",
              headers: { Authorization: `Bearer ${key}` },
              body: buildForm(),
            });
            return { res, json: (await res.json()) as OpenAIImageResponse };
          };
          let { res, json } = await send();
          // Retry without an optional setting the model does not support (same model, same prompt).
          for (let attempt = 0; attempt < 2 && !res.ok; attempt++) {
            const msg = (json?.error?.message ?? "").toLowerCase();
            const unsupported = (
              Object.keys(optional) as Array<keyof typeof optional>
            ).find((k) => optional[k] && msg.includes(k));
            if (!unsupported) break;
            optional[unsupported] = false;
            ({ res, json } = await send());
          }
          if (!res.ok)
            throw new Error(json?.error?.message ?? `HTTP ${res.status}`);

          const images = await extractImages(json);
          return ok(
            await hostImages(images, prompt, format),
            images,
            chosen,
            !!include_base64,
            format,
          );
        } catch (err) {
          return fail(err);
        }
      },
    );

    server.tool(
      "design_chat",
      "Talk to an OpenAI chat model that designs images with its built-in image generation tool, through the " +
        "Responses API. Unlike generate_image, it keeps a conversation: pass the session_id from the previous " +
        "reply to continue, and the chat model remembers the brief, every earlier message and every image it made, " +
        "and can refine them. Use it for iterative design work (logos, brand visuals). Start a new session by " +
        "leaving session_id empty. Returns the chat model's reply, the image's public URL, the prompt it actually " +
        "sent to the image model, and the session_id to continue.",
      {
        message: z
          .string()
          .describe(
            "What to say to the designer: the brief on the first turn, feedback on later turns.",
          ),
        session_id: z
          .string()
          .optional()
          .describe(
            "The session_id from the previous design_chat reply, to continue that conversation.",
          ),
        reference_urls: z
          .array(z.string().url())
          .max(10)
          .optional()
          .describe(
            "Public image URLs to show the designer with this message (references, earlier drafts).",
          ),
        image_model: z
          .enum(CHAT_IMAGE_MODELS)
          .optional()
          .describe(
            "Image model the designer uses. Default gpt-image-2.5-sunburst. The Responses API does not offer 2.6.",
          ),
        chat_model: z
          .string()
          .optional()
          .describe(
            `OpenAI chat model that leads the conversation. Default ${DEFAULT_CHAT_MODEL}.`,
          ),
        make_image: z
          .boolean()
          .optional()
          .describe(
            "true (default): the designer must produce an image this turn. false: it may answer in words only " +
              "(to discuss ideas before drawing).",
          ),
        size: sizeSchema.optional().describe(SIZE_GUIDE),
        quality: z.enum(QUALITIES).optional().describe(QUALITY_GUIDE),
        background: z.enum(BACKGROUNDS).optional().describe(BACKGROUND_GUIDE),
      },
      async ({
        message,
        session_id,
        reference_urls,
        image_model,
        chat_model,
        make_image,
        size,
        quality,
        background,
      }) => {
        try {
          const key = process.env.OPENAI_API_KEY;
          if (!key) throw new Error("OPENAI_API_KEY not set on the server.");
          const imageModel = image_model ?? "gpt-image-2.5-sunburst";
          const chatModel = chat_model ?? DEFAULT_CHAT_MODEL;

          const refs = await Promise.all(
            (reference_urls ?? []).map((u, i) =>
              fetchImage(u, `Reference ${i + 1}`),
            ),
          );
          const content: Array<Record<string, string>> = [
            { type: "input_text", text: message },
          ];
          for (const r of refs) {
            content.push({
              type: "input_image",
              image_url: `data:${r.mime};base64,${r.buf.toString("base64")}`,
            });
          }

          const tool: Record<string, string> = {
            type: "image_generation",
            model: imageModel,
          };
          if (size) tool.size = size;
          if (quality) tool.quality = quality;
          if (background) tool.background = background;

          const body: Record<string, unknown> = {
            model: chatModel,
            input: [{ role: "user", content }],
            tools: [tool],
          };
          if (session_id) body.previous_response_id = session_id;
          if (make_image !== false)
            body.tool_choice = { type: "image_generation" };

          const res = await fetch(`${API_BASE}/responses`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${key}`,
            },
            body: JSON.stringify(body),
          });
          const json = (await res.json()) as ResponsesResult;
          if (!res.ok)
            throw new Error(json?.error?.message ?? `HTTP ${res.status}`);

          const texts: string[] = [];
          const images: Array<{ b64: string; revised?: string }> = [];
          for (const item of json.output ?? []) {
            if (item.type === "image_generation_call" && item.result) {
              images.push({ b64: item.result, revised: item.revised_prompt });
            } else if (item.type === "message") {
              for (const c of item.content ?? [])
                if (c.text) texts.push(c.text);
            }
          }

          const urls = images.length
            ? await hostImages(
                images.map((i) => i.b64),
                message,
                "png",
              )
            : [];
          const lines = [
            `session_id: ${json.id}`,
            `Chat model: ${chatModel}. Image model: ${imageModel}.`,
          ];
          if (texts.length)
            lines.push(`Designer's reply:\n${texts.join("\n")}`);
          images.forEach((img, i) => {
            lines.push(`Image ${i + 1} URL:\n${urls[i]}`);
            if (img.revised)
              lines.push(`Prompt sent to the image model:\n${img.revised}`);
          });
          if (!images.length) lines.push("No image this turn.");

          const out: Content[] = [{ type: "text", text: lines.join("\n\n") }];
          if (images.length)
            out.push({
              type: "image",
              data: images[0].b64,
              mimeType: "image/png",
            });
          return { content: out };
        } catch (err) {
          return fail(err);
        }
      },
    );
  },
  {},
  {
    // The route lives at app/api/[transport]/route.ts, so it is mounted under /api.
    // mcp-handler needs to know this prefix to map /api/mcp and /api/sse correctly.
    basePath: "/api",
    maxDuration: 300,
  },
);

/** Shared-secret gate. Accepts ?k=<secret> or Authorization: Bearer <secret>. */
function authorized(req: Request): boolean {
  const secret = process.env.MCP_SECRET;
  if (!secret) return false; // fail closed if the server is misconfigured
  const url = new URL(req.url);
  const fromQuery = url.searchParams.get("k");
  const fromHeader = req.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "");
  return fromQuery === secret || fromHeader === secret;
}

async function guarded(req: Request): Promise<Response> {
  if (!authorized(req)) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="openai-image-mcp"' },
    });
  }
  return handler(req);
}

export { guarded as GET, guarded as POST, guarded as DELETE };
