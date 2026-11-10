// Basic organisation mode: works without any AI service by using file names,
// file types, document excerpts and dates. Produces the same proposal shape as
// the AI planner so the same validation, preview and approval flow applies.
import { kindOf, isFolder, KIND_LABELS } from './driveIndex.js';
import { schoolYear } from './paths.js';

export const SUBJECTS = {
  English: ['english', 'ela', 'essay', 'literature', 'poem', 'poetry', 'novel', 'grammar', 'reading', 'writing', 'shakespeare', 'book report', 'vocabulary', 'rhetoric', 'thesis', 'narrative'],
  Math: ['math', 'maths', 'algebra', 'geometry', 'calculus', 'trigonometry', 'trig', 'precalc', 'pre-calc', 'statistics', 'stats', 'equation', 'equations', 'polynomial', 'fractions', 'integral', 'derivative', 'theorem', 'quadratic'],
  Science: ['science', 'biology', 'bio', 'chemistry', 'chem', 'physics', 'lab report', 'lab', 'experiment', 'hypothesis', 'cell', 'ecosystem', 'molecule', 'atom', 'photosynthesis', 'earth science', 'anatomy', 'genetics'],
  History: ['history', 'social studies', 'civics', 'government', 'apush', 'world history', 'revolution', 'civil war', 'world war', 'ancient', 'empire', 'constitution', 'geography', 'economics'],
  Spanish: ['spanish', 'español', 'espanol', 'conjugation', 'conjugations', 'vocabulario', 'preterite', 'subjunctive'],
  French: ['french', 'français', 'francais'],
  German: ['german', 'deutsch'],
  Chinese: ['chinese', 'mandarin'],
  Latin: ['latin'],
  Art: ['art', 'drawing', 'painting', 'sketch', 'design'],
  Music: ['music', 'band', 'orchestra', 'choir', 'sheet music'],
  'Computer Science': ['computer science', 'coding', 'programming', 'python', 'javascript', 'java', 'algorithm', 'apcsp', 'apcsa'],
  Health: ['health', 'nutrition', 'physical education', 'pe '],
  Robotics: ['robotics', 'robot', 'fll', 'ftc', 'frc', 'vex', 'ev3', 'spike prime', 'lego'],
};

const SCHOOL_HINTS = ['homework', 'hw', 'assignment', 'worksheet', 'quiz', 'test', 'exam', 'notes', 'study guide', 'project', 'essay', 'lab', 'class', 'period', 'unit', 'chapter', 'lesson', 'midterm', 'final', 'rubric', 'syllabus', 'grade'];

const TYPE_FOLDERS = {
  doc: 'Documents', word: 'Documents', text: 'Documents', sheet: 'Spreadsheets', excel: 'Spreadsheets',
  slides: 'Presentations', powerpoint: 'Presentations', pdf: 'PDFs', image: 'Images', video: 'Videos',
  audio: 'Audio', archive: 'Archives', form: 'Forms', drawing: 'Drawings',
};

function hasWord(text, kw) {
  const esc = kw.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i').test(text);
}

/** Parse the free-text instruction into options for basic mode. */
export function parseInstruction(instruction) {
  const t = ` ${String(instruction || '').toLowerCase()} `;
  const intent = {
    duplicates: /duplicate|dupes|copies/.test(t),
    stale: /haven'?t (opened|used|touched)|not (opened|used)|unused|long time|unnecessary|old files|stale/.test(t),
    byType: /by (file )?type|by format|file types?\b|by kind/.test(t),
    byYear: /school year|by year|each year|per year|grade level/.test(t),
    pdfOnly: /\b(move|sort|organi[sz]e) (all )?(of )?(my )?(the )?pdfs?\b/.test(t) || /\bonly (my |the )?pdfs?\b/.test(t),
    school: /school|class|subject|assignment|homework/.test(t),
    organize: /organi[sz]e|sort|folder|put|move|separate|group|arrange|clean/.test(t),
  };
  // Subjects explicitly named in the prompt.
  const named = [];
  for (const subject of Object.keys(SUBJECTS)) {
    if (hasWord(t, subject.toLowerCase())) named.push(subject);
  }
  // Extra comma-separated categories the dictionary doesn't know
  // e.g. "folders for FLL seasons, projects, presentations, and research".
  const custom = [];
  const m = /(?:folders? for|separate|into|categories?:?|by)\s+([^.]*?)(?:\.|$)/i.exec(String(instruction || ''));
  if (m && /,/.test(m[1])) {
    for (let part of m[1].split(/,|\band\b|\bor\b/)) {
      part = part.replace(/^(the|my|a|an|other)\s+/i, '').replace(/\s+(subjects?|classes|folders?)$/i, '').trim();
      if (!part || part.length > 40 || /^(other|etc)$/i.test(part)) continue;
      const title = part.replace(/\b\w/g, (c) => c.toUpperCase());
      if (!named.includes(title) && !Object.keys(SUBJECTS).some((s) => s.toLowerCase() === part.toLowerCase())) custom.push(title);
    }
  }
  intent.otherBucket = /\bother\b/.test(t);
  return { intent, categories: [...named, ...custom] };
}

