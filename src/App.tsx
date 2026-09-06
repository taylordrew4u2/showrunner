import { useState, useEffect, useRef } from 'react';
import type { Show, AppSettings, PotentialComic, MusicTrack, ScheduleTemplateItem } from './types';
import { DEFAULT_SETTINGS } from './types';
import { generateId } from './utils/id';
import { ServerNotConfiguredError } from './utils/api';
import { applyColorScheme, loadColorScheme, type ColorScheme } from './utils/theme';
import { vibrateTap } from './utils/haptics';
import { getRolodexTerm } from './utils/terminology';
import { expandOriginFrom } from './utils/expandOrigin';
import { addPerformersToRolodex } from './utils/rolodex';
import { buildOverview } from './utils/showsOverview';
import { 
  loadEncryptedShows, 
  saveEncryptedShows,
  loadEncryptedSettings,
  saveEncryptedSettings,
  exportUserData,
  createAccount,
  authenticateUser,
  healSettings,
  PayloadTooLargeError,
  type EncryptedShowRow,
} from './utils/secure-storage';
import { stripShowMediaForTrash, MAX_TRASH_ITEMS } from './utils/trash';
import { stripLegacyShowMedia, stripLegacySettingsMedia } from './utils/stripMedia';
import { healShow } from './utils/showHealing';
import { initMediaStore, clearMediaStore } from './utils/mediaStore';
import {
  type SessionCredentials,
  credentialsFrom,
  hasStoredSession,
  loadSession,
  saveSession,
  clearSession,
} from './utils/session-vault';
import { Login } from './components/Login';
import { Onboarding } from './components/Onboarding';
import { Settings } from './components/Settings';
import { PageHeader } from './components/PageHeader';
import { ShowCard } from './components/ShowCard';
import { ShowsDashboard, type ShowsFocus } from './components/ShowsDashboard';
import { ShowsCalendar } from './components/ShowsCalendar';
import { ShowForm } from './components/ShowForm';
import { ShowDetail } from './components/ShowDetail';
import { Expenses } from './components/Expenses';
import { Modal } from './components/Modal';
import { RolodexProfile } from './components/sections/RolodexProfile';
import { LiveViewer } from './components/LiveViewer';
import { Contracts } from './components/Contracts';
import { SigningPage } from './components/SigningPage';
import { readSignKeyFromHash, signatureSummary } from './utils/contracts';
import { orphanedRefs, showMediaRefs, sweepUnusedMedia, type SweepReport } from './utils/mediaCleanup';
import { deleteMedia } from './utils/mediaStore';
import { unpublishAll } from './utils/viewerAudio';
import { MusicLibrary } from './components/MusicLibrary';
import { InstallPrompt } from './components/InstallPrompt';
import { MorePage } from './components/MorePage';
import { SyncStatus, type SyncState } from './components/SyncStatus';
import { Icon } from './components/Icon';
import './App.css';

type View = 'list' | 'detail' | 'settings' | 'expenses' | 'rolodex' | 'emails' | 'music' | 'contracts' | 'more';

/**
 * The app's destinations. Keeping this a plain list — rather than hand-written
 * buttons plus an overflow menu that changed depending on the screen — is what
 * keeps the nav identical everywhere you go.
 */
const NAV_ITEMS: {
  id: Exclude<View, 'detail'>;
  label: string;
  /** Which views light this tab up. A show's detail page still counts as Shows. */
  views: View[];
  icon: string;
}[] = [
  {
    id: 'list',
    label: 'Shows',
    views: ['list', 'detail'],
    icon: 'M2 5a1 1 0 011-1h14a1 1 0 010 2H3a1 1 0 01-1-1zm0 5a1 1 0 011-1h14a1 1 0 010 2H3a1 1 0 01-1-1zm0 5a1 1 0 011-1h8a1 1 0 010 2H3a1 1 0 01-1-1z',
  },
  {
    id: 'rolodex',
    label: 'Rolodex',
    views: ['rolodex'],
    icon: 'M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z',
  },
  {
    id: 'music',
    label: 'Music',
    views: ['music'],
    icon: 'M18 3a1 1 0 00-1.196-.98l-8 1.6A1 1 0 008 4.6v6.735A3.5 3.5 0 1010 14V8.42l6-1.2v3.115A3.5 3.5 0 1018 13V3z',
  },
  {
    id: 'more',
    label: 'More',
    views: ['more', 'contracts', 'emails', 'expenses'],
    icon: 'M5 10a2 2 0 11-4 0 2 2 0 014 0zM12 10a2 2 0 11-4 0 2 2 0 014 0zM19 10a2 2 0 11-4 0 2 2 0 014 0z',
  },
  {
    id: 'settings',
    label: 'Settings',
    views: ['settings'],
    icon: 'M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z',
  },
];

/**
 * The signed-in session. Holds only values derived from the password at
 * sign-in (see session-vault) — never the password itself.
 */
type Session = SessionCredentials;

// Unsaved-edit backups. When a save fails (offline, server error), the latest
// data is parked here so a closed tab or crashed browser can't lose it — it's
// restored and re-saved on the next launch.
const PENDING_SHOWS_KEY = 'showrunner:pendingShows';
const PENDING_SETTINGS_KEY = 'showrunner:pendingSettings';
const LAST_EXPORT_KEY = 'showrunner:lastExport';
// When this account last had a save confirmed by the server. Kept across
// reloads so the status pill can answer "when did this last reach my account?"
// on a cold start, before the first save of the session.
const LAST_SYNC_KEY = 'showrunner:lastSync';

