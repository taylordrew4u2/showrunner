export type ShowStatus = "upcoming" | "in-progress" | "completed" | "cancelled";
export type SceneStatus = "planned" | "rehearsed" | "filmed" | "done";

export interface Scene {
  id: string;
  title: string;
  description: string;
  duration: number; // minutes
  status: SceneStatus;
  order: number;
}

export interface Performer {
  id: string;
  name: string;
  photo?: string; // headshot (media store reference) — the face on the Run Show button
  socialMedia?: string;
  email?: string; // contact email — used for booking confirmations / mass messages
  walkOnMusic?: string; // file URI
  walkOnMusicName?: string;
  walkOnMusicArtist?: string;
  walkOnMusicTimestamp?: string;
  walkOnMusicLink?: string; // YouTube or Spotify URL
  /** Trim points for the walk-on, in seconds. Unset plays the whole file. */
  walkOnStartSec?: number;
  walkOnEndSec?: number;
  credits?: string;
  videoLink?: string; // hosted video URL (YouTube, Vimeo, Drive, etc.)
}

export interface Artist {
  id: string;
  name: string;
  artistType?: string;
  socialMedia?: string;
  credits?: string;
  walkOnMusic?: string;
  walkOnMusicName?: string;
  videoLink?: string; // hosted video URL (YouTube, Vimeo, Drive, etc.)
}

export interface ScheduleItem {
  id: string;
  time: string;
  description: string; // the segment / what happens
  performer?: string; // who's on stage (free-text name, e.g. from import)
  durationMin?: number; // how long this segment runs (minutes) — used by Run Show
  performerId?: string; // optional link to a performer record (for walk-on music)
  music?: string; // uploaded intro/transition music (data URL); overrides walk-on
  musicName?: string;
  musicDuration?: number; // legacy: seconds to play from the top; superseded by musicStartSec/musicEndSec
  /** Trim points for the cue's own upload, in seconds. */
  musicStartSec?: number;
  musicEndSec?: number;
}

/**
 * One cue inside a saved run-of-show template.
 *
 * Deliberately a subset of ScheduleItem: no `id` (regenerated per show, so the
 * same template can be used twice without colliding), no `performerId` (those
 * ids belong to one show's cast), and no `music`/`musicName` — audio would put
 * an unbounded blob inside the settings payload, which has a hard request-size
 * ceiling that, once exceeded, blocks every settings save for the account.
 */
export interface ScheduleTemplateItem {
  time: string;
  description: string;
  performer?: string;
  durationMin?: number;
}

/** A reusable run-of-show, saved once and applied to any future show. */
export interface ScheduleTemplate {
  id: string;
  name: string;
  items: ScheduleTemplateItem[];
  createdAt: string;
}

export interface Host {
  id: string;
  name: string;
  notes?: string;
  isHosting: boolean;
}

export interface DJSong {
  id: string;
  title: string;
  artist: string;
  notes?: string;
  music?: string; // uploaded audio (media store reference) — gets its own Run Show button
  musicName?: string; // original file name of the upload
  /**
   * Set when this song came from the global music library. The audio is then
   * *shared* with the library rather than owned by this show, so removing the
   * song must not delete the underlying media — other shows are pointing at
   * the same reference.
   */
  libraryId?: string;
  /**
   * Trim points, in seconds from the top of the file.
   *
   * A walk-on is rarely the first eight bars of a track — it's the drop, the
   * chorus, the bit the room knows. Setting these means the button plays that
   * part and nothing else, so nobody is standing on stage waiting out an intro.
   * Unset means the whole file.
   */
  startSec?: number;
  endSec?: number;
}

/**
 * A track in the account-wide music library: uploaded once, then added to any
 * show's DJ list without uploading again. Shows reference the same media, so
 * the audio is stored once no matter how many shows use it.
 */
export interface MusicTrack {
  id: string;
  title: string;
  artist: string;
  notes?: string;
  /** Media-store reference. A library track exists to carry audio. */
  music: string;
  musicName?: string;
  addedAt: string;
  /**
   * Trim points, in seconds from the top of the file.
   *
   * A walk-on is rarely the first eight bars of a track — it's the drop, the
   * chorus, the bit the room knows. Setting these means the button plays that
   * part and nothing else, so nobody is standing on stage waiting out an intro.
   * Unset means the whole file.
   */
  startSec?: number;
  endSec?: number;
}