function scoreCategories(text, categories) {
  const scores = [];
  for (const cat of categories) {
    const kws = SUBJECTS[cat] || [cat.toLowerCase(), ...cat.toLowerCase().split(/\s+/).filter((w) => w.length > 3)];
    let s = 0;
    for (const kw of kws) {
      if (hasWord(text.name, kw)) s += 3;
      if (text.body && hasWord(text.body, kw)) s += 1;
    }
    if (s > 0) scores.push({ cat, s });
  }
  scores.sort((a, b) => b.s - a.s);
  return scores;
}

/**
 * @param {DriveIndex} index
 * @param {object[]} items    items in scope (files and folders)
 * @param {string} instruction
 * @param {Map} snippets      fileId -> { text }
 */
export function planWithRules(index, items, instruction, snippets = new Map(), { now = Date.now() } = {}) {
  const { intent, categories } = parseInstruction(instruction);
  const proposals = { moves: [], renames: [], needsReview: [], flagged: [], notes: [] };
  const files = items.filter((it) => !isFolder(it));

  if (intent.stale) {
    const yearMs = 365 * 24 * 3600 * 1000;
    for (const f of files) {
      const viewed = f.viewedByMeTime ? Date.parse(f.viewedByMeTime) : null;
      const modified = Date.parse(f.modifiedTime || f.createdTime || 0);
      if ((viewed && now - viewed > yearMs) || (!viewed && now - modified > yearMs)) {
        const when = viewed ? `last opened ${new Date(viewed).toLocaleDateString()}` : `never opened by you; last modified ${new Date(modified).toLocaleDateString()}`;
        proposals.flagged.push({ fileId: f.id, reason: `Possibly unnecessary: ${when}` });
      }
    }
    proposals.notes.push(`Flagged ${proposals.flagged.length} file(s) not opened in over a year. Flagged files are only shown to you; nothing is moved or deleted.`);
  }

  const wantsMoves = intent.organize && (intent.byType || categories.length || intent.school);
  if (!wantsMoves) {
    if (!intent.stale && !intent.duplicates) {
      proposals.notes.push('Basic mode could not find organisation rules in your instructions. Try naming the categories you want (e.g. "Separate Math, Science and English") or "organize by file type".');
    }
    return proposals;
  }

  const scoped = intent.pdfOnly ? files.filter((f) => kindOf(f) === 'pdf') : files;
  const base = intent.school && !intent.byType ? 'School' : '';

  for (const f of scoped) {
    const k = kindOf(f);
    if (intent.byType) {
      const folder = TYPE_FOLDERS[k] || 'Other Files';
      let dest = [base, folder].filter(Boolean).join('/');
      if (intent.byYear) dest += `/${schoolYear(f.createdTime || f.modifiedTime) || 'Unknown Year'}`;
      proposals.moves.push({ fileId: f.id, destination: dest, reason: `File type: ${KIND_LABELS[k] || 'file'}`, confidence: 'high' });
      continue;
    }
    const text = { name: ` ${f.name.toLowerCase()} `, body: snippets.get(f.id)?.text?.toLowerCase() || '' };
    const cats = categories.length ? categories : Object.keys(SUBJECTS);
    const scores = scoreCategories(text, cats);
    const top = scores[0];
    const tie = scores[1] && scores[1].s === top?.s;
    const looksSchool = SCHOOL_HINTS.some((h) => hasWord(text.name, h) || (text.body && hasWord(text.body.slice(0, 300), h)));
    if (top && !tie && top.s >= 2) {
      let dest = [base, top.cat].filter(Boolean).join('/');
      if (intent.byYear) dest += `/${schoolYear(f.createdTime || f.modifiedTime) || 'Unknown Year'}`;
      const conf = top.s >= 3 ? 'high' : 'medium';
      proposals.moves.push({
        fileId: f.id, destination: dest, confidence: conf,
        reason: `Keyword match for ${top.cat} in the ${top.s >= 3 ? 'file name' : 'document text'}${intent.byYear ? '; school year from the file’s creation date' : ''}`,
      });
    } else if (looksSchool || (top && tie)) {
      proposals.needsReview.push({
        fileId: f.id,
        reason: tie ? `Matches more than one category (${scores.slice(0, 2).map((s) => s.cat).join(', ')})` : 'Looks like schoolwork but the subject could not be determined',
      });
    }
  }
  proposals.notes.push('Basic mode (no AI) uses keywords from file names and document text. Files it does not recognise are left where they are.');
  return proposals;
}