function readLastSync(username: string): number | null {
  try {
    const raw = localStorage.getItem(LAST_SYNC_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { username: string; at: number };
    return parsed.username === username && typeof parsed.at === 'number' ? parsed.at : null;
  } catch {
    return null;
  }
}

function writeLastSync(username: string, at: number): void {
  try {
    localStorage.setItem(LAST_SYNC_KEY, JSON.stringify({ username, at }));
  } catch {
    /* ignore */
  }
}

/**
 * Says so when the list you're looking at isn't all of your shows.
 *
 * The at-a-glance tiles and the search box both narrow the grid, and until now
 * the only sign of it was a pressed tile above the fold. Tap "Needs a running
 * order", scroll down, and two of your twelve shows are on screen with nothing
 * to say why — which reads exactly like the app losing the other ten. The count
 * and the way back belong next to the list they apply to.
 */
function NarrowedNotice({
  shown,
  total,
  onClear,
}: {
  shown: number;
  total: number;
  onClear: () => void;
}) {
  if (shown >= total) return null;
  return (
    <div className="shows-narrowed" role="status">
      <span className="shows-narrowed__text">
        Showing {shown} of {total} shows
      </span>
      <button
        type="button"
        className="btn btn--secondary btn--sm shows-narrowed__clear"
        onClick={onClear}
      >
        Show all
      </button>
    </div>
  );
}

/** True when the user has 3+ shows and hasn't exported a backup in 30 days. */
function shouldNudgeBackup(showCount: number, lastBackupAt: string | null): boolean {
  if (showCount < 3) return false;
  if (!lastBackupAt) return true;
  const at = new Date(lastBackupAt).getTime();
  if (Number.isNaN(at)) return true;
  return Date.now() - at > 30 * 24 * 60 * 60 * 1000;
}

// A pending backup is only trustworthy for a short window. Preferring an old
// one over the server would resurrect data the user has since deleted (possibly
// on another device) — and then re-save the resurrected copy over the server.
const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function readPending<T>(key: string, username: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { username: string; data: T; at?: number };
    if (parsed.username !== username) return null;
    // Backups written before timestamps existed (at === undefined) are from the
    // failing-saves era and are exactly the stale copies we must not restore.
    if (!parsed.at || Date.now() - parsed.at > PENDING_MAX_AGE_MS) {
      localStorage.removeItem(key);
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

function writePending(key: string, username: string, data: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify({ username, data, at: Date.now() }));
  } catch {
    /* quota exceeded or unavailable — in-memory retry still covers us */
  }
}

function clearPending(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState('');
  const [colorScheme, setColorScheme] = useState<ColorScheme>(() => loadColorScheme());

  // Apply the chosen color scheme app-wide and persist it.
  useEffect(() => {
    applyColorScheme(colorScheme);
  }, [colorScheme]);

  // Light haptic on every control tap (Android only — iOS web has no haptics
  // API). One delegated touch listener covers the whole app.
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (e.pointerType !== 'touch') return;
      const target = e.target as HTMLElement | null;
      const control = target?.closest('button, .btn, [role="button"]');
      if (!control) return;
      if ((control as HTMLButtonElement).disabled) return;
      if (control.getAttribute('aria-disabled') === 'true') return;
      vibrateTap(10);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, []);

  const [shows, setShows] = useState<Show[]>([]);
  // Only ever holds problems the user has to act on (a payload that can never
  // fit). Transient failures are handled silently and reported by the sync
  // pill instead — a retry that's already working shouldn't look like an alarm.
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Where the user's work currently is. Drives the always-visible status pill.
  const [syncState, setSyncState] = useState<SyncState>('saved');
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  // True while edits are parked in this device's local backup — i.e. written
  // here but not yet confirmed by the server.
  const [hasLocalCopy, setHasLocalCopy] = useState(false);
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(() => {
    try {
      return localStorage.getItem(LAST_EXPORT_KEY);
    } catch {
      return null;
    }
  });
  // Start in the loading state whenever a session will be restored, so the app
  // never shows an interactive (empty) shows list before the initial load
  // finishes. Creating a show during that window would be silently lost: the
  // save effect is gated on dataLoaded, and the load resolving would overwrite
  // the new show. Blocking interaction until loaded closes that race.
  const [loadingData, setLoadingData] = useState(() => {
    try {
      return hasStoredSession();
    } catch {
      return false;
    }
  });
  const dataLoaded = useRef(false);
  // Rows the last load couldn't decrypt, held as ciphertext so every save can
  // write them back untouched. Never rendered — only carried.
  const unreadableRowsRef = useRef<EncryptedShowRow[]>([]);
  const [unreadableCount, setUnreadableCount] = useState(0);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [onboardingSaving, setOnboardingSaving] = useState(false);
  const [view, setView] = useState<View>('list');
  const [selectedShow, setSelectedShow] = useState<Show | null>(null);
  /**
   * Set when the dashboard's Run Show button opened the show, so ShowDetail
   * mounts straight into live mode. Cleared on the way back out, so returning
   * to the same show by tapping its card doesn't reopen live mode.
   */
  const [startInRunShow, setStartInRunShow] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [newComicName, setNewComicName] = useState('');
  const [newComicNotes, setNewComicNotes] = useState('');
  const [newListEmail, setNewListEmail] = useState('');
  const [selectedComicId, setSelectedComicId] = useState<string | null>(null);
  // Which follow-up list from the at-a-glance row the grid is narrowed to.
  const [showsFocus, setShowsFocus] = useState<ShowsFocus>(null);
  const [expandOrigin, setExpandOrigin] = useState({ x: 50, y: 30 });
  /** Where the shows grid was scrolled to when you last left it. */
  const listScrollRef = useRef(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'added' | 'date-asc' | 'date-desc' | 'name'>(() => {
    try {
      const saved = localStorage.getItem('showrunner:showSort');
      if (saved === 'added' || saved === 'date-asc' || saved === 'date-desc' || saved === 'name') {
        return saved;
      }
    } catch {
      /* ignore */
    }
    // The next show you have to run is the one you came here for, so the list
    // opens on soonest-first rather than in the order things were created.
    return 'date-asc';
  });

  // Remember the sort preference so the shows list feels familiar each visit.
  useEffect(() => {
    try {
      localStorage.setItem('showrunner:showSort', sortBy);
    } catch {
      /* ignore */
    }
  }, [sortBy]);

  const [showsView, setShowsView] = useState<'grid' | 'calendar'>(() => {
    try {
      const saved = localStorage.getItem('showrunner:showsView');
      if (saved === 'grid' || saved === 'calendar') return saved;
    } catch {
      /* ignore */
    }
    return 'grid';
  });

  // Remember whether the user prefers the list or the calendar.
  useEffect(() => {
    try {
      localStorage.setItem('showrunner:showsView', showsView);
    } catch {
      /* ignore */
    }
  }, [showsView]);

  // Restore the session on mount (persists until logout). Reading it is async
  // now — the stored record is decrypted with a key the browser holds and
  // won't hand over — so a failed restore has to clear the loading state
  // itself, or the app would sit on the skeleton forever.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const restored = await loadSession();
        if (cancelled) return;
        if (restored) setSession(restored);
        else setLoadingData(false);
      } catch (error) {
        console.error('Failed to restore session:', error);
        if (!cancelled) setLoadingData(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);


  // Media store (large audio chunks) needs the session credentials for auth
  // headers + the encryption key. Keep it in sync with the session.
  useEffect(() => {
    if (session) initMediaStore(session);
    else clearMediaStore();
  }, [session]);

  // Carry the last confirmed save across reloads, so the status pill can say
  // when your work last reached your account instead of starting blank.
  useEffect(() => {
    setLastSavedAt(session ? readLastSync(session.username) : null);
  }, [session]);

  // Load data for signed in user
  useEffect(() => {
    if (!session) return;
    const currentSession = session;

    if (!dataLoaded.current) setLoadingData(true);
    async function loadData() {
      try {
        const [loaded, loadedSettings] = await Promise.all([
          loadEncryptedShows(currentSession),
          loadEncryptedSettings(currentSession),
        ]);
        // Rows this device couldn't decrypt. They're not in the list, so hold
        // their ciphertext for the saver to write straight back — otherwise the
        // next edit to any other show would delete them off the account.
        unreadableRowsRef.current = loaded.unreadable;
        setUnreadableCount(loaded.unreadable.length);
        // Scrub legacy embedded media (photos, videos, files) that older saves
        // still carry — the next save writes the slimmed-down payload.
        const migratedShows = loaded.shows.map((show) => stripLegacyShowMedia(show));

        // Migrate per-show expenses into global settings.expenses
        let migratedSettings = stripLegacySettingsMedia({ ...loadedSettings, expenses: loadedSettings.expenses || [] });
        const perShowExpenses = migratedShows.flatMap((s) => s.expenses || []);
        if (perShowExpenses.length > 0) {
          const existingIds = new Set(migratedSettings.expenses.map((e: { id: string }) => e.id));
          const newExpenses = perShowExpenses.filter((e) => !existingIds.has(e.id));
          if (newExpenses.length > 0) {
            migratedSettings = { ...migratedSettings, expenses: [...migratedSettings.expenses, ...newExpenses] };
          }
          // Clear per-show expenses after migration
          for (const show of migratedShows) {
            show.expenses = [];
          }
        }

        // Auto-correct: a show still marked 'upcoming' whose date has passed
        // should be 'completed'. Only touch 'upcoming' — leave 'in-progress'
        // and 'cancelled' alone since those are intentional manual states.
        const today = new Date().toISOString().split('T')[0];
        const autoStatusShows = migratedShows.map((show) =>
          show.status === 'upcoming' && show.date && show.date < today
            ? { ...show, status: 'completed' as const }
            : show
        );

        // If a previous session had unsaved edits (save failed, tab closed),
        // prefer that local backup — it's strictly newer than what the server
        // has. Setting state marks it dirty, so the auto-save re-persists it.
        const rawPendingShows = readPending<Show[]>(PENDING_SHOWS_KEY, currentSession.username);
        // Same healing as the server rows: a local backup written by an older
        // build can be missing list fields the list renders without checking.
        const pendingShows = rawPendingShows
          ? rawPendingShows
              .map((s) => healShow(s))
              .filter((s): s is Show => s !== null)
              .map((s) => stripLegacyShowMedia(s))
          : null;
        // Pending backups bypass loadEncryptedSettings, so run them through the
        // same healing (trash media stripping, oversized-audio removal) —
        // otherwise a poisoned backup keeps the account unsavable forever.
        const rawPendingSettings = readPending<AppSettings>(PENDING_SETTINGS_KEY, currentSession.username);
        const pendingSettings = rawPendingSettings ? stripLegacySettingsMedia(healSettings(rawPendingSettings)) : null;

        const initialShows = pendingShows ?? autoStatusShows;
        // A pending copy is by definition *not* what the server has; anything
        // else came straight off it and needs no local copy until it's edited.
        savedShowsRef.current = pendingShows ? null : initialShows;
        latestShowsRef.current = initialShows;
        setShows(initialShows);
        setSettings(pendingSettings ?? migratedSettings);
        dataLoaded.current = true;
        if (pendingSettings) saveSettings(pendingSettings);
        setLoadError(null);
      } catch (error) {
        console.error('Failed to load shows:', error);
        // Never overwrite in-memory shows on load failure — leave state unchanged
        // so the auto-save effect cannot wipe the database.
        setLoadError("Couldn't load your shows. Check your connection and refresh the page.");
      } finally {
        setLoadingData(false);
      }
    }

    loadData();
    // saveSettings is deliberately not a dependency. It is redeclared every
    // render but closes over nothing mutable except `session`, which is this
    // effect's only dependency — so the copy this run calls always agrees with
    // the session it ran for. Listing it would re-run the whole load on every
    // render instead, which is a refetch per keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Always points at the latest shows so an in-flight save can re-persist any
  // edits that landed while it was running.
  const latestShowsRef = useRef(shows);
  // The exact set that last reached the server — or came from it. Compared by
  // identity against the live one to answer "is there anything unsaved?", which
  // is the only question the flush below needs and the only one that can be
  // answered without guessing.
  const savedShowsRef = useRef<Show[] | null>(null);
  // Assigned during render rather than in an effect, because both readers run
  // at moments when "after the next paint" is already too late.
  //
  // The visibility flush is the one that cost data. Delete a show and switch
  // away in the same breath — which is what a phone is for — and the flush ran
  // while this ref still held the pre-delete array. That made it compare equal
  // to savedShowsRef, so the flush concluded there was nothing unsaved and
  // wrote no local copy. Backgrounding then froze the save timer, iOS
  // discarded the page, and the next launch read the show straight back off
  // the server. The saver's own mid-flight re-check was reading the same stale
  // value for the same reason.
  latestShowsRef.current = shows;
  // Guards against overlapping saves. The server replaces all rows per request,
  // so two concurrent saves can race and an older one can clobber a newer one.
  const savingRef = useRef(false);
  // Bumped to re-run the save effect for a retry (after a failure backoff, or
  // when the browser comes back online).
  const [saveRetryTick, setSaveRetryTick] = useState(0);
  const retryDelayRef = useRef(5000);
  const settingsSaveSeqRef = useRef(0);
  // Session-scoped dismissal of the backup nudge (it returns next visit).
  const [backupNudgeDismissed, setBackupNudgeDismissed] = useState(false);
  // Whether the install prompt is currently on screen. Both it and the backup
  // nudge are rows that sit between you and your shows; one of them is worth
  // that, two are not — so the backup nudge waits its turn.
  const [installPromptShown, setInstallPromptShown] = useState(false);

  // Records a confirmed round-trip to the server. Everything the status pill
  // claims about "saved" traces back to this being called.
  function markSynced(username: string) {
    const at = Date.now();
    setLastSavedAt(at);
    writeLastSync(username, at);
    setSyncState('saved');
  }

  // A failed save must never be the end of the story: retry as soon as the
  // browser regains connectivity.
  useEffect(() => {
    function onOnline() {
      retryDelayRef.current = 5000;
      setSaveRetryTick((t) => t + 1);
    }
    // Losing signal isn't a failure — say so plainly rather than waiting for a
    // request to time out and reporting it as an error.
    function onOffline() {
      setSyncState((prev) => (prev === 'blocked' ? prev : 'offline'));
    }
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  // Park every edit on this device as soon as it happens, not only after a
  // save fails. The save is debounced and then takes a round-trip; closing the
  // tab inside that window used to drop the edit on the floor. Writing the
  // local copy first means the only way to lose work is to lose the device.
  useEffect(() => {
    if (!session || !dataLoaded.current) return;
    const currentSession = session;
    const timeout = setTimeout(() => {
      writePending(PENDING_SHOWS_KEY, currentSession.username, latestShowsRef.current);
      setHasLocalCopy(true);
    }, 400);
    return () => clearTimeout(timeout);
  }, [shows, session]);

  /**
   * Write the local copy the instant the app is put away.
   *
   * Every edit is held in memory for up to a second before anything durable
   * happens to it: the local backup is on a 400ms timer and the save on a
   * 1000ms debounce, and the save then takes a round trip on top. Close the
   * app inside that window and the edit is gone from everywhere — which is
   * exactly what a phone does. Backgrounding a PWA freezes its timers, and iOS
   * will discard the page outright rather than let them run later, so a delete
   * followed by switching away could simply un-happen.
   *
   * localStorage is synchronous, so a write here always lands, even on the way
   * out. The next launch restores it and re-saves it.
   *
   * Only when there is something unsaved: writing unconditionally would leave a
   * local copy sitting in front of every launch, and a stale one would win over
   * newer work done on another device.
   */
  useEffect(() => {
    if (!session) return;
    const currentSession = session;
    function flush() {
      if (!dataLoaded.current || latestShowsRef.current === savedShowsRef.current) return;
      writePending(PENDING_SHOWS_KEY, currentSession.username, latestShowsRef.current);
      setHasLocalCopy(true);
    }
    function onVisibility() {
      if (document.visibilityState === 'hidden') flush();
    }
    document.addEventListener('visibilitychange', onVisibility);
    // pagehide fires where unload doesn't on iOS, including into the back/forward cache.
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
    };
  }, [session]);

  // If work exists only on this device, closing the tab risks it being the
  // only copy — worth one confirm. Deliberately not shown while a normal save
  // is simply in flight: that case is already covered by the local copy above
  // and re-sends itself on the next launch.
  useEffect(() => {
    if (syncState !== 'retrying' && syncState !== 'offline' && syncState !== 'blocked') return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [syncState]);

  // Save shows when changed
  useEffect(() => {
    if (!session || !dataLoaded.current) return;
    const currentSession = session;

    const timeout = setTimeout(() => {
      // A save is already running; it will pick up the latest shows before it
      // finishes, so we don't need to start a second one. This pass is spent
      // either way — see the re-check once that save settles.
      if (savingRef.current) return;

      void (async () => {
        savingRef.current = true;
        setSyncState((prev) => (prev === 'blocked' ? prev : 'saving'));
        let settledClean = false;
        try {
          // Re-save until the data stops changing mid-flight, so the last edit
          // always wins and is never lost to an overlapping request.
          let saved: Show[] | null = null;
          while (latestShowsRef.current !== saved) {
            saved = latestShowsRef.current;
            await saveEncryptedShows(saved, currentSession, unreadableRowsRef.current);
          }
          settledClean = true;
          savedShowsRef.current = saved;
          clearPending(PENDING_SHOWS_KEY);
          setHasLocalCopy(false);
          retryDelayRef.current = 5000;
          setSaveError(null);
          markSynced(currentSession.username);
        } catch (error) {
          console.error('Failed to save shows:', error);
          // Park the unsaved data locally so even closing the tab can't lose it.
          writePending(PENDING_SHOWS_KEY, currentSession.username, latestShowsRef.current);
          setHasLocalCopy(true);
          // A too-large payload (client-side guard or a 413 from the server) can
          // never succeed by retrying — the data has to get smaller first. Show
          // an actionable message and skip the backoff loop; the save effect
          // re-runs on its own when the user trims a file, so it recovers then.
          const tooLarge =
            error instanceof PayloadTooLargeError ||
            (error as { status?: number })?.status === 413;
          if (tooLarge) {
            setSyncState('blocked');
            setSaveError(
              error instanceof PayloadTooLargeError
                ? error.message
                : "Your show data is too large to save. Remove or shrink a big uploaded walk-on track.",
            );
          } else {
            // No banner: the retry is already running and the work is already
            // held on this device, so there's nothing for the user to do. The
            // status pill reports it quietly and explains it on tap.
            setSyncState(navigator.onLine ? 'retrying' : 'offline');
            const delay = retryDelayRef.current;
            retryDelayRef.current = Math.min(delay * 2, 60_000);
            setTimeout(() => setSaveRetryTick((t) => t + 1), delay);
          }
        } finally {
          savingRef.current = false;
          // One more look before letting go.
          //
          // The loop above decides it is done by comparing latestShowsRef
          // against what it just wrote — but that ref is assigned in an
          // effect, and effects are flushed after paint. An edit that lands
          // while a save is in flight can therefore still be invisible to the
          // loop's last check, and the debounced pass that would have caught
          // it has already fired and returned because a save was running. The
          // change then belongs to nobody.
          //
          // Deleting is where that goes from an unsaved edit to a resurrected
          // row: a show only leaves the server when a save actually runs, so a
          // deletion dropped here comes back on the next load.
          if (settledClean && latestShowsRef.current !== savedShowsRef.current) {
            setSaveRetryTick((t) => t + 1);
          }
        }
      })();
    }, 1000); // Debounce saves

    return () => clearTimeout(timeout);
  }, [shows, session, saveRetryTick]);

  /**
   * Take a freshly entered password and turn it into a stored session.
   *
   * This is the only place the raw password exists, and it does not outlive
   * this call: the keys and the auth hash are derived here, and those derived
   * values are what get held in memory and written to disk.
   */
  async function beginSession(username: string, password: string) {
    const creds = credentialsFrom(username, password);
    await saveSession(creds);
    setSession(creds);
  }

  async function handleSignIn(username: string, password: string) {
    setAuthError('');
    setAuthLoading(true);

    try {
      const isValid = await authenticateUser(username, password);

      if (!isValid) {
        setAuthError('Invalid username or password');
        return;
      }

      await beginSession(username, password);
    } catch (error) {
      console.error('Sign in failed:', error);
      setAuthError(
        error instanceof ServerNotConfiguredError
          ? "The server isn't connected to the database yet. Check the deployment's environment variables."
          : 'Failed to sign in. Please try again.',
      );
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleSignUp(username: string, password: string) {
    setAuthError('');
    setAuthLoading(true);

    try {
      await createAccount(username, password);
      await beginSession(username, password);
    } catch (error) {
      console.error('Sign up failed:', error);
      const message = error instanceof Error ? error.message : '';
      if (error instanceof ServerNotConfiguredError) {
        setAuthError(
          "The server isn't connected to the database yet. Check the deployment's environment variables.",
        );
      } else if (message === 'ACCOUNT_EXISTS') {
        setAuthError('Account already exists. Please sign in.');
      } else {
        setAuthError('Failed to create account. Please try again.');
      }
    } finally {
      setAuthLoading(false);
    }
  }

  function handleLogout() {
    setSession(null);
    clearSession();
    dataLoaded.current = false;
    setShows([]);
    setSettings(DEFAULT_SETTINGS);
    setView('list');
    setSelectedShow(null);
    setShowForm(false);
    setAuthError('');
  }

  /**
   * Download a plain-JSON copy of everything. The one guarantee that doesn't
   * depend on this app, this device, or this server still being around — so
   * it's reachable from the status pill on every screen, not just Settings.
   */
  async function handleDownloadBackup() {
    if (!session) return;
    try {
      const url = await exportUserData(session);
      const a = document.createElement('a');
      a.href = url;
      a.download = `showrunner-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      const at = new Date().toISOString();
      try {
        localStorage.setItem(LAST_EXPORT_KEY, at);
      } catch {
        /* ignore */
      }
      setLastBackupAt(at);
      setBackupNudgeDismissed(true);
    } catch (error) {
      console.error('Failed to export backup:', error);
      setSaveError("Couldn't build your backup file. Check your connection and try again.");
    }
  }

  async function handleCompleteOnboarding(data: { brandName: string; showTypes: string[] }) {
    if (!session) return;
    setOnboardingSaving(true);
    // Merge onto whatever loaded for this account so we never clobber existing data.
    const updatedSettings: AppSettings = {
      ...settings,
      brandName: data.brandName || settings.brandName,
      showTypes: data.showTypes,
      onboarded: true,
    };
    try {
      await saveEncryptedSettings(updatedSettings, session);
      setSettings(updatedSettings);
    } catch (error) {
      console.error('Failed to save onboarding:', error);
      // Mark onboarded locally so a save hiccup doesn't trap the user on this screen.
      setSettings(updatedSettings);
    } finally {
      setOnboardingSaving(false);
    }
  }

  async function handleSaveSettings(updatedSettings: AppSettings) {
    if (!session) return;

    setSettingsSaving(true);
    try {
      await saveEncryptedSettings(updatedSettings, session);
      setSettings(updatedSettings);
      markSynced(session.username);
      setView('list');
    } catch (error) {
      console.error('Failed to save settings:', error);
      // Never make someone retype what they just entered. Keep their edits in
      // the app and hand them to the retrying saver, which backs them up on
      // this device and keeps trying — the status pill reports where they are.
      setSettings(updatedSettings);
      saveSettings(updatedSettings);
      setView('list');
    } finally {
      setSettingsSaving(false);
    }
  }

  function handleCreateShow(data: Omit<Show, 'id' | 'createdAt' | 'updatedAt'>) {
    const newShow: Show = {
      ...data,
      id: generateId(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // `scenes` comes through from the form and is undefined unless its box
      // was ticked. An undefined list is what marks a show as never having
      // asked for the section; seeding an empty array unconditionally made
      // every new show read as opted in, which is why it is the form's choice
      // to make and not this function's.
    };
    setShows((prev) => [newShow, ...prev]);
    setShowForm(false);
    // Drop the user straight into the new show so create → populate is continuous.
    setSelectedShow(newShow);
    setView('detail');
  }

  function handleDuplicateShow(id: string) {
    const original = shows.find((s) => s.id === id);
    if (!original) return;
    const now = new Date().toISOString();
    const copy: Show = {
      ...structuredClone(original),
      id: generateId(),
      name: `${original.name} (copy)`,
      status: 'upcoming',
      createdAt: now,
      updatedAt: now,
      date: '', // clear the date so the user picks a new one
      // Drop anything tied to the original instance, not the template.
      viewToken: undefined,
      viewNote: undefined,
      recap: undefined,
    };
    setShows((prev) => [copy, ...prev]);
  }

  function handleDeleteShow(id: string) {
    const showToDelete = shows.find((s) => s.id === id);
    if (!showToDelete) return;

    const remaining = shows.filter((s) => s.id !== id);
    setShows(remaining);
    // Written now, synchronously, rather than left to the 400ms local-copy
    // timer and the 1s save debounce.
    //
    // Deleting and then switching away is one gesture on a phone, and
    // backgrounding freezes both those timers — iOS discards the page rather
    // than running them later. Every other edit lost that way is an edit the
    // user can see is missing; a lost deletion is a show that comes back.
    // localStorage is synchronous, so this lands even on the way out, and the
    // next launch restores it and re-saves it.
    if (session) {
      writePending(PENDING_SHOWS_KEY, session.username, remaining);
      setHasLocalCopy(true);
      latestShowsRef.current = remaining;
    }

    // Move to trash instead of permanent deletion — but strip embedded media
    // first and cap the trash length. Trash lives in the settings blob, which
    // has a hard request-size ceiling; a full show copy (with base64 audio)
    // can make settings permanently unsavable.
    const deletedItem = {
      id: generateId(),
      type: 'show' as const,
      data: stripShowMediaForTrash(showToDelete),
      deletedAt: new Date().toISOString(),
    };

    // Anything pushed past the cap is gone for good — it can no longer be
    // restored — so its uploads go with it rather than outliving every trace
    // of the show they belonged to.
    const nextTrash = [deletedItem, ...(settings.trash || [])];
    const evicted = nextTrash.slice(MAX_TRASH_ITEMS);
    const updatedSettings = {
      ...settings,
      trash: nextTrash.slice(0, MAX_TRASH_ITEMS),
    };
    setSettings(updatedSettings);
    if (session) {
      saveSettings(updatedSettings);
    }
    if (evicted.length > 0) {
      releaseShowMedia(evicted.map((t) => t.data), remaining, updatedSettings);
    }
  }


  /**
   * Free the uploads a permanently-removed show was the last owner of.
   *
   * Called with the state that will exist *after* the removal, so a file that
   * is about to become unreachable is seen as unreachable. Anything another
   * show, the music library, the Rolodex or a still-restorable trash item
   * points at is left alone — sharing is normal here, because duplicating a
   * show copies its media ids rather than the files.
   *
   * Best-effort by design: a failed delete leaves a file behind, which costs
   * storage, while blocking the removal on it would cost the user the thing
   * they asked for.
   */
  function releaseShowMedia(
    removed: Show[],
    remainingShows: Show[],
    remainingSettings: AppSettings,
  ) {
    const candidates = removed.flatMap(showMediaRefs);
    for (const ref of orphanedRefs(candidates, remainingShows, remainingSettings)) {
      deleteMedia(ref);
    }
    // Soundboard audio published for the viewer link lives under the show's
    // token rather than in the media store, so it needs its own sweep.
    if (session) {
      for (const show of removed) {
        if (show.viewToken) void unpublishAll(show.viewToken, session).catch(() => {});
      }
    }
  }

  /** Put a trashed show back in the list. */
  function handleRestoreShow(trashId: string) {
    const item = (settings.trash || []).find((t) => t.id === trashId);
    if (!item) return;

    // A show deleted on this device may already have been restored elsewhere —
    // don't create a duplicate if it's somehow back in the list.
    setShows((prev) => (prev.some((s) => s.id === item.data.id) ? prev : [item.data, ...prev]));

    const updatedSettings = {
      ...settings,
      trash: (settings.trash || []).filter((t) => t.id !== trashId),
    };
    setSettings(updatedSettings);
    saveSettings(updatedSettings);
  }

  /** Remove one item from the trash for good. */
  function handleDeleteForever(trashId: string) {
    const item = (settings.trash || []).find((t) => t.id === trashId);
    const updatedSettings = {
      ...settings,
      trash: (settings.trash || []).filter((t) => t.id !== trashId),
    };
    setSettings(updatedSettings);
    saveSettings(updatedSettings);
    if (item?.data) releaseShowMedia([item.data], shows, updatedSettings);
  }

  function handleUpdateMusicLibrary(musicLibrary: MusicTrack[]) {
    const updatedSettings = { ...settings, musicLibrary };
    setSettings(updatedSettings);
    saveSettings(updatedSettings);
  }

  function handleEmptyTrash() {
    const emptied = (settings.trash || []).map((t) => t.data).filter(Boolean);
    const updatedSettings = { ...settings, trash: [] };
    setSettings(updatedSettings);
    saveSettings(updatedSettings);
    if (emptied.length > 0) releaseShowMedia(emptied, shows, updatedSettings);
  }


  /**
   * Sweep files earlier versions of the app left behind.
   *
   * Deletion only started freeing uploads recently, so an account carries the
   * audio and headshots of every show deleted before that — unreachable, and
   * invisible to anything but a scan like this one. The server cannot do it
   * alone: what points at a file lives inside the user's encrypted blobs, so
   * only the browser can tell used from unused.
   *
   * Gated on `dataLoaded`, and that gate is the whole safety of it. A client
   * that failed to load would see no references at all and cheerfully delete
   * every file in the account.
   */
  async function handleSweepMedia(dryRun: boolean): Promise<SweepReport> {
    if (!session || !dataLoaded.current) {
      throw new Error('Your shows are still loading. Try again in a moment.');
    }
    return sweepUnusedMedia(latestShowsRef.current ?? shows, settings, session, { dryRun });
  }

  function saveSettings(updatedSettings: typeof settings) {
    if (!session) return;
    const currentSession = session;
    // Each call supersedes any still-retrying older one, so a stale snapshot
    // can never land after (and clobber) a newer save.
    const seq = ++settingsSaveSeqRef.current;
    void (async () => {
      // Retry with backoff until the save lands; back the data up locally in
      // the meantime so a closed tab can't lose it.
      let delay = 5000;
      let toSave = updatedSettings;
      while (seq === settingsSaveSeqRef.current) {
        try {
          await saveEncryptedSettings(toSave, currentSession);
          if (seq === settingsSaveSeqRef.current) {
            // If we had to prune trash to fit under the size limit, reflect
            // that in state so the app matches what actually persisted.
            if (toSave !== updatedSettings) {
              setSettings((prev) => ({ ...prev, trash: [] }));
            }
            clearPending(PENDING_SETTINGS_KEY);
            setSaveError(null);
            markSynced(currentSession.username);
          }
          return;
        } catch (err) {
          console.error('Failed to save settings:', err);
          if (seq !== settingsSaveSeqRef.current) return;
          const tooLarge =
            err instanceof PayloadTooLargeError ||
            (err as { status?: number })?.status === 413;
          if (tooLarge) {
            // Retrying an oversized payload can never succeed — the data has
            // to shrink. Trash (deleted shows) is the usual culprit and is
            // droppable, so self-heal by emptying it and retrying once.
            if ((toSave.trash?.length ?? 0) > 0) {
              toSave = { ...toSave, trash: [] };
              continue;
            }
            writePending(PENDING_SETTINGS_KEY, currentSession.username, toSave);
            setHasLocalCopy(true);
            setSyncState('blocked');
            setSaveError(
              err instanceof PayloadTooLargeError
                ? err.message
                : 'Your settings are too large to save — usually an over-full trash. Empty the trash to fix it.',
            );
            return;
          }
          writePending(PENDING_SETTINGS_KEY, currentSession.username, toSave);
          setHasLocalCopy(true);
          // Same as shows: a retry in progress is not an error to shout about.
          setSyncState(navigator.onLine ? 'retrying' : 'offline');
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay = Math.min(delay * 2, 60_000);
        }
      }
    })();
  }

  function handleAddPotentialComic() {
    const trimmedName = newComicName.trim();
    const trimmedNotes = newComicNotes.trim();
    if (!trimmedName || !session) return;

    const newComic: PotentialComic = {
      id: generateId(),
      name: trimmedName,
      notes: trimmedNotes || undefined,
    };

    const updatedSettings = {
      ...settings,
      potentialComics: [newComic, ...settings.potentialComics],
    };

    setSettings(updatedSettings);
    saveSettings(updatedSettings);
    setNewComicName('');
    setNewComicNotes('');
  }

  function handleAddEmailToList() {
    const trimmed = newListEmail.trim();
    if (!trimmed || !session) return;

    // Don't store the same address twice.
    const exists = settings.emailList.some(
      (entry) => entry.email.toLowerCase() === trimmed.toLowerCase()
    );
    if (exists) {
      setNewListEmail('');
      return;
    }

    const updatedSettings = {
      ...settings,
      emailList: [
        { id: generateId(), email: trimmed, addedAt: new Date().toISOString() },
        ...settings.emailList,
      ],
    };

    setSettings(updatedSettings);
    saveSettings(updatedSettings);
    setNewListEmail('');
  }

  function handleRemoveEmailFromList(id: string) {
    if (!session) return;

    const updatedSettings = {
      ...settings,
      emailList: settings.emailList.filter((entry) => entry.id !== id),
    };

    setSettings(updatedSettings);
    saveSettings(updatedSettings);
  }

  function handleSavePerformerToRolodex(comic: PotentialComic) {
    if (!session) return;
    const existing = settings.potentialComics.find(c => c.name.toLowerCase() === comic.name.toLowerCase());
    const updated = existing
      ? settings.potentialComics.map(c => c.id === existing.id ? { ...c, ...comic, id: c.id } : c)
      : [comic, ...settings.potentialComics];
    const updatedSettings = { ...settings, potentialComics: updated };
    setSettings(updatedSettings);
    saveSettings(updatedSettings);
  }

  function handleUpdateRolodexComic(updated: PotentialComic) {
    if (!session) return;
    const updatedComics = settings.potentialComics.map(c => c.id === updated.id ? updated : c);
    const updatedSettings = { ...settings, potentialComics: updatedComics };
    setSettings(updatedSettings);
    saveSettings(updatedSettings);

    // Sync matching performers in all shows (match by name, update profile fields)
    setShows(prev =>
      prev.map(show => ({
        ...show,
        performers: show.performers.map(p => {
          if (p.name.toLowerCase() !== updated.name.toLowerCase()) return p;
          return {
            ...p,
            socialMedia: updated.socialMedia ?? p.socialMedia,
            credits: updated.credits ?? p.credits,
            walkOnMusic: updated.walkOnMusic ?? p.walkOnMusic,
            walkOnMusicName: updated.walkOnMusicName ?? p.walkOnMusicName,
            walkOnMusicArtist: updated.walkOnMusicArtist ?? p.walkOnMusicArtist,
            walkOnMusicTimestamp: updated.walkOnMusicTimestamp ?? p.walkOnMusicTimestamp,
            walkOnMusicLink: updated.walkOnMusicLink ?? p.walkOnMusicLink,
          };
        }),
      }))
    );
  }

  /** Save the current run-of-show as a reusable template (account-wide). */
  function handleSaveScheduleTemplate(name: string, items: ScheduleTemplateItem[]) {
    if (!session) return;
    const updatedSettings: AppSettings = {
      ...settings,
      scheduleTemplates: [
        { id: generateId(), name, items, createdAt: new Date().toISOString() },
        ...(settings.scheduleTemplates || []),
      ],
    };
    setSettings(updatedSettings);
    saveSettings(updatedSettings);
  }

  function handleDeleteScheduleTemplate(id: string) {
    if (!session) return;
    const updatedSettings: AppSettings = {
      ...settings,
      scheduleTemplates: (settings.scheduleTemplates || []).filter((t) => t.id !== id),
    };
    setSettings(updatedSettings);
    saveSettings(updatedSettings);
  }

  function handleRemovePotentialComic(id: string) {
    if (!session) return;

    const removed = settings.potentialComics.find((comic) => comic.id === id);
    const updatedSettings = {
      ...settings,
      potentialComics: settings.potentialComics.filter((comic) => comic.id !== id),
    };

    setSettings(updatedSettings);
    saveSettings(updatedSettings);

    // A Rolodex entry can carry a walk-on track. Filing someone onto a show
    // copies the reference rather than the audio, so this only frees it when
    // no show is still using it.
    if (removed?.walkOnMusic) {
      for (const ref of orphanedRefs([removed.walkOnMusic], shows, updatedSettings)) {
        deleteMedia(ref);
      }
    }
  }

  function handleUpdateShow(updated: Show) {
    const previous = shows.find((s) => s.id === updated.id);
    const nextShows = shows.map((s) => (s.id === updated.id ? updated : s));
    setShows(nextShows);
    setSelectedShow(updated);
    fileNewPerformers(updated);

    // Every edit to a show lands here, which makes this the one place that can
    // notice an upload going out of use: a cue deleted with its intro music, a
    // performer dropped from the bill with their headshot, a walk-on replaced
    // by a different track. Comparing what the show pointed at before with
    // what it points at now gives that set without every section having to
    // remember to clean up after itself.
    //
    // This treats a reference leaving the show as final, which it is — cue and
    // lineup edits have no undo. Only whole shows are recoverable, and those
    // go through the trash, which keeps their references alive until the trash
    // itself is emptied.
    if (previous) {
      const before = showMediaRefs(previous);
      const after = new Set(showMediaRefs(updated));
      const dropped = before.filter((ref) => !after.has(ref));
      if (dropped.length > 0) {
        for (const ref of orphanedRefs(dropped, nextShows, settings)) deleteMedia(ref);
      }
    }
  }

  /**
   * Anyone booked onto a show joins the Rolodex, without being filed by hand.
   *
   * Every route a performer can arrive by — typed in, picked from the Rolodex,
   * pulled off an imported schedule — lands in handleUpdateShow, so this is the
   * one place that needs to know.
   *
   * It compares performer **ids** against the show as it was, not names against
   * the Rolodex. Renaming someone keeps their id, so fixing a spelling doesn't
   * file a second copy under the corrected name; only a genuinely new row on
   * the lineup counts as a booking.
   */
  function fileNewPerformers(updated: Show) {
    if (!session) return;
    const before = shows.find((s) => s.id === updated.id);
    const alreadyOnBill = new Set(before?.performers.map((p) => p.id) ?? []);
    const added = updated.performers.filter((p) => !alreadyOnBill.has(p.id));
    if (added.length === 0) return;

    const merged = addPerformersToRolodex(settings.potentialComics, added);
    if (!merged) return; // everyone was already filed — no write needed

    const updatedSettings = { ...settings, potentialComics: merged };
    setSettings(updatedSettings);
    saveSettings(updatedSettings);
  }

  function handleSelectShow(show: Show, e?: React.MouseEvent, runShow = false) {
    // Remember where the list was, so Back returns you to the show you tapped
    // rather than the top of a long grid.
    listScrollRef.current = window.scrollY;
    // Set on every selection, not just the Run Show one: leaving a show by the
    // bottom nav rather than Back doesn't clear it, and a stale flag would
    // drop the *next* show you tapped straight into live mode.
    setStartInRunShow(runShow);
    // Open the show first. Measuring the card to set the expand animation's
    // origin is decoration, and it used to run ahead of the navigation it
    // decorates — so anything it touched (a missing .app-main, an element
    // already detached from the DOM) threw inside the click handler and the
    // show simply never opened. React does not route event-handler errors to
    // an error boundary, which made that failure completely silent: no error
    // screen, no blank page, just a tap that did nothing.
    setSelectedShow(show);
    setView('detail');

    if (!e) return;
    try {
      const origin = expandOriginFrom(
        (e.currentTarget as HTMLElement | null)?.getBoundingClientRect(),
        document.querySelector('.app-main')?.getBoundingClientRect(),
      );
      if (origin) setExpandOrigin(origin);
    } catch {
      // The animation is the only thing that can be lost here.
    }
  }

  function handleBack() {
    setView('list');
    setSelectedShow(null);
    setStartInRunShow(false);
  }

  /**
   * Run Show, straight from the dashboard.
   *
   * The show page still mounts underneath — live mode is a layer over it, and
   * closing live mode should land on the show, not back on the list you came
   * from. Passing no event skips the expand animation, which has no card to
   * expand from here.
   */
  function handleRunShowFromDashboard(show: Show) {
    handleSelectShow(show, undefined, true);
  }

  /**
   * Opening something puts you at the top of it.
   *
   * Nothing reset the scroll position when the view changed, and the whole app
   * lives in one scrolling document — so tapping a show inherited wherever the
   * shows grid happened to be. On a phone the grid is a single very tall
   * column, so a show a few rows down opened with its title and its Back
   * button a thousand pixels above the viewport: you'd be looking at the
   * bottom of the show page, which reads exactly like the tap having done
   * nothing at all.
   *
   * Going back is the one direction that shouldn't jump — returning to the
   * list drops you where you left it, next to the show you just opened.
   */
  useEffect(() => {
    window.scrollTo(0, view === 'list' ? listScrollRef.current : 0);
  }, [view, selectedShow?.id]);

  // totalSceneCount retained for future use

  // Search + status filtering for the shows list.
  const normalizedQuery = searchQuery.trim().toLowerCase();
  // The at-a-glance row narrows this list; the ids come from the same
  // buildOverview the row counts with, so the count and the grid can't disagree.
  const focusIds = (() => {
    if (!showsFocus) return null;
    const overview = buildOverview(shows);
    return new Set(overview.attention.map((item) => item.show.id));
  })();

  const filteredShows = shows.filter((show) => {
    if (focusIds && !focusIds.has(show.id)) return false;
    if (!normalizedQuery) return true;
    return [show.name, show.venueName, show.location]
      .some((field) => field?.toLowerCase().includes(normalizedQuery));
  });


  // Sort the visible shows. Undated shows always sort to the end for date sorts.
  const sortedShows = [...filteredShows].sort((a, b) => {
    switch (sortBy) {
      case 'name':
        return a.name.localeCompare(b.name);
      case 'date-asc':
        if (!a.date && !b.date) return 0;
        if (!a.date) return 1;
        if (!b.date) return -1;
        return a.date.localeCompare(b.date);
      case 'date-desc':
        if (!a.date && !b.date) return 0;
        if (!a.date) return 1;
        if (!b.date) return -1;
        return b.date.localeCompare(a.date);
      default:
        return 0; // 'added' — preserve existing newest-first order
    }
  });

  function clearFilters() {
    setSearchQuery('');
    setShowsFocus(null);
  }


  // What this producer calls the people in their Rolodex (Comics, Queens, …),
  // derived from their show types and overridable in Settings.
  const rolodexTerm = getRolodexTerm(settings);

  // Public read-only routes — no auth required.
  const search = new URLSearchParams(window.location.search);
  const viewToken = search.get('view');
  if (viewToken) {
    return <LiveViewer token={viewToken} />;
  }
  // A contract someone was asked to sign. No account, and none offered — the
  // token addresses the row and the key rides in the fragment.
  const signToken = search.get('sign');
  if (signToken) {
    return <SigningPage token={signToken} signKey={readSignKeyFromHash(window.location.hash)} />;
  }

  return (
    <>
      {!session ? (
        <Login
          onSignIn={handleSignIn}
          onSignUp={handleSignUp}
          loading={authLoading}
          errorMessage={authError}
        />
      ) : loadingData ? (
        <div className="app">
          <div className="app-loading" role="status" aria-live="polite" aria-label="Loading your shows">
            <div className="app-loading__skeletons" aria-hidden="true">
              <div className="skeleton-tile-row">
                <div className="skeleton skeleton--tile" />
                <div className="skeleton skeleton--tile" />
              </div>
              <div className="skeleton skeleton--bar" />
              <div className="skeleton skeleton--card" />
              <div className="skeleton skeleton--card" />
              <div className="skeleton skeleton--card" />
            </div>
          </div>
        </div>
      ) : !settings.onboarded ? (
        <Onboarding
          username={session.username}
          onComplete={handleCompleteOnboarding}
          saving={onboardingSaving}
        />
      ) : (
        <div className="app">
          {/* Everything that reports on the state of your data, in one stack:
              problems that need you first, then the always-on sync pill. */}
          <div className="status-rail">
            {/* Some rows came back but wouldn't decrypt on this device. Say so
                plainly — a short list with no explanation reads as lost data,
                and these shows are neither lost nor at risk: they're carried
                back to the server untouched on every save. */}
            {unreadableCount > 0 && (
              <div className="system-notice" role="alert">
                <Icon name="alert" size={16} className="system-notice__icon" aria-hidden />
                <div className="system-notice__body">
                  <span className="system-notice__text">
                    {unreadableCount === 1
                      ? "1 show couldn't be opened on this device, so it isn't in your shows list."
                      : `${unreadableCount} shows couldn't be opened on this device, so they aren't in your shows list.`}
                  </span>
                  <span className="system-notice__reassurance">
                    They're still on your account and nothing here will overwrite them. Try
                    refreshing, or signing out and back in.
                  </span>
                </div>
                <button
                  className="system-notice__close"
                  onClick={() => setUnreadableCount(0)}
                  aria-label="Dismiss"
                >
                  ×
                </button>
              </div>
            )}
            {loadError && (
              <div className="system-notice" role="alert">
                <Icon name="alert" size={16} className="system-notice__icon" aria-hidden />
                <div className="system-notice__body">
                  <span className="system-notice__text">{loadError}</span>
                  <span className="system-notice__reassurance">
                    Nothing has been deleted — this is a connection problem, not a data problem.
                  </span>
                </div>
                <button
                  className="system-notice__close"
                  onClick={() => setLoadError(null)}
                  aria-label="Dismiss"
                >
                  ×
                </button>
              </div>
            )}
            {saveError && (
              <div className="system-notice" role="alert">
                <Icon name="alert" size={16} className="system-notice__icon" aria-hidden />
                <div className="system-notice__body">
                  <span className="system-notice__text">{saveError}</span>
                  <span className="system-notice__reassurance">
                    Everything you'd already saved is untouched, and this change is held on this
                    device until it fits.
                  </span>
                </div>
                <button
                  className="system-notice__close"
                  onClick={() => setSaveError(null)}
                  aria-label="Dismiss"
                >
                  ×
                </button>
              </div>
            )}
            <div className="status-rail__pill-row">
              <SyncStatus
                state={syncState}
                lastSavedAt={lastSavedAt}
                hasLocalCopy={hasLocalCopy}
                lastBackupAt={lastBackupAt}
                onDownloadBackup={handleDownloadBackup}
              />
            </div>
          </div>
          <main className="app-main">
            {/* In the flow, at the top. It used to be a fixed banner floating
                just above the bottom nav, and on iOS Safari it shows on every
                visit until dismissed — 121px of it, at z-index 200, sitting
                over the bottom of the shows list. Cards underneath took the
                tap and did nothing, which reads as the app being broken. A
                prompt to install is never worth covering the thing you came
                to use. */}
            <InstallPrompt onShownChange={setInstallPromptShown} />

            {view === 'list' && (
              <div className="shows-list">
                <PageHeader
                  title="Shows"
                  actions={
                    // With no shows yet the empty state carries the call to
                    // action, so there's only ever one "New Show" button on
                    // screen at a time.
                    shows.length > 0 ? (
                      <button
                        className="btn btn--primary btn--sm page-header__new"
                        onClick={() => setShowForm(true)}
                        // The noun below is hidden with display: none at phone
                        // width, which takes it out of the accessible name as
                        // well as off the screen — leaving the button called
                        // "+ New". Named explicitly so what it is called does
                        // not depend on how wide the screen is.
                        aria-label="New show"
                      >
                        {/* On a phone the filled button measured 153px against
                            a 98px page title — the loudest object on the
                            screen was the secondary action. The page is called
                            "Shows"; the button does not need to say it again,
                            so the noun drops away at phone width and the
                            button comes back to the title's size. */}
                        + New<span className="page-header__new-noun"> Show</span>
                      </button>
                    ) : undefined
                  }
                />
                {!backupNudgeDismissed && !installPromptShown
                  && shouldNudgeBackup(shows.length, lastBackupAt) && (
                  <div className="backup-nudge" role="status">
                    <Icon name="shield" size={16} className="backup-nudge__icon" aria-hidden />
                    <span className="backup-nudge__text">Keep your own copy</span>
                    <div className="backup-nudge__actions">
                      <button
                        className="btn btn--secondary btn--sm backup-nudge__btn"
                        onClick={handleDownloadBackup}
                        aria-label="Download a backup file of your shows"
                      >
                        Back up
                      </button>
                      <button
                        className="backup-nudge__close"
                        onClick={() => setBackupNudgeDismissed(true)}
                        aria-label="Dismiss backup reminder"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                )}
                {shows.length > 0 && (
                  <div className="shows-toolbar">
                    <input
                      className="shows-toolbar__search"
                      type="search"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      // One word, because on a phone this field is ~155px wide
                      // once the sort and view controls have taken theirs, and
                      // a placeholder does not ellipsize — the longer version
                      // rendered as "Search shov".
                      placeholder="Search"
                      aria-label="Search shows"
                    />
                    {showsView === 'grid' && (
                      <select
                        className="shows-toolbar__sort"
                        value={sortBy}
                        onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                        aria-label="Sort shows"
                      >
                        <option value="added">Recent</option>
                        <option value="date-asc">Soonest</option>
                        <option value="date-desc">Latest</option>
                        <option value="name">A–Z</option>
                      </select>
                    )}
                    <div className="shows-toolbar__view" role="group" aria-label="View mode">
                      <button
                        className={`shows-toolbar__view-btn${showsView === 'grid' ? ' shows-toolbar__view-btn--active' : ''}`}
                        onClick={() => setShowsView('grid')}
                        aria-pressed={showsView === 'grid'}
                        aria-label="List view"
                        title="List view"
                      >
                        <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18" aria-hidden="true"><path d="M2 5a1 1 0 011-1h14a1 1 0 010 2H3a1 1 0 01-1-1zm0 5a1 1 0 011-1h14a1 1 0 010 2H3a1 1 0 01-1-1zm0 5a1 1 0 011-1h14a1 1 0 010 2H3a1 1 0 01-1-1z"/></svg>
                      </button>
                      <button
                        className={`shows-toolbar__view-btn${showsView === 'calendar' ? ' shows-toolbar__view-btn--active' : ''}`}
                        onClick={() => setShowsView('calendar')}
                        aria-pressed={showsView === 'calendar'}
                        aria-label="Calendar view"
                        title="Calendar view"
                      >
                        <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18" aria-hidden="true"><path fillRule="evenodd" d="M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z" clipRule="evenodd"/></svg>
                      </button>
                    </div>
                  </div>
                )}

                <ShowsDashboard
                  shows={shows}
                  focus={showsFocus}
                  onFocusChange={setShowsFocus}
                  onSelectShow={handleSelectShow}
                  onRunShow={handleRunShowFromDashboard}
                />

                {shows.length === 0 ? (
                  <div className="empty-state">
                    <h2 className="empty-state__title">No shows yet</h2>
                    <p className="empty-state__text">
                      Create a show to build its lineup, run-of-show, and live mode.
                    </p>
                    <button className="btn btn--primary" onClick={() => setShowForm(true)}>
                      + New Show
                    </button>
                  </div>
                ) : filteredShows.length === 0 ? (
                  <div className="empty-state">
                    <h2 className="empty-state__title">No matches</h2>
                    <p className="empty-state__text">
                      {searchQuery.trim()
                        ? `No shows match “${searchQuery.trim()}”.`
                        : 'Nothing left in this list.'}
                    </p>
                    <button className="btn btn--secondary" onClick={clearFilters}>
                      {searchQuery.trim() ? 'Clear search' : 'Show all'}
                    </button>
                  </div>
                ) : (
                  <>
                    {/* Above both views: whichever one you're in, the question
                        "where are the rest of my shows?" is the same. */}
                    {/* Names the list now that panels sit above it — without
                        a heading the grid reads as a continuation of the
                        dashboard rather than as the full set of shows. */}
                    <div className="shows-list__heading">
                      <h2 className="shows-list__heading-text">All shows</h2>
                      <span className="shows-list__heading-count">{filteredShows.length}</span>
                    </div>
                    <NarrowedNotice
                      shown={filteredShows.length}
                      total={shows.length}
                      onClear={clearFilters}
                    />
                    {showsView === 'calendar' ? (
                      <ShowsCalendar shows={filteredShows} onSelectShow={handleSelectShow} />
                    ) : (
                      <div className="shows-grid">
                        {sortedShows.map((show) => (
                          <ShowCard
                            key={show.id}
                            show={show}
                            onSelect={handleSelectShow}
                            onDelete={handleDeleteShow}
                            onDuplicate={handleDuplicateShow}
                          />
                        ))}
                      </div>
                    )}
                  </>
                )}

              </div>
            )}

            {view === 'music' && (
              <MusicLibrary
                tracks={settings.musicLibrary ?? []}
                shows={shows}
                onChange={handleUpdateMusicLibrary}
                onBack={handleBack}
              />
            )}

            {view === 'more' && (
              <MorePage
                onBack={handleBack}
                destinations={[
                  {
                    key: 'contracts',
                    label: 'Contracts',
                    description: signatureSummary(settings.signatureRequests ?? []).waiting > 0
                      ? `${signatureSummary(settings.signatureRequests ?? []).waiting} waiting to be signed`
                      : 'Agreements to be signed',
                    icon: 'file',
                    badge: signatureSummary(settings.signatureRequests ?? []).waiting || undefined,
                    onSelect: () => setView('contracts'),
                  },
                  {
                    key: 'emails',
                    label: 'Email list',
                    description: 'Addresses you collect at shows',
                    icon: 'mail',
                    onSelect: () => setView('emails'),
                  },
                  {
                    key: 'expenses',
                    label: 'Expenses',
                    description: 'What the shows are costing you',
                    icon: 'dollar',
                    onSelect: () => setView('expenses'),
                  },
                ]}
              />
            )}

            {view === 'emails' && (
              <div className="email-list-page">
                <PageHeader
                  title="Email List"
                  subtitle="Emails you collect at shows, kept in one place. Nothing is ever sent from here — they're only stored."
                  onBack={() => setView('more')}
                  backLabel="More"
                />

                <form
                  className="email-list__form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleAddEmailToList();
                  }}
                >
                  <input
                    className="rolodex__input"
                    type="email"
                    inputMode="email"
                    autoComplete="off"
                    value={newListEmail}
                    onChange={(e) => setNewListEmail(e.target.value)}
                    placeholder="name@example.com"
                    aria-label="Email address"
                  />
                  <button
                    className="btn btn--secondary"
                    type="submit"
                    disabled={!newListEmail.trim()}
                  >
                    Add
                  </button>
                </form>

                {settings.emailList.length === 0 ? (
                  <div className="empty-state">
                    <h2 className="empty-state__title">No emails yet</h2>
                    <p className="empty-state__text">
                      Add an address above to start building your list.
                    </p>
                  </div>
                ) : (
                  <>
                    <p className="email-list__count">
                      {settings.emailList.length} {settings.emailList.length === 1 ? 'email' : 'emails'} collected
                    </p>
                    <ul className="email-list__entries">
                      {settings.emailList.map((entry) => (
                        <li key={entry.id} className="email-list__entry">
                          <span className="email-list__address">{entry.email}</span>
                          <button
                            className="email-list__remove"
                            type="button"
                            onClick={() => handleRemoveEmailFromList(entry.id)}
                            aria-label={`Remove ${entry.email}`}
                          >
                            ×
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}

            {view === 'detail' && selectedShow && (
              <div
                key={selectedShow.id}
                className="show-detail-expand"
                style={{ '--expand-origin-x': `${expandOrigin.x}%`, '--expand-origin-y': `${expandOrigin.y}%` } as React.CSSProperties}
              >
                <ShowDetail
                  show={selectedShow}
                  settings={settings}
                  startInRunShow={startInRunShow}
                  onBack={handleBack}
                  onUpdate={handleUpdateShow}
                  session={session ?? undefined}
                  onUpdateSettings={(updated) => {
                    setSettings(updated);
                    saveSettings(updated);
                  }}
                  onSaveToRolodex={handleSavePerformerToRolodex}
                  onSaveScheduleTemplate={handleSaveScheduleTemplate}
                  onDeleteScheduleTemplate={handleDeleteScheduleTemplate}
                  onDuplicate={handleDuplicateShow}
                  onDelete={handleDeleteShow}
                />
              </div>
            )}

            {view === 'contracts' && session && (
              <Contracts
                settings={settings}
                session={session}
                onBack={() => setView('more')}
                backLabel="More"
                onUpdateSettings={(updated) => {
                  setSettings(updated);
                  saveSettings(updated);
                }}
              />
            )}

            {view === 'expenses' && (
              <Expenses
                settings={settings}
                onBack={() => setView('more')}
                backLabel="More"
                onUpdateSettings={(updated) => {
                  // Persist through the retrying saver (with local backup),
                  // and stay on this page — handleSaveSettings is the Settings
                  // form's submit (it navigates away and drops edits on error).
                  setSettings(updated);
                  saveSettings(updated);
                }}
              />
            )}

            {view === 'rolodex' && (
              <div className="rolodex-page">
                <PageHeader
                  title={`${rolodexTerm.singular} Rolodex`}
                  subtitle={`Keep a running list of ${rolodexTerm.plural.toLowerCase()} you want to book next.`}
                  onBack={handleBack}
                  backLabel="Shows"
                />

                {/* A form rather than a div: a name box beside an Add button
                    should take Enter, which is how everyone tries it first. */}
                <form
                  className="rolodex__form"
                  onSubmit={(e) => { e.preventDefault(); handleAddPotentialComic(); }}
                >
                  <input
                    className="rolodex__input"
                    value={newComicName}
                    onChange={(e) => setNewComicName(e.target.value)}
                    placeholder={`${rolodexTerm.singular} name`}
                  />
                  {/* Only once there is a name to attach them to. A second
                      full-width box for optional notes sat above the list
                      permanently, and filing someone in a rolodex is a name —
                      the notes are something you have or you don't. */}
                  {newComicName.trim() !== '' && (
                    <input
                      className="rolodex__input rolodex__input--notes"
                      value={newComicNotes}
                      onChange={(e) => setNewComicNotes(e.target.value)}
                      placeholder="Notes (style, contact, socials, etc.)"
                    />
                  )}
                  <button
                    className="btn btn--secondary"
                    type="submit"
                    disabled={!newComicName.trim()}
                  >
                    Add
                  </button>
                </form>

                {settings.potentialComics.length === 0 ? (
                  <div className="empty-state">
                    <h2 className="empty-state__title">No {rolodexTerm.plural.toLowerCase()} yet</h2>
                    <p className="empty-state__text">
                      Add someone above, or save a performer from a show to keep their details here.
                    </p>
                  </div>
                ) : (
                  <div className="rolodex__list">
                    {settings.potentialComics.map((comic) => (
                      <article key={comic.id} className="rolodex__item">
                        <div className="rolodex__photo-placeholder">
                          {comic.name.charAt(0).toUpperCase()}
                        </div>
                        <div className="rolodex__item-content">
                          <p className="rolodex__name">{comic.name}</p>
                          {comic.socialMedia && <p className="rolodex__meta">{comic.socialMedia}</p>}
                          {(comic.walkOnMusicName || comic.walkOnMusicArtist) && (
                            <p className="rolodex__meta">{[comic.walkOnMusicName, comic.walkOnMusicArtist].filter(Boolean).join(' — ')}</p>
                          )}
                          {comic.notes && <p className="rolodex__notes">{comic.notes}</p>}
                        </div>
                        <button
                          className="btn btn--secondary btn--sm"
                          type="button"
                          onClick={() => setSelectedComicId(comic.id)}
                        >
                          Edit
                        </button>
                      </article>
                    ))}
                  </div>
                )}

                {/* Rolodex edit drawer */}
                {selectedComicId && (() => {
                  const comic = settings.potentialComics.find(c => c.id === selectedComicId);
                  if (!comic) return null;
                  return (
                    <>
                      <div className="perf-drawer__backdrop" onClick={() => setSelectedComicId(null)} />
                      <div className="perf-drawer">
                        <RolodexProfile
                          comic={comic}
                          onBack={() => setSelectedComicId(null)}
                          onChange={handleUpdateRolodexComic}
                          onDelete={id => { handleRemovePotentialComic(id); setSelectedComicId(null); }}
                        />
                      </div>
                    </>
                  );
                })()}
              </div>
            )}

            {view === 'settings' && (
              <Settings
                settings={settings}
                onSave={handleSaveSettings}
                onBack={handleBack}
                saving={settingsSaving}
                colorScheme={colorScheme}
                onColorSchemeChange={setColorScheme}
                username={session.username}
                onLogout={handleLogout}
                onRestoreShow={handleRestoreShow}
                onDeleteForever={handleDeleteForever}
                onEmptyTrash={handleEmptyTrash}
                onSweepMedia={loadError ? undefined : handleSweepMedia}
                onExport={handleDownloadBackup}
                lastBackupAt={lastBackupAt}
                lastSavedAt={lastSavedAt}
              />
            )}
          </main>

          {/* Four fixed destinations, in the same order and the same place on
              every screen. Actions that belong to one show now live on that
              show's page instead of reshaping the nav as you move around. */}
          <nav className="bottom-nav" aria-label="Primary navigation">
            <div className="bottom-nav__brand">
              <span className="bottom-nav__brand-dot" />
              <span className="bottom-nav__brand-text">I Can Run A Show</span>
            </div>

            <div className="bottom-nav__items">
              {NAV_ITEMS.map((item) => {
                const active = item.views.includes(view);
                return (
                  <button
                    key={item.id}
                    className={`bottom-nav__item${active ? ' bottom-nav__item--active' : ''}`}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => {
                      if (item.id === 'list') {
                        handleBack();
                      } else {
                        setView(item.id);
                        setSelectedShow(null);
                      }
                    }}
                  >
                    <svg className="bottom-nav__item-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                      <path fillRule="evenodd" clipRule="evenodd" d={item.icon} />
                    </svg>
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>
          </nav>

          {showForm && (
            <Modal onClose={() => setShowForm(false)}>
              <ShowForm
                onSave={handleCreateShow}
                onCancel={() => setShowForm(false)}
              />
            </Modal>
          )}

        </div>
      )}
    </>
  );
}
