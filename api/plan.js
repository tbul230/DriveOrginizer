// Vercel Function: AI planning endpoint. Same logic as the Cloudflare Worker.
// Configure ANTHROPIC_API_KEY (sensitive), GOOGLE_CLIENT_ID and optionally
// ALLOWED_EMAILS / MODEL / EFFORT in Vercel → Project → Settings → Environment Variables.
import worker from '../worker/worker.js';

const handle = (request) => worker.fetch(request, process.env);
export const POST = handle;
export const OPTIONS = handle;
