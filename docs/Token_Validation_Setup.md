# Token Validation Setup

This guide captures the required environment variables and quick validation steps for the Anthropic and Google token-count APIs used by Sprint 2 missions (B2.1–B2.3).

## 1. Local Environment Variables

1. Create or update `.env.local` in the repository root (the file is already git-ignored):
   ```
   GOOGLE_GEMINI_API_KEY=<your-google-key>
   ANTHROPIC_API_KEY=<your-anthropic-key>
   ```
2. Load the variables in your shell before running validation scripts:
   ```bash
   source .env.local
   ```

## 2. Quick Validation Commands

Use these `curl` snippets to confirm both providers accept the keys and return usable token counts:

```bash
# Anthropic (Claude 3 Haiku example)
curl -s https://api.anthropic.com/v1/messages/count_tokens \
  -H "x-api-key: ${ANTHROPIC_API_KEY}" \
 -H "anthropic-version: 2023-06-01" \
  -H 'content-type: application/json' \
  -d '{"model":"claude-3-haiku-20240307","messages":[{"role":"user","content":"hello world"}]}'

# Google Generative Language (Gemini 2.5 Pro example)
curl -s -X POST "https://generativelanguage.googleapis.com/v1/models/gemini-2.5-pro:countTokens?key=${GOOGLE_GEMINI_API_KEY}" \
  -H 'content-type: application/json' \
  -d '{"contents":[{"parts":[{"text":"hello world"}]}]}'
```

Expected responses include token counts (e.g., Anthropic returns `{"input_tokens":9}`, Gemini returns `{"totalTokens":2,...}`). The project default endpoints use `claude-3-5-sonnet-20241022` and `models/gemini-2.5-pro`. Set `GOOGLE_GEMINI_MODEL_ID` if your account prefers a different Gemini model.

### Other Supported Gemini Models

The key currently has access to the following models with `countTokens` support (see `ListModels` output):

- `models/gemini-2.5-pro` (default)
- `models/gemini-2.5-flash`
- `models/gemini-2.5-flash-lite`
- `models/gemini-2.0-flash-exp`

Update the model ID in the POST URL as needed.

## 3. CI / Automation Guidance

1. Store the keys as secrets in your CI system (e.g., `ANTHROPIC_API_KEY`, `GOOGLE_GEMINI_API_KEY`).
2. Export them into the job environment before executing validation:
   ```bash
   export ANTHROPIC_API_KEY="${{ secrets.ANTHROPIC_API_KEY }}"
   export GOOGLE_GEMINI_API_KEY="${{ secrets.GOOGLE_GEMINI_API_KEY }}"
   ```
3. Optionally pin a different Gemini model for validation:
   ```bash
   export GOOGLE_GEMINI_MODEL_ID="models/gemini-2.5-flash"
   ```
4. Run the repository validation script (ships with mission B2.3):
   ```bash
   npx ts-node scripts/validate-token-counts.ts
   ```
5. Rotate the keys if validation fails with `401` or `403`, or if the `ListModels` endpoint no longer lists the expected Gemini models.
6. CI automation lives at `.github/workflows/token-validation.yml`; it executes weekly and on relevant pull requests, opening an issue if drift exceeds configured thresholds.

## 4. Troubleshooting

- **404 for Gemini models**: Run `curl "https://generativelanguage.googleapis.com/v1/models?key=${GOOGLE_GEMINI_API_KEY}"` to confirm which models support `countTokens`.
- **401/403 responses**: Verify the API is enabled for your Google project and the Anthropic key is still active.
- **Network restrictions**: Ensure outbound HTTPS calls are allowed from your environment.

Document any changes to model IDs or endpoint versions in this file to keep the validation workflow current.
