# Meta configuration

Docs: https://dev.meta.ai/docs/quickstart · https://dev.meta.ai/docs/authentication · https://dev.meta.ai/docs/models

| Setting | Where | Default |
|---|---|---|
| `MODEL_API_KEY` | Pages **secret** (production and preview) | none (analysis pauses until it is set) |
| `META_BASE_URL` | `wrangler.toml` `[vars]` | `https://api.meta.ai/v1` |
| `META_MODEL` | `wrangler.toml` | `muse-spark-1.3` (standard mode; the `-contributor` variants may train on inputs and are not used) |
| `META_REASONING_EFFORT` | `wrangler.toml` | `medium` (`none` is rejected by Muse Spark) |
| `META_JOB_TOKEN_BUDGET` | `wrangler.toml` | 1,500,000 tokens per analysis job; Resume adds one more increment |
| `META_DAILY_TOKEN_BUDGET` | `wrangler.toml` | 3,000,000 tokens per user per UTC day |

## How the API is used

- **Request:** `POST {META_BASE_URL}/chat/completions` with `Authorization: Bearer MODEL_API_KEY` and `stream: true`. Streaming avoids the non-streaming gateway timeout; `stream_options.include_usage` is set.
- **Structured output:** `response_format: {type: "json_schema", json_schema: {name, schema, strict: true}}`. The schemas are generated from the same zod schemas that validate the output (`server/meta/schemas.ts`), so invalid output is rejected and retried.
- **Parameters:** `max_completion_tokens` is set per stage. `temperature` is left unset, as Meta recommends for Muse Spark.
- **Usage:** every call records prompt and completion tokens in `model_usage` and on the job.
- **Errors:**

  | Response | Handling |
  |---|---|
  | 401 / 403 / 402 / model not found | pause the job with a plain message |
  | 429 / 500 / 503 | retried with backoff, honouring `Retry-After` |
  | 504 | not retried as-is |
  | `finish_reason: length` | reported as truncated output |

- **Availability check:** `GET /api/meta/status` calls `GET /v1/models/{model}`. It is shown on Publisher connections.

## Setting the key

Cloudflare dashboard → Workers & Pages → **chembrain** → Settings → **Variables and Secrets** → Add → Type **Secret** → name `MODEL_API_KEY`. Add it to Production, and to Preview if you use preview deployments. Then redeploy (push a commit, or retry the latest deployment). From the CLI, `wrangler pages secret put MODEL_API_KEY --project-name chembrain` prompts for the value.

Never put the key in `wrangler.toml`, the repository, or the browser.

## Credits

Pricing: Muse Spark costs $1.25 per million input tokens and $4.25 per million output tokens (https://dev.meta.ai/docs/pricing-rate-limits). Whether hackathon credits cover the endpoint is not documented, so check the Meta developer console for your team's balance. A `402 billing_error` pauses the job with an explicit message.
