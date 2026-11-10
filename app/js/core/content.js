// Reads a short text excerpt from files so they can be classified by content,
// not only by file name. Read-only: uses files.export and alt=media downloads.
import { kindOf } from './driveIndex.js';

const TEXT_MIMES = /^(text\/|application\/(json|xml|x-yaml|rtf))/;

export function readableKind(item, { pdfMaxBytes = 8 * 1024 * 1024 } = {}) {
  const k = kindOf(item);
  if (k === 'doc' || k === 'slides') return { kind: k, how: 'export', mime: 'text/plain' };
  if (k === 'sheet') return { kind: k, how: 'export', mime: 'text/csv' };
  if (k === 'pdf') {
    const size = Number(item.size || 0);
    if (size > 0 && size <= pdfMaxBytes) return { kind: k, how: 'pdf' };
    return null;
  }
  if (TEXT_MIMES.test(item.mimeType || '')) return { kind: 'text', how: 'range' };
  return null;
}

export function cleanText(text, maxChars) {
  return String(text || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

let pdfjsPromise = null;
function loadPdfJs() {
  if (typeof window === 'undefined') return Promise.reject(new Error('PDF reading needs a browser'));
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (!pdfjsPromise) {
    pdfjsPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = new URL('../../vendor/pdfjs/pdf.min.js', import.meta.url).toString();
      s.onload = () => {
        const lib = window.pdfjsLib;
        if (!lib) return reject(new Error('pdf.js failed to load'));
        lib.GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdfjs/pdf.worker.min.js', import.meta.url).toString();
        resolve(lib);
      };
      s.onerror = () => { pdfjsPromise = null; reject(new Error('pdf.js failed to load')); };
      document.head.appendChild(s);
    });
  }
  return pdfjsPromise;
}

async function pdfText(buffer, maxChars) {
  const lib = await loadPdfJs();
  // isEvalSupported:false hardens pdf.js against malicious font programs.
  const doc = await lib.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, disableFontFace: true }).promise;
  let text = '';
  const pages = Math.min(doc.numPages, 3);
  for (let i = 1; i <= pages && text.length < maxChars; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    text += ' ' + tc.items.map((it) => it.str).join(' ');
  }
  doc.destroy?.();
  return text;
}

/** Read one file's excerpt (throws on failure). */
export async function readSnippet(client, item, { maxChars = 700, pdfMaxBytes, signal } = {}) {
  const how = readableKind(item, { pdfMaxBytes });
  if (!how) return null;
  if (how.how === 'export') {
    const text = await client.exportText(item.id, how.mime, { signal });
    return cleanText(text, maxChars);
  }
  if (how.how === 'range') {
    const buf = await client.download(item.id, { range: [0, 16383], signal });
    return cleanText(new TextDecoder('utf-8', { fatal: false }).decode(buf), maxChars);
  }
  if (how.how === 'pdf') {
    const buf = await client.download(item.id, { signal });
    return cleanText(await pdfText(buf, maxChars * 2), maxChars);
  }
  return null;
}

/**
 * Read excerpts for many files with limited concurrency, caching results by
 * file id + modifiedTime so unchanged files are never downloaded twice.
 * Returns Map(fileId -> { text } | { error }).
 */
export async function extractSnippets(client, items, {
  store, maxChars = 700, maxFiles = 1500, pdfMaxBytes, concurrency = 4, onProgress, signal,
} = {}) {
  const results = new Map();
  const candidates = items.filter((it) => readableKind(it, { pdfMaxBytes })).slice(0, maxFiles);
  let done = 0;
  let cursor = 0;
  async function worker() {
    while (cursor < candidates.length) {
      if (signal?.aborted) return;
      const item = candidates[cursor++];
      try {
        const cached = store ? await store.get('snippets', item.id) : null;
        if (cached && cached.modifiedTime === item.modifiedTime && cached.chars >= maxChars) {
          results.set(item.id, { text: cached.text.slice(0, maxChars) });
        } else {
          const text = await readSnippet(client, item, { maxChars, pdfMaxBytes, signal });
          results.set(item.id, { text: text || '' });
          if (store) await store.put('snippets', { id: item.id, modifiedTime: item.modifiedTime, text: text || '', chars: maxChars });
        }
      } catch (err) {
        if (signal?.aborted) return;
        results.set(item.id, { error: err?.message || String(err) });
      }
      done++;
      onProgress?.({ done, total: candidates.length });
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return results;
}
