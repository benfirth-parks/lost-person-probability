import { z } from 'zod';

/**
 * Turns a planner's plain-language incident description into search-map form
 * fields, sending only what the approved-fields decision allows.
 *
 * The text is cleaned in the browser first (names, contact details and health
 * words removed). A reader service then returns at most the planning point,
 * its kind, the direction of travel and a subject category. Every other key in
 * its reply is discarded, and nothing it returns is used until the planner
 * confirms it in the form. Ring distances and dispersion angles never come
 * from a reader: they keep a named source.
 */
export const INTAKE_VERSION = 'intake@0.1.0';

/** Generic activity categories a reader may return. Health-related categories are chosen by the planner and never sent. */
export const SUBJECT_CATEGORIES = [
  'hiker',
  'hunter',
  'climber',
  'skier',
  'snowshoer',
  'mountain biker',
  'angler',
  'gatherer',
  'runner',
  'camper',
  'child',
  'youth',
  'other',
] as const;
export type SubjectCategory = (typeof SUBJECT_CATEGORIES)[number];

export const PLACE_WORDS = [
  'Lake', 'Lakes', 'Canyon', 'Creek', 'River', 'Mountain', 'Mount', 'Mt', 'Peak', 'Pass', 'Valley', 'Trail', 'Trailhead',
  'Glacier', 'Falls', 'Ridge', 'Park', 'Road', 'Highway', 'Hwy', 'Campground', 'Meadow', 'Meadows', 'Basin', 'Col', 'Icefield',
  'Parkway', 'Junction', 'Lodge', 'Hut', 'Bridge', 'Parking', 'Lot', 'Summit', 'Notch', 'Bay', 'Point', 'Island', 'Hill',
];

const HEALTH = [
  'dementia', 'alzheimer\\w*', 'autis\\w*', 'diabet\\w*', 'insulin', 'epilep\\w*', 'seizure\\w*', 'medicat\\w*', 'medical',
  'prescri\\w*', 'depress\\w*', 'suicid\\w*', 'despondent', 'mental(?:ly)?', 'psychiatr\\w*', 'schizo\\w*', 'bipolar',
  'anxiety', 'pregnan\\w*', 'heart condition', 'cardiac', 'stroke', 'asthma\\w*', 'disabilit\\w*', 'disabled',
  'cognitive\\w*', 'impair\\w*', 'overdose', 'drug\\w*', 'alcohol\\w*', 'intoxicat\\w*', 'drunk',
];

const PHONE = /(?<!\d|\d\.)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d|\.\d)/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const HEALTH_RE = new RegExp(`\\b(?:${HEALTH.join('|')})\\b`, 'gi');
const TITLED = /\b(?:Mr|Mrs|Ms|Miss|Dr)\.?\s+[A-Z][\w'-]*/g;
const CAPITALISED_RUN = /\b[A-Z][a-z'’-]+(?:\s+[A-Z][a-z'’-]+)*\b/g;
/** Capitalised words that are kept on their own: sentence openers, pronouns, days and months. Any other capitalised word outside a place name is treated as a name. */
const COMMON = new Set(
  (
    'The A An At On In Of To From By For With Without Near After Before During Around About Over Under Up Down Last First Then When While ' +
    'Where Who What Which Why How He She They It We I You His Her Their Its Our My Your This That These Those There Here Subject ' +
    'Party Group Searcher Searchers Team Teams Was Were Is Are Has Had Have Not No Yes And But Or So If Also Seen Found Reported ' +
    'Called Left Started Planned Expected Overdue Missing Last Possibly Probably Likely Unknown Approx Approximately About Around Plan ' +
    'Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July August September October ' +
    'November December Morning Afternoon Evening Night Today Yesterday Tonight Weather Car Vehicle Truck Male Female Adult Adults Age Aged Partner Friend Friends Father Mother Husband Wife Son Daughter Brother Sister Parent Parents Spouse Call Contact Phone Email Text'
  ).split(' '),
);
const PLACE_RE = new RegExp(`\\b(?:${PLACE_WORDS.join('|')})\\b`);