export interface StaffMember {
  id: string;
  role: string;
  personName: string;
  phone?: string;
}

export interface Vendor {
  id: string;
  name: string;
  category?: string;
  contactName?: string;
  phone?: string;
  email?: string;
  website?: string;
  cost?: number;
  notes?: string;
  booked?: boolean;
}

export interface Expense {
  id: string;
  category: string;
  itemName: string;
  cost: number;
  date?: string;
  notes?: string;
}

export interface Producer {
  id: string;
  name: string;
  role: string;
}

export interface PotentialComic {
  id: string;
  name: string;
  notes?: string;
  // Optional performer data saved from a show
  socialMedia?: string;
  email?: string; // contact email

  credits?: string;
  walkOnMusic?: string;
  walkOnMusicName?: string;
  walkOnMusicArtist?: string;
  walkOnMusicTimestamp?: string;
  walkOnMusicLink?: string;
}

export interface EmailListEntry {
  id: string;
  email: string;
  addedAt: string;
}

export interface ShowRecap {
  attendance?: number;
  merchSales?: number;
  performerNotes?: string;
  improvementNotes?: string;
  profitLoss?: number;
}

export interface TodoItem {
  id: string;
  text: string;
  completed: boolean;
}

export type SectionKey =
  | "basic"
  | "performers"
  | "artists"
  | "schedule"
  | "hosts"
  | "dj"
  | "staff"
  | "vendors"
  | "expenses"
  | "scenes"
  | "recap";

export interface SectionCompletions {
  basic?: boolean;
  performers?: boolean;
  artists?: boolean;
  schedule?: boolean;
  hosts?: boolean;
  dj?: boolean;
  staff?: boolean;
  vendors?: boolean;
  expenses?: boolean;
  scenes?: boolean;
  recap?: boolean;
}

export interface Show {
  id: string;
  name: string;
  date: string;
  time: string;
  location: string;
  venueName: string;
  status: ShowStatus;
  ticketLink?: string;
  performers: Performer[];
  artists: Artist[];
  schedule: ScheduleItem[];
  hosts: Host[];
  djSongs: DJSong[];
  /**
   * Library tracks this show has opted out of.
   *
   * Every track in the account's music library appears in every show, so a
   * show's own `djSongs` holds only what's specific to it. Removing a library
   * track from one show can't be a deletion — the track belongs to the
   * library and the other shows still want it — so it's recorded here as an
   * exclusion for this show alone.
   */
  djHiddenLibraryIds?: string[];
  staff: StaffMember[];
  vendors?: Vendor[];
  expenses: Expense[];
  scenes?: Scene[];
  recap?: ShowRecap;
  completions?: SectionCompletions;
  hiddenSections?: SectionKey[];
  /**
   * How many performers this show is booking for. Optional: with no target the
   * lineup has no "full", and nothing about it is shown.
   */
  performerTarget?: number;
  host?: string; // host name (free text, or set from a performer)
  todos?: TodoItem[];
  viewToken?: string; // public read-only viewer link token
  viewNote?: string; // optional note shown on the viewer page before the show starts
  createdAt: string;
  updatedAt: string;
}

export interface DeletedItem {
  id: string;
  type: 'show';
  data: Show;
  deletedAt: string;
}

/** A contract PDF the producer has uploaded, stored like any other media. */
/**
 * One thing a signer is asked to fill in, beyond their signature.
 *
 * Real agreements rarely stop at a name: a performer agreement wants the stage
 * name and how they want to be credited, a release wants a mailing address, a
 * W-9-adjacent form wants a business name. The producer decides the list per
 * contract, and the signer fills it in on the same screen they sign on.
 */
export interface ContractField {
  id: string;
  label: string; // what the signer is asked, e.g. "Stage name"
  placeholder?: string;
  required?: boolean;
  /** A roomier box, for credits and addresses that run past one line. */
  multiline?: boolean;
}

