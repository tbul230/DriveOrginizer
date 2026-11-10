// Vercel Function: backend health check used by the website and Settings → Test connection.
import worker from '../worker/worker.js';

const handle = (request) => worker.fetch(request, process.env);
export const GET = handle;
export const OPTIONS = handle;
