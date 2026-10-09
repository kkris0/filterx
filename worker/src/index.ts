/**
 * filterx proxy: forwards Clef decision requests from the extension to
 * Workers AI, so no Cloudflare API token ever lives in the browser.
 *
 *   POST /v1/decide   body = Clef input ({ model, state, questions, images? })
 *   POST /v1/write    body = chat input for the rule writer ({ messages, response_format, ... })
 *   Authorization: Bearer <FILTERX_SECRET>
 */

interface Env {
  AI: Ai;
  FILTERX_SECRET?: string;
}

const MODELS = { clef: "@cf/cloudflare/clef", "clef-flash": "@cf/cloudflare/clef-flash" } as const;
/** Writes learned rules from votes; keep in sync with WRITER_MODEL in the extension. */
const WRITER_MODEL = "@cf/openai/gpt-oss-120b";
const MAX_BODY = 1_500_000;

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400",
};

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { ...cors, "cache-control": "no-store" } });

export default {
  async fetch(req, env): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(req.url);
    if (url.pathname === "/health") return json({ ok: true });
    const route = url.pathname;
    if ((route !== "/v1/decide" && route !== "/v1/write") || req.method !== "POST") return json({ error: "not found" }, 404);

    if (!env.FILTERX_SECRET) return json({ error: "FILTERX_SECRET is not set on the Worker" }, 500);
    if (!timingSafeEqual(req.headers.get("authorization") ?? "", `Bearer ${env.FILTERX_SECRET}`))
      return json({ error: "unauthorized" }, 401);

    const size = Number(req.headers.get("content-length") ?? 0);
    if (size > MAX_BODY) return json({ error: "request too large" }, 413);

    let body: { model?: string; state?: unknown; questions?: unknown; images?: unknown; messages?: unknown };
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid JSON" }, 400);
    }

    if (route === "/v1/write") {
      if (!Array.isArray(body.messages)) return json({ error: "messages are required" }, 400);
      return run(env, WRITER_MODEL, { ...body, model: undefined });
    }

    const model = MODELS[(body.model ?? "clef").trim() as keyof typeof MODELS];
    if (!model) return json({ error: `unknown model ${body.model}` }, 400);
    if (body.state === undefined || !body.questions) return json({ error: "state and questions are required" }, 400);

    return run(env, model, body);
  },
} satisfies ExportedHandler<Env>;

async function run(env: Env, model: string, input: unknown): Promise<Response> {
  try {
    return json(await env.AI.run(model as Parameters<Ai["run"]>[0], input as never));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return json({ error: message }, /rate|capacity|429/i.test(message) ? 429 : 502);
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  return crypto.subtle.timingSafeEqual(ea, eb);
}