export interface Redaction {
  text: string;
  /** How many of each kind were removed. Counts only, so the removed text is never kept. */
  removed: { phone: number; email: number; name: number; health: number };
}

/**
 * Removes contact details, name-like word runs and health words. Deliberately
 * over-eager: a removed place name costs a retype, a sent name costs a breach.
 * Pure; the input is not changed.
 */
export function redactIncidentText(input: string): Redaction {
  const removed = { phone: 0, email: 0, name: 0, health: 0 };
  let text = input.replace(EMAIL, () => (removed.email++, '[contact]'));
  text = text.replace(PHONE, () => (removed.phone++, '[contact]'));
  text = text.replace(TITLED, () => (removed.name++, '[person]'));
  text = text.replace(CAPITALISED_RUN, (run) =>
    PLACE_RE.test(run) || run.split(/\s+/).every((w) => COMMON.has(w)) ? run : (removed.name++, '[person]'),
  );
  text = text.replace(HEALTH_RE, () => (removed.health++, '[health]'));
  return { text, removed };
}

/** Instructions sent with the cleaned text. The reply is still checked against IntakeReply; this text is not trusted to hold. */
export const INTAKE_INSTRUCTIONS = [
  'You read a short land-search incident description and return JSON only, with no other text.',
  'Allowed keys, each optional: "lat" and "lng" (decimal degrees of the planning point),',
  '"pointKind" ("IPP", "LKP" or "PLS"), "travelBearingDeg" (0 to 360, degrees true, only if a direction of travel is stated),',
  `"subjectCategory" (one of: ${SUBJECT_CATEGORIES.join(', ')}).`,
  'Omit any key you are not sure of. Never estimate distances, probabilities, ring sizes or angles. Never add other keys.',
].join(' ');

export const IntakeReply = z.object({
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  pointKind: z.enum(['IPP', 'LKP', 'PLS']).optional(),
  travelBearingDeg: z.number().min(0).max(360).optional(),
  subjectCategory: z.enum(SUBJECT_CATEGORIES).optional(),
});
export type IntakeFields = z.infer<typeof IntakeReply>;

const ALLOWED_KEYS = Object.keys(IntakeReply.shape);

export interface IntakeResult {
  fields: IntakeFields;
  /** Keys the reader returned that are not allowed, or whose values failed the checks. Names only. */
  discarded: string[];
}

