import { put } from "@vercel/blob";

/**
 * Upload endpoint for the /upload page.
 *
 *   POST /api/upload?k=<MCP_SECRET>   body: the raw image bytes
 *
 * Stores the image in the public Blob store under uploads/ and returns
 * { url }, a public link that edit_image and design_chat accept as a reference.
 * Protected by the same shared secret as the MCP endpoint.
 */

const MAX_BYTES = 4_400_000; // Vercel functions accept request bodies up to ~4.5 MB.

function authorized(req: Request): boolean {
  const secret = process.env.MCP_SECRET;
  if (!secret) return false;
  const fromQuery = new URL(req.url).searchParams.get("k");
  const fromHeader = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return fromQuery === secret || fromHeader === secret;
}

/** Image type from the file's first bytes; null if it is not a supported image. */
function sniff(buf: Buffer): { mime: string; ext: string } | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (buf.length > 8 && buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") return { mime: "image/png", ext: "png" };
  if (buf.length > 11 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP")
    return { mime: "image/webp", ext: "webp" };
  return null;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function POST(req: Request): Promise<Response> {
  if (!authorized(req)) return json({ error: "Wrong or missing password." }, 401);
  try {
    const buf = Buffer.from(await req.arrayBuffer());
    if (buf.length > MAX_BYTES) return json({ error: "Image too large (over 4.4 MB)." }, 413);
    const type = sniff(buf);
    if (!type) return json({ error: "Not a JPEG, PNG or WebP image." }, 415);

    const rawName = new URL(req.url).searchParams.get("name") ?? "reference";
    const slug =
      rawName.toLowerCase().replace(/\.[a-z0-9]+$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) ||
      "reference";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

    const { url } = await put(`uploads/${stamp}-${slug}.${type.ext}`, buf, {
      access: "public",
      contentType: type.mime,
      addRandomSuffix: true,
    });
    return json({ url });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}