export interface Contract {
  id: string;
  name: string; // what the producer calls it, e.g. "Performer Agreement"
  fileRef: string; // `media:` reference to the encrypted PDF
  fileName: string;
  sizeBytes: number;
  uploadedAt: string;
  /** Extra details this contract asks for. Absent on older contracts. */
  fields?: ContractField[];
}

/** What a signer typed and agreed to, once they have signed. */
export interface SignatureRecord {
  signedAt: string;
  typedName: string;
  /**
   * What the signer filled in, kept with the label they were shown rather than
   * a field id, so the record still reads correctly after the contract's
   * questions are edited or the contract itself is deleted.
   */
  fields?: { label: string; value: string }[];
  /** Hash of the exact bytes the signer was shown, so the copy can be proved. */
  documentHash: string;
  userAgent?: string;
}

/**
 * One contract sent to one person.
 *
 * `key` is the per-request encryption key. It lives here — inside the
 * producer's own end-to-end encrypted settings — rather than in localStorage,
 * so a link stays openable from any device they log in on. It is never sent to
 * the server; the server holds only ciphertext addressed by `token`.
 */
export interface SignatureRequest {
  id: string;
  token: string;
  key: string;
  contractId: string;
  contractName: string;
  contactId?: string; // the Rolodex entry this went to, when it came from there
  signerName: string;
  signerEmail?: string;
  sentAt: string;
  signed?: SignatureRecord;
}

export interface AppSettings {
  brandName: string;
  producers: Producer[];
  rules: string;
  brandBudget: number;
  totalSpent: number;
  trash: DeletedItem[];
  potentialComics: PotentialComic[];
  expenses: Expense[];
  emailList: EmailListEntry[]; // collected audience emails — storage only, no sending
  scheduleTemplates: ScheduleTemplate[]; // reusable run-of-show layouts
  musicLibrary: MusicTrack[]; // account-wide DJ tracks, addable to any show
  contracts: Contract[]; // uploaded agreements, sent out for signature
  signatureRequests: SignatureRequest[]; // who was sent what, and who has signed
  showTypes: string[]; // kinds of shows this producer makes (set during onboarding)
  onboarded: boolean; // whether the account has completed the welcome onboarding
  rolodexTermSingular?: string; // override for the Rolodex noun, e.g. "Comic" / "Queen"
  rolodexTermPlural?: string; // override for the plural Rolodex noun
  /**
   * The key a paired stage remote sends, learned by listening for it.
   *
   * Clickers are wildly inconsistent — some send Enter, some Space, some a
   * letter, some a media key the browser never sees — so the app learns
   * whatever this one actually sends rather than guessing at a brand.
   */
  remoteMusicKey?: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  brandName: "Show Producer",
  producers: [],
  rules: "",
  brandBudget: 0,
  totalSpent: 0,
  trash: [],
  potentialComics: [],
  expenses: [],
  emailList: [],
  scheduleTemplates: [],
  musicLibrary: [],
  contracts: [],
  signatureRequests: [],
  showTypes: [],
  onboarded: false,
};

// The kinds of shows a producer can run. Offered as multi-select chips during
// onboarding and editable later in Settings.
export const SHOW_TYPES: string[] = [
  "Comedy",
  "Open Mic",
  "Improv",
  "Music",
  "Variety",
  "Theater",
  "Burlesque",
  "Drag",
  "Magic",
  "Dance",
  "Podcast / Live Recording",
  "Corporate / Private Event",
  "Other",
];

export const STAFF_ROLES: string[] = [
  "Videographer",
  "Photographer",
  "Sound",
  "Lighting",
  "Security",
  "Ticket Sales",
  "Stage Manager",
  "MC",
  "Door Person",
  "Other",
];

export const VENDOR_CATEGORIES: string[] = [
  "Catering",
  "Bar",
  "Sound",
  "Lighting",
  "Staging",
  "Rentals",
  "Photography",
  "Videography",
  "Security",
  "Decor",
  "Transportation",
  "Printing",
  "Venue",
  "Other",
];

export const EXPENSE_CATEGORIES: string[] = [
  "Venue",
  "Equipment",
  "Marketing",
  "Talent",
  "Staff",
  "Catering",
  "Travel",
  "Printing",
  "Decorations",
  "Apparel",
  "Materials",
  "Other",
];
