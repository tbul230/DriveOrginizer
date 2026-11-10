// User settings, persisted in localStorage (non-sensitive values only).
const KEY = 'driveOrganizer.settings.v1';

export const DEFAULT_SETTINGS = {
  theme: 'system',               // 'system' | 'light' | 'dark'
  googleClientId: '',            // overrides config.js when set
  aiBackendUrl: '',              // overrides config.js when set
  useAI: true,                   // false = basic (rules-based) mode
  readContents: true,            // read document text to classify files
  maxContentFiles: 1500,         // cap on files whose content is read per analysis
  snippetChars: 700,             // characters of content sent per file
  pdfMaxMB: 8,                   // skip PDFs larger than this
  conflictPolicy: 'skip',        // 'skip' | 'keepBoth' (Drive never overwrites either way)
  needsReviewFolder: 'Needs Review',
  useNeedsReviewFolder: true,    // move uncertain files into the Needs Review folder (still needs approval)
  allowRenames: true,            // allow renames ONLY when the prompt explicitly asks
  allowFolderMoves: true,        // allow moving whole folders (cycle-checked)
  includeNotOwned: true,         // include files owned by others that sit in My Drive
  backupHistoryToDrive: true,    // keep a copy of history in the app's hidden appDataFolder
  aiChunkSize: 150,
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    return { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* storage may be blocked */ }
}

export function clearSettings() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('driveOrganizer.')) localStorage.removeItem(k);
  } catch { /* ignore */ }
}

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
}
