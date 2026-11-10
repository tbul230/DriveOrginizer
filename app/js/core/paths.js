// Path helpers. Destination paths are always relative to the root of "My Drive"
// and use "/" as the separator, e.g. "School/Math/2024-2025".

export const MAX_DEPTH = 8;
export const MAX_SEGMENT = 120;

/**
 * Normalise an untrusted destination path (usually produced by the AI).
 * Returns the cleaned relative path, "" for the My Drive root, or null when the
 * path is unsafe or invalid.
 */
export function normalizeDestination(input, { maxDepth = MAX_DEPTH, maxSegment = MAX_SEGMENT } = {}) {
  if (typeof input !== 'string') return null;
  let segs = input
    .replace(/\\/g, '/')
    .split('/')
    // eslint-disable-next-line no-control-regex
    .map((s) => s.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (segs.length && /^my drive$/i.test(segs[0])) segs.shift();
  if (segs.some((s) => s === '.' || s === '..')) return null;
  if (segs.length > maxDepth) return null;
  segs = segs.map((s) => s.slice(0, maxSegment).trim());
  if (segs.some((s) => !s)) return null;
  return segs.join('/');
}

export function splitPath(rel) {
  return rel ? rel.split('/') : [];
}

export function joinPath(...parts) {
  return parts.filter((p) => p !== undefined && p !== null && p !== '').join('/');
}

export function displayPath(rel) {
  return rel ? `My Drive/${rel}` : 'My Drive';
}

/** Every ancestor path of a relative path, shortest first ("A", "A/B", "A/B/C"). */
export function prefixes(rel) {
  const segs = splitPath(rel);
  const out = [];
  for (let i = 1; i <= segs.length; i++) out.push(segs.slice(0, i).join('/'));
  return out;
}

/** School year label for a date, assuming the school year starts in August. */
export function schoolYear(dateLike, startMonth = 8) {
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  return m >= startMonth ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

/** Escape a value for use inside a single-quoted Drive query string. */
export function escapeQuery(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function fileExtension(name) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}
