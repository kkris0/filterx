import type { Settings } from "./types";

/** Writes rules from your votes. Available on the Workers Free plan, strict JSON-schema output. */
export const WRITER_MODEL = "@cf/openai/gpt-oss-120b";

const CLEF_TIMEOUT_MS = 10_000;
const WRITER_TIMEOUT_MS = 120_000;

async function post(url: string, token: string, body: unknown, timeout: number) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function endpoint(s: Settings, model: string, workerPath: string) {
  const c = s.connection;
  return c.mode === "direct"
    ? { url: `https://api.cloudflare.com/client/v4/accounts/${c.accountId}/ai/run/${model}`, token: c.apiToken, direct: true }
    : { url: `${c.workerUrl.replace(/\/+$/, "")}${workerPath}`, token: c.secret, direct: false };
}

/** One Clef decision call. Returns the model output ({ answers, usage }). */
export async function callClef(body: Record<string, unknown>, s: Settings): Promise<Record<string, unknown>> {
  const e = endpoint(s, `@cf/cloudflare/${s.model}`, "/v1/decide");
  const json = await post(e.url, e.token, body, CLEF_TIMEOUT_MS);
  // The REST API wraps the model output in { result, success, errors }.
  return e.direct ? json.result : json;
}

/** One structured-output generation call; returns the parsed JSON object. */
export async function callWriter<T>(
  messages: { role: "system" | "user"; content: string }[],
  schema: Record<string, unknown>,
  s: Settings,
): Promise<T> {
  const e = endpoint(s, WRITER_MODEL, "/v1/write");
  const json = await post(
    e.url,
    e.token,
    {
      messages,
      reasoning_effort: "medium",
      max_completion_tokens: 6_000,
      response_format: { type: "json_schema", json_schema: { name: "output", strict: true, schema } },
    },
    WRITER_TIMEOUT_MS,
  );
  const out = e.direct ? json.result : json;
  const content: string | undefined = out?.choices?.[0]?.message?.content ?? out?.response;
  if (!content) throw new Error("The writer model returned no content");
  return JSON.parse(content) as T;
}