/** Keeps only the allowed, valid fields from a reader's reply. Anything else is dropped and named. */
export function parseIntakeReply(reply: unknown): IntakeResult {
  let obj: unknown = reply;
  if (typeof reply === 'string') {
    try {
      obj = JSON.parse(reply.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
    } catch {
      return { fields: {}, discarded: ['(reply was not JSON)'] };
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { fields: {}, discarded: ['(reply was not an object)'] };
  const fields: Record<string, unknown> = {};
  const discarded: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (!ALLOWED_KEYS.includes(k)) {
      discarded.push(k);
      continue;
    }
    const one = IntakeReply.shape[k as keyof IntakeFields].safeParse(v);
    if (one.success && one.data !== undefined) fields[k] = one.data;
    else discarded.push(k);
  }
  // A point needs both halves.
  if ((fields.lat === undefined) !== (fields.lng === undefined)) {
    discarded.push(fields.lat === undefined ? 'lng' : 'lat');
    delete fields.lat;
    delete fields.lng;
  }
  return { fields: fields as IntakeFields, discarded };
}

/** Something that turns cleaned text into a reply. An approved AI service plugs in here after sign-off. */
export interface IntakeReader {
  /** Shown to the planner next to the button, so they know where the text goes. */
  name: string;
  /** False until the service is approved. A reader that is not enabled must not be called. */
  enabled: boolean;
  read(cleanedText: string, instructions: string): Promise<unknown>;
}

/** Placeholder until decision 12 names an approved service. */
export const AI_READER_NOT_APPROVED: IntakeReader = {
  name: 'AI service (not yet approved)',
  enabled: false,
  read: () => Promise.reject(new Error('No AI service has been approved for incident text. See decision 12.')),
};

const COMPASS: Record<string, number> = {
  north: 0, 'north-northeast': 22.5, 'northeast': 45, 'north-east': 45, 'east-northeast': 67.5, east: 90, 'east-southeast': 112.5,
  southeast: 135, 'south-east': 135, 'south-southeast': 157.5, south: 180, 'south-southwest': 202.5, southwest: 225,
  'south-west': 225, 'west-southwest': 247.5, west: 270, 'west-northwest': 292.5, northwest: 315, 'north-west': 315, 'north-northwest': 337.5,
};
const COMPASS_ABBR: Record<string, number> = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5, S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 };
const CATEGORY_WORDS: Array<[RegExp, SubjectCategory]> = [
  [/\bhik(?:er|ing)\b/i, 'hiker'],
  [/\bhunt(?:er|ing)\b/i, 'hunter'],
  [/\bclimb(?:er|ing)\b|\bscrambl(?:er|ing)\b/i, 'climber'],
  [/\bski(?:er|ing)\b|\bsplitboard/i, 'skier'],
  [/\bsnowshoe/i, 'snowshoer'],
  [/\bmountain bik|\bbik(?:er|ing)\b/i, 'mountain biker'],
  [/\bangl(?:er|ing)\b|\bfish(?:er|ing)\b/i, 'angler'],
  [/\b(?:berry|mushroom)\b|\bgather(?:er|ing)\b/i, 'gatherer'],
  [/\brun(?:ner|ning)\b|\btrail run/i, 'runner'],
  [/\bcamp(?:er|ing)\b/i, 'camper'],
];

/**
 * A reader that runs in the browser with simple patterns and no AI. It finds
 * decimal coordinates, a stated direction of travel and an activity word. It
 * is the default, and the way to try the flow before any service is approved.
 */
export const LOCAL_READER: IntakeReader = {
  name: 'Pattern reader in this browser (no AI)',
  enabled: true,
  read: async (text) => {
    const out: Record<string, unknown> = {};
    const ll = text.match(/(-?\d{1,2}\.\d{3,})\s*°?\s*([NS])?\s*[,;/ ]\s*(-?\d{1,3}\.\d{3,})\s*°?\s*([EW])?/i);
    if (ll) {
      const lat = Number(ll[1]) * (/s/i.test(ll[2] ?? '') ? -1 : 1);
      const lng = Number(ll[3]) * (/w/i.test(ll[4] ?? '') && Number(ll[3]) > 0 ? -1 : 1);
      Object.assign(out, { lat, lng });
    }
    const kind = text.match(/\b(IPP|LKP|PLS)\b/);
    if (kind) out.pointKind = kind[1];
    const dir = text.match(/\b(?:heading|headed|travel(?:l)?ing|walking|went|going|direction(?: of travel)?(?: was)?)\s+(?:to(?:wards?)?\s+(?:the\s+)?)?([a-z-]+|[NSEW]{1,3})\b/i);
    if (dir) {
      const w = dir[1]!;
      const deg = COMPASS[w.toLowerCase()] ?? COMPASS_ABBR[w.toUpperCase()];
      if (deg !== undefined) out.travelBearingDeg = deg;
    }
    const bearing = text.match(/\bbearing\s+(\d{1,3}(?:\.\d+)?)\s*°?/i);
    if (bearing) out.travelBearingDeg = Number(bearing[1]);
    for (const [re, cat] of CATEGORY_WORDS) if (re.test(text)) { out.subjectCategory = cat; break; }
    if (!out.subjectCategory && /\b(?:child|boy|girl|toddler|kid)\b/i.test(text)) out.subjectCategory = 'child';
    return out;
  },
};

/** Cleans the text, asks the reader, and keeps only allowed fields. Refuses a reader that is not enabled. */
export async function readIncident(text: string, reader: IntakeReader): Promise<IntakeResult & { sent: Redaction }> {
  if (!reader.enabled) throw new Error(`${reader.name} is switched off.`);
  const sent = redactIncidentText(text);
  const reply = await reader.read(sent.text, INTAKE_INSTRUCTIONS);
  return { ...parseIntakeReply(reply), sent };
}
