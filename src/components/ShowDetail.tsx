import { useEffect, useMemo, useRef, useState } from 'react';
import type { Show, ShowStatus, Scene, AppSettings, SectionKey, TodoItem, Performer, PotentialComic } from '../types';
import { generateId } from '../utils/id';
import { SceneList } from './SceneList';
import { Icon, type IconName } from './Icon';
import { MoreMenu, type MoreMenuItem } from './MoreMenu';
import { BasicInfoSection } from './sections/BasicInfoSection';
import { PerformersSection } from './sections/PerformersSection';
import { PerformerContracts } from './sections/PerformerContracts';
import { ArtistsSection } from './sections/ArtistsSection';
import { ScheduleSection } from './sections/ScheduleSection';
import { DJMusicSection } from './sections/DJMusicSection';
import { StaffSection } from './sections/StaffSection';
import { VendorsSection } from './sections/VendorsSection';
import { ShowRecapSection } from './sections/ShowRecapSection';
import { RunShow } from './RunShow';
import { Modal } from './Modal';
import { exportShowToPDF } from '../utils/pdfExport';
import { parseShowDate, formatShowTime } from '../utils/showDate';
import { joinNames, scheduleSummary, staffSummary, vendorsSummary } from '../utils/sectionSummary';
import { publishLiveView, type LiveViewPayload } from '../utils/liveView';
import { loadColorScheme } from '../utils/theme';
import { buildShowStats, progressPercent, isComplete, formatRunTime } from '../utils/showStats';
import { showDJSongs } from '../utils/musicLibrary';
import { getRolodexTerm } from '../utils/terminology';
import { hostChoices } from '../utils/hostChoices';
import type { SessionCredentials } from '../utils/session-vault';
import { loadViewerKey, viewerUrl as buildViewerUrl } from '../utils/viewerAudio';
import './ShowDetail.css';
import { useConfirm } from './useConfirm';

// Each section card wears the icon for what it holds, so the grid is scannable
// by shape once you know the page — a wall of same-looking cards is the failure
// mode of a bento layout.
const SECTION_ICONS: Record<string, IconName> = {
  basic: 'file',
  performers: 'users',
  artists: 'sparkle',
  schedule: 'schedule',
  dj: 'music',
  staff: 'wrench',
  vendors: 'bolt',
  scenes: 'tv',
  recap: 'check',
};

interface ShowDetailProps {
  show: Show;
  settings: AppSettings;
  /**
   * Open straight into live mode, for the dashboard's Run Show button. The
   * page still mounts underneath, so closing live mode lands on the show
   * rather than back where you came from.
   */
  startInRunShow?: boolean;
  onBack: () => void;
  onUpdate: (show: Show) => void;
  onSaveToRolodex?: (comic: import('../types').PotentialComic) => void;
  /**
   * Sending contracts from inside the show. Both are needed together — the
   * session to upload the document, the callback to file the request — so the
   * performer's contracts only appear when the app can actually send one.
   */
  session?: SessionCredentials;
  onUpdateSettings?: (settings: AppSettings) => void;
  onSaveScheduleTemplate?: (name: string, items: import('../types').ScheduleTemplateItem[]) => void;
  onDeleteScheduleTemplate?: (id: string) => void;
  /**
   * Duplicating and deleting the show. These were only ever on the show card,
   * as two small buttons on every row — which on a phone put a delete control
   * inside a list you scroll with your thumb. The card hides them at phone
   * width now, so they have to be reachable from the show itself.
   */
  onDuplicate?: (id: string) => void;
  onDelete?: (id: string) => void;
}

const STATUS_LABELS: Record<ShowStatus, string> = {
  upcoming: 'Upcoming',
  'in-progress': 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

/** Which sections a producer had open, remembered per show. */
function openSectionsKey(showId: string): string {
  return `showrunner:openSections:${showId}`;
}

function loadOpenSections(showId: string): Set<string> {
  try {
    const raw = localStorage.getItem(openSectionsKey(showId));
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {
    /* ignore */
  }
  // First visit: the lineup opens, not Basic Info.
  //
  // Basic Info held this slot, and it was the wrong one twice over. Its five
  // fields are set at the moment the show is created and rarely touched again,
  // and the header above already prints the date, time, venue and location —
  // so an open Basic Info was ~500px of duplicate, pushing Performers past the
  // bottom of a phone screen. The lineup is what a show is for.
  //
  // Only new shows get this. A producer's own open/closed state is stored per
  // show and still wins.
  return new Set(['performers']);
}

export function ShowDetail({
  show,
  settings,
  startInRunShow = false,
  onBack,
  onUpdate,
  onSaveToRolodex,
  session,
  onUpdateSettings,
  onSaveScheduleTemplate,
  onDeleteScheduleTemplate,
  onDuplicate,
  onDelete,
}: ShowDetailProps) {
  const { confirm, confirmDialog } = useConfirm();
  // Everyone this producer has on file. The show's own bill comes first so a
  // name spelled slightly differently in the Rolodex doesn't win over the
  // spelling actually used on this lineup.
  // The host comes first for the same reason they lead the attach picker: a run
  // sheet says "Host intro — Jo Park" more often than it names anyone else, and
  // that line should fill in who's on stage without being typed twice.
  const knownNames = useMemo(
    () => [
      ...(show.host ? [show.host] : []),
      ...show.performers.map((p) => p.name),
      ...(show.artists ?? []).map((a) => a.name),
      ...settings.potentialComics.map((c) => c.name),
    ].filter((n) => n?.trim()),
    [show.host, show.performers, show.artists, settings.potentialComics],
  );
  /**
   * The show as it is *now*, for anything that resolves after an await.
   *
   * Every section funnels its edits through handleUpdate, which merges them
   * into the show. Merging into the render-time prop meant an operation that
   * started before an edit and finished after it — a photo or an audio upload,
   * a confirmation still waiting to be answered — wrote back a copy of the show
   * from before that edit, and the edit was gone. The longer the upload, the
   * more work it took with it.
   */
  const showRef = useRef(show);
  useEffect(() => {
    showRef.current = show;
  }, [show]);

  // The overview tiles read straight off the show, so they can't drift from the
  // sections below them.
  const stats = useMemo(
    () => buildShowStats(show, settings.musicLibrary ?? []),
    [show, settings.musicLibrary],
  );

  const [expandedSections, setExpandedSections] = useState<Set<string>>(() => loadOpenSections(show.id));
  const [editingShowName, setEditingShowName] = useState(false);
  const [runShowOpen, setRunShowOpen] = useState(startInRunShow);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerNoteDraft, setViewerNoteDraft] = useState('');
  const [viewerCopied, setViewerCopied] = useState(false);
  const [viewerCopyFailed, setViewerCopyFailed] = useState(false);
  const viewerUrlRef = useRef<HTMLInputElement>(null);
  const [tempShowName, setTempShowName] = useState(show.name);
  // Adding and removing sections happens in one deliberate place, so a stray tap
  // next to the expand chevron can't wipe a section off the show.
  const [manageSectionsOpen, setManageSectionsOpen] = useState(false);

  /**
   * Whether the navigation bar is showing the show's name.
   *
   * It swaps in once the page's own big title has passed underneath the bar,
   * so a bar stuck to the top of a long show page still says where you are.
   *
   * Measured against the two elements rather than a scroll threshold: the
   * header's height depends on how long the name is and whether there's a
   * venue, and the bar's offset depends on the safe-area inset. Comparing the
   * rectangles is exact on every phone; a magic number is right on one.
   */
  const topbarRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const [titleInBar, setTitleInBar] = useState(false);

  useEffect(() => {
    let frame = 0;
    function check() {
      frame = 0;
      const hero = heroRef.current;
      const bar = topbarRef.current;
      if (!hero || !bar) return;
      setTitleInBar(hero.getBoundingClientRect().bottom < bar.getBoundingClientRect().bottom);
    }
    // Coalesced to one read per frame: scroll fires far faster than paint, and
    // this measures layout, which is the expensive kind of read to repeat.
    function onScroll() {
      if (!frame) frame = requestAnimationFrame(check);
    }
    check();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  // Lets the overview tiles act as a table of contents: tap "12 Performers"
  // and land inside the Performers section instead of scrolling to find it.
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  function jumpToSection(sectionKey: string) {
    setExpandedSections((prev) => (prev.has(sectionKey) ? prev : new Set(prev).add(sectionKey)));
    // Two frames: one for React to commit the newly-expanded section, one for
    // the browser to lay it out, so the scroll targets the section's real
    // height instead of the collapsed one it had before this click.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        sectionRefs.current[sectionKey]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  // Come back to a show and it looks the way you left it.
  useEffect(() => {
    try {
      localStorage.setItem(openSectionsKey(show.id), JSON.stringify([...expandedSections]));
    } catch {
      /* ignore */
    }
  }, [show.id, expandedSections]);

  // Keep the public viewer's pre-show lineup current: whenever an upcoming show's
  // lineup or details change, re-publish the scheduled payload (debounced). Skipped
  // while running so it never clobbers the live on-stage state RunShow publishes.
  useEffect(() => {
    if (!show.viewToken || show.status !== 'upcoming' || runShowOpen) return;
    const timeout = setTimeout(() => {
      publishLiveView(show.viewToken!, buildScheduledPayload(show.viewNote)).catch(() => {});
    }, 1000);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show.viewToken, show.status, runShowOpen, show.name, show.date, show.time, show.viewNote, show.performers]);

  // Show the recap once the show is done — either explicitly marked completed
  // or its date has passed.
  const datePassed = show.date && new Date(show.date) < new Date(new Date().setHours(0, 0, 0, 0));
  const isPastShow = datePassed || show.status === 'completed';

  /**
   * DJ songs that will have a button on the night.
   *
   * Hiding the DJ section used to drop the whole list on the way into Run Show,
   * on the reasoning that a show without a DJ section has no DJ part to run.
   * But hiding a section is about clutter while you're planning, and the songs
   * don't go anywhere — so a producer who tidied the page away found their
   * uploaded tracks had no buttons on the night, with nothing on screen saying
   * why. Only a song someone deliberately uploaded a file for gets a pad
   * (buildSoundboard drops the rest), so surfacing them can't conjure a bank
   * out of a section nobody filled in.
   */
  /**
   * The DJ list this show actually runs on: its own songs plus the whole music
   * library. Everything that reads the list — the section, the readiness
   * count, Run Show's soundboard, the exports — reads this one, so a library
   * track is present in all of them or none.
   */
  const djSongs = useMemo(
    () => showDJSongs(show, settings.musicLibrary ?? []),
    [show, settings.musicLibrary],
  );
  const runnableDJSongs = djSongs;

  function openViewer() {
    setViewerNoteDraft(show.viewNote ?? '');
    setViewerCopied(false);
    setViewerCopyFailed(false);
    setViewerOpen(true);
  }

  /**
   * Book someone off the Rolodex onto this show, and hand their new record
   * back so a cue can link to it.
   *
   * Everything the Rolodex holds comes with them — most importantly the
   * walk-on, which is the whole reason a cue links to a performer rather than
   * just naming one in text.
   */
  function bookFromRolodex(comic: PotentialComic): Performer {
    const performer: Performer = {
      id: generateId(),
      name: comic.name,
      socialMedia: comic.socialMedia,
      email: comic.email,
      credits: comic.credits,
      walkOnMusic: comic.walkOnMusic,
      walkOnMusicName: comic.walkOnMusicName,
      walkOnMusicArtist: comic.walkOnMusicArtist,
      walkOnMusicTimestamp: comic.walkOnMusicTimestamp,
      walkOnMusicLink: comic.walkOnMusicLink,
    };
    handleUpdate({ performers: [...show.performers, performer] });
    return performer;
  }

  // Everyone on file who isn't already on this bill — matched on name, since a
  // performer booked from the Rolodex is a copy rather than a reference.
  const unbookedComics = useMemo(() => {
    const onBill = new Set(show.performers.map((p) => p.name.trim().toLowerCase()));
    return settings.potentialComics.filter((c) => !onBill.has(c.name.trim().toLowerCase()));
  }, [settings.potentialComics, show.performers]);

  const rolodexTerm = getRolodexTerm(settings);
  /**
   * Names to suggest under the Host field, each carrying where it came from.
   *
   * A datalist can't group its options the way the old select's optgroups did,
   * but an option's `label` renders beside its value — so "on this show" or
   * the Rolodex's own term travels with each name instead of being a heading
   * above a block of them. The bill still comes first, and wins on a duplicate:
   * a name on both lists is someone already booked.
   */
  const hostSuggestions = useMemo(() => {
    const picks = hostChoices(show.performers, show.artists, settings.potentialComics);
    const seen = new Set<string>();
    const out: { name: string; from: string }[] = [];
    for (const [names, from] of [
      [picks.onBill, 'on this show'],
      [picks.rolodex, rolodexTerm.singular.toLowerCase()],
    ] as const) {
      for (const name of names) {
        const key = name.trim().toLowerCase();
        if (key && !seen.has(key)) {
          seen.add(key);
          out.push({ name, from });
        }
      }
    }
    return out;
  }, [show.performers, show.artists, settings.potentialComics, rolodexTerm]);
  const hostListId = `show-host-options-${show.id}`;
  /**
   * The picker under the Host field.
   *
   * A datalist is invisible on most phones — it only appears once you have
   * typed enough of a name to match, which is no use when the whole point is
   * not remembering how the name is spelled. So the same names are also a
   * list you can open and tap.
   */
  const [hostPicking, setHostPicking] = useState(false);

  function handleScenesChange(scenes: Scene[]) {
    onUpdate({ ...show, scenes });
  }

  function handleUpdate(updates: Partial<Show>) {
    const base = showRef.current;
    const merged = { ...base, ...updates };

    // Auto-add walk-on music to DJ list when performers/artists get new songs
    if (updates.performers || updates.artists) {
      const previousPerformers = base.performers;
      const previousArtists = base.artists;
      const newPerformers = merged.performers;
      const newArtists = merged.artists;
      const newDJSongs = [...merged.djSongs];

      for (const p of newPerformers) {
        const prev = previousPerformers.find((pp) => pp.id === p.id);
        if (p.walkOnMusicName && p.walkOnMusicName !== prev?.walkOnMusicName) {
          const alreadyExists = newDJSongs.some(
            (s) => s.notes === `Walk-on: ${p.name}`,
          );
          if (!alreadyExists) {
            newDJSongs.push({
              id: generateId(),
              title: p.walkOnMusicName.replace(/\.[^.]+$/, ''),
              artist: p.name,
              notes: `Walk-on: ${p.name}`,
            });
          }
        }
      }

      for (const a of newArtists) {
        const prev = previousArtists.find((pa) => pa.id === a.id);
        if (a.walkOnMusicName && a.walkOnMusicName !== prev?.walkOnMusicName) {
          const alreadyExists = newDJSongs.some(
            (s) => s.notes === `Walk-on: ${a.name}`,
          );
          if (!alreadyExists) {
            newDJSongs.push({
              id: generateId(),
              title: a.walkOnMusicName.replace(/\.[^.]+$/, ''),
              artist: a.name,
              notes: `Walk-on: ${a.name}`,
            });
          }
        }
      }

      merged.djSongs = newDJSongs;
    }

    onUpdate(merged);
  }

  function handleHideSection(sectionKey: SectionKey) {
    const hidden = show.hiddenSections || [];
    if (!hidden.includes(sectionKey)) {
      onUpdate({ ...show, hiddenSections: [...hidden, sectionKey] });
    }
  }

  function handleRestoreSection(sectionKey: SectionKey) {
    const hidden = (show.hiddenSections || []).filter(k => k !== sectionKey);
    const updates: Partial<Show> = { hiddenSections: hidden };
    // Adding Scenes is what brings the list into being. Until a producer asks
    // for it, `scenes` stays undefined and the section stays out of the way —
    // see isSectionHidden.
    if (sectionKey === 'scenes' && show.scenes === undefined) updates.scenes = [];
    onUpdate({ ...show, ...updates });
  }

  /**
   * Whether a section is off for this show.
   *
   * Every section but one is opt-out: present unless the producer removed it.
   * Scenes is opt-in, because the page otherwise asks for the running order
   * twice — Schedule holds the cues that Run Show and the public viewer read,
   * while Scenes is a separate list nothing else on the night uses. Sitting
   * open and empty at the bottom of every show, it read as a section the
   * producer had failed to fill in.
   *
   * `scenes: undefined` is the signal for "never used". An array — even an
   * empty one — means the producer added the section, so it survives a reload
   * before they've written the first scene. No schema change needed.
   */
  function isSectionHidden(sectionKey: SectionKey): boolean {
    if ((show.hiddenSections || []).includes(sectionKey)) return true;
    if (sectionKey === 'scenes') return show.scenes === undefined;
    return false;
  }

  function toggleSection(sectionKey: string) {
    const newExpanded = new Set(expandedSections);
    if (newExpanded.has(sectionKey)) {
      newExpanded.delete(sectionKey);
    } else {
      newExpanded.add(sectionKey);
    }
    setExpandedSections(newExpanded);
  }

  function handleSaveShowName() {
    if (tempShowName.trim()) {
      onUpdate({ ...show, name: tempShowName.trim() });
      setEditingShowName(false);
    }
  }

  function handleEditShowName() {
    setTempShowName(show.name);
    setEditingShowName(true);
  }

  function buildStartsAtISO(): string | undefined {
    if (!show.date) return undefined;
    if (show.time) return `${show.date}T${show.time}`;
    return show.date;
  }

  function viewerUrl(token: string): string {
    // Carries this show's audio key in the fragment once Run Show has published
    // a board to the viewer — without it the viewer can still show the running
    // order, it just can't decode the music. The fragment never leaves the
    // browser, so the server storing that audio still can't read it.
    return buildViewerUrl(window.location.origin, token, loadViewerKey(token));
  }

  // The lineup the public viewer shows pre-show — performers in their list order.
  function buildLineup(): LiveViewPayload['lineup'] {
    return show.performers.map((p) => ({
      name: p.name,
      credits: p.credits,
    }));
  }

  function buildScheduledPayload(note: string | undefined): LiveViewPayload {
    return {
      showName: show.name,
      status: 'scheduled',
      startsAt: buildStartsAtISO(),
      note: note?.trim() || undefined,
      theme: loadColorScheme(),
      lineup: buildLineup(),
      lastUpdateMs: Date.now(),
    };
  }

  async function handleSaveViewer() {
    let token = show.viewToken;
    let updates: Partial<Show> = { viewNote: viewerNoteDraft.trim() || undefined };
    if (!token) {
      token = generateId();
      updates = { ...updates, viewToken: token };
    }
    onUpdate({ ...show, ...updates });
    try { await publishLiveView(token, buildScheduledPayload(viewerNoteDraft)); } catch { /* ignore */ }
  }

  function handleCopyViewer() {
    const token = show.viewToken;
    if (!token) return;
    const url = viewerUrl(token);
    navigator.clipboard?.writeText(url).then(() => {
      setViewerCopyFailed(false);
      setViewerCopied(true);
      setTimeout(() => setViewerCopied(false), 1800);
    }).catch(() => {
      // The link is already on screen, in a read-only field an inch away. The
      // old fallback opened a window.prompt to show the same string again —
      // a blocking dialog, in the one situation most likely to be the
      // installed app, where blocking dialogs are what hang the page. Select
      // the field it's already in instead.
      setViewerCopyFailed(true);
      const field = viewerUrlRef.current;
      field?.focus();
      field?.select();
    });
  }

  function handleAddTodoText(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const todo: TodoItem = {
      id: generateId(),
      text: trimmed,
      completed: false,
    };
    onUpdate({ ...show, todos: [...(show.todos || []), todo] });
  }

  function handleToggleTodo(todoId: string) {
    const todos = (show.todos || []).map((t) =>
      t.id === todoId ? { ...t, completed: !t.completed } : t
    );
    onUpdate({ ...show, todos });
  }

  async function handleDeleteTodo(todoId: string) {
    const todo = (show.todos || []).find((t) => t.id === todoId);
    if (await confirm(`Delete to-do "${todo?.text}"? This cannot be undone.`)) {
      const todos = (show.todos || []).filter((t) => t.id !== todoId);
      onUpdate({ ...show, todos });
    }
  }

  const sections = [
    {
      key: 'performers',
      sectionKey: 'performers' as SectionKey,
      title: 'Performers',
      subtitle: 'Names, walk-on music, and social media.',
      accent: 'rose',
      count: show.performers.length,
      preview: joinNames(show.performers.map((p) => p.name)),
      content: <PerformersSection
        performers={show.performers}
        potentialComics={settings.potentialComics}
        showName={show.name}
        performerTarget={show.performerTarget}
        onSaveToRolodex={onSaveToRolodex}
        onChange={(performers) => handleUpdate({ performers })}
        onTargetChange={(performerTarget) => handleUpdate({ performerTarget })}
        renderContracts={
          session && onUpdateSettings
            ? (performer) => (
                <PerformerContracts
                  performerName={performer.name}
                  performerEmail={performer.email}
                  settings={settings}
                  session={session}
                  onUpdateSettings={onUpdateSettings}
                />
              )
            : undefined
        }
      />,
    },
    {
      key: 'artists',
      sectionKey: 'artists' as SectionKey,
      title: 'Artists',
      subtitle: 'Artist entries with name, type, and music.',
      accent: 'magenta',
      count: show.artists.length,
      preview: joinNames(show.artists.map((a) => a.name)),
      content: <ArtistsSection
        artists={show.artists}
        potentialComics={settings.potentialComics}
        onChange={(artists) => handleUpdate({ artists })}
      />,
    },
    {
      key: 'schedule',
      sectionKey: 'schedule' as SectionKey,
      title: 'Schedule',
      subtitle: 'Timeline of events with times and descriptions.',
      accent: 'blue',
      count: show.schedule.length,
      preview: scheduleSummary(show.schedule),
      content: <ScheduleSection
        schedule={show.schedule}
        showName={show.name}
        showTime={show.time}
        performers={show.performers}
        host={show.host}
        knownNames={knownNames}
        unbookedComics={unbookedComics}
        onBookPerformer={bookFromRolodex}
        onChange={(schedule) => handleUpdate({ schedule })}
        djSongs={djSongs}
        templates={settings.scheduleTemplates}
        onSaveTemplate={onSaveScheduleTemplate}
        onDeleteTemplate={onDeleteScheduleTemplate}
      />,
    },
    {
      key: 'dj',
      sectionKey: 'dj' as SectionKey,
      title: 'DJ Music',
      subtitle: 'Songs and notes for the DJ.',
      accent: 'teal',
      count: djSongs.length,
      preview: joinNames(djSongs.map((song) => song.title)),
      content: (
        <DJMusicSection

          show={show}
          library={settings.musicLibrary ?? []}
          onUpdate={handleUpdate}
        />
      ),
    },
    {
      key: 'staff',
      sectionKey: 'staff' as SectionKey,
      title: 'Staff',
      subtitle: 'Roles and assignments for production staff.',
      accent: 'amber',
      count: show.staff.length,
      preview: staffSummary(show.staff),
      content: <StaffSection staff={show.staff} onChange={(staff) => handleUpdate({ staff })} />,
    },
    {
      key: 'vendors',
      sectionKey: 'vendors' as SectionKey,
      title: 'Vendors',
      subtitle: 'Build a profile for each vendor — contact, cost, and notes.',
      accent: 'green',
      count: (show.vendors || []).length,
      preview: vendorsSummary(show.vendors || []),
      content: <VendorsSection vendors={show.vendors || []} onChange={(vendors) => handleUpdate({ vendors })} />,
    },
    {
      key: 'scenes',
      sectionKey: 'scenes' as SectionKey,
      title: 'Scenes & Segments',
      subtitle: 'A separate list of scenes, for shows built in blocks rather than cues.',
      accent: 'violet',
      count: (show.scenes ?? []).length,
      content: <SceneList scenes={show.scenes ?? []} onChange={handleScenesChange} />,
    },
    // Last, not first. The header already prints the date, time, venue and
    // location, so this is where you *change* them rather than where you read
    // them — and that happens once, at setup. Everything you open a show to
    // work on sits above it.
    {
      key: 'basic',
      sectionKey: 'basic' as SectionKey,
      title: 'Basic Info',
      subtitle: 'Date, time, location, and venue.',
      accent: 'slate',
      content: <BasicInfoSection show={show} onChange={handleUpdate} />,
    },
  ];

  // Add recap section for past shows
  if (isPastShow) {
    sections.push({
      key: 'recap',
      sectionKey: 'recap' as SectionKey,
      title: 'Recap',
      subtitle: 'Attendance, sales, performer notes, and lessons learned.',
      accent: 'slate',
      content: (
        <ShowRecapSection
          recap={show.recap}
          expenses={show.expenses}
          todos={show.todos || []}
          onChange={(recap) => handleUpdate({ recap })}
          onAddTodo={handleAddTodoText}
          onToggleTodo={handleToggleTodo}
          onDeleteTodo={handleDeleteTodo}
        />
      ),
    });
  }

  // Which of the sections above are actually on the page right now, so a
  // tile only offers to jump somewhere that exists — a section the producer
  // hid stays hidden rather than reappearing because its tile was tapped.
  const visibleSections = sections.filter((section) => !isSectionHidden(section.sectionKey));
  const jumpableSectionKeys = new Set(visibleSections.map((section) => section.key));
  // Read off the sections rather than restated on the tiles, so a tile and the
  // section it jumps to can never end up wearing different colours.
  const accentBySection = new Map(sections.map((section) => [section.sectionKey, section.accent]));

  // Date and time are written the same way here as on the show cards, so the
  // same show doesn't read as "9/18/2026 20:00" in one place and
  // "Sep 18 · 8:00 PM" in another.
  const detailDate = parseShowDate(show.date);
  const metaParts: { text: string; kind: 'when' | 'place' }[] = [
    {
      text: detailDate?.toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: detailDate.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
      }),
      kind: 'when' as const,
    },
    { text: formatShowTime(show.time), kind: 'when' as const },
    { text: show.venueName, kind: 'place' as const },
    { text: show.location, kind: 'place' as const },
  ].filter((part): part is { text: string; kind: 'when' | 'place' } => !!part.text);

  // Every secondary action for this show, in one menu attached to the show —
  // rather than scattered across the app's navigation.
  const moreItems: MoreMenuItem[] = [
    { label: 'Viewer link', onSelect: openViewer },
    { label: 'Export PDF', onSelect: () => exportShowToPDF(show, settings) },
    { label: 'Add or remove sections', onSelect: () => setManageSectionsOpen(true) },
  ];

  if (onDuplicate) {
    moreItems.push({
      label: 'Duplicate show',
      // Back to the list, because the copy is a different show from the one
      // you're looking at and it lands at the top of the grid.
      onSelect: () => { onDuplicate(show.id); onBack(); },
    });
  }

  if (onDelete) {
    moreItems.push({
      label: 'Delete show',
      danger: true,
      onSelect: async () => {
        const ok = await confirm({
          title: `Delete "${show.name}"?`,
          message: 'It will be moved to trash, where you can recover it.',
        });
        if (ok) { onDelete(show.id); onBack(); }
      },
    });
  }

  // Two groups of four, so the counts read as two related clusters rather than
  // one undifferentiated row of eight: who and what is on stage, then what it
  // takes to put them there.
  //
  // A tile only appears once the show actually has some of that thing. A row of
  // zeroes is not a summary — it's a list of everything this show isn't, and it
  // pushed the parts that do exist off the top of the screen.
  const hiddenKeys = new Set(show.hiddenSections ?? []);
  // Each tile carries both forms of its noun. A tile only shows once its count
  // is at least one, so the count of one is a case that reaches the screen
  // constantly — and it was reading "1 DJ songs" and "1 Vendors".
  const allTileGroups: Array<Array<{
    icon: IconName; value: number; label: string; labelOne?: string; sectionKey?: SectionKey;
  }>> = [
    [
      { icon: 'users', value: stats.counts.performers, label: 'Performers', labelOne: 'Performer', sectionKey: 'performers' },
      { icon: 'sparkle', value: stats.counts.artists, label: 'Artists', labelOne: 'Artist', sectionKey: 'artists' },
      { icon: 'schedule', value: stats.counts.cues, label: 'Cues', labelOne: 'Cue', sectionKey: 'schedule' },
      { icon: 'music', value: stats.counts.songs, label: 'DJ songs', labelOne: 'DJ song', sectionKey: 'dj' },
    ],
    [
      // "Staff" is already a plural; one of them is a staff member.
      { icon: 'wrench', value: stats.counts.staff, label: 'Staff', labelOne: 'Staff member', sectionKey: 'staff' },
      { icon: 'bolt', value: stats.counts.vendors, label: 'Vendors', labelOne: 'Vendor', sectionKey: 'vendors' },
      { icon: 'file', value: stats.counts.expenses, label: 'Expenses', labelOne: 'Expense', sectionKey: 'expenses' },
      { icon: 'check', value: stats.counts.todos, label: 'To-dos', labelOne: 'To-do' },
    ],
  ];
  /**
   * One flat row of tiles, not two boxed groups of four.
   *
   * The grouping was worth its wrapper when eight tiles showed at once. They
   * don't: a tile only appears once the show has some of that thing, so in
   * practice this is one to four. Two bordered boxes each holding a single
   * count, stacked above a second bordered box holding a single bar, was most
   * of a phone screen of chrome describing very little — and it sat between
   * the header and the lineup.
   */
  const tiles = allTileGroups
    .flat()
    .filter((tile) => tile.value > 0 && !(tile.sectionKey && hiddenKeys.has(tile.sectionKey)));

  // Same rule for the readiness bars: "Vendors booked 0/0 — 0%" measures
  // nothing. A bar earns its place once there is something to be ready about.
  const progressStats = stats.progress.filter((stat) => stat.total > 0);
  const hasRunTime = stats.runMinutes > 0;

  return (
    <div className="show-detail">
      {/* Outside the hero, not inside it. A sticky element can only stick
          within its own containing block, and the hero is 185px tall — so
          nested in there the bar unstuck itself almost immediately and rode
          the page up like everything else. Out here its containing block is
          the whole show page. */}
      <div
        className={`show-detail__topbar${titleInBar ? ' show-detail__topbar--titled' : ''}`}
        ref={topbarRef}
      >
          {/* The visible "Shows" label is hidden on narrow phones (see the CSS),
              so the button carries its own name for assistive tech. */}
          <button
            type="button"
            className="show-detail__back-btn"
            onClick={onBack}
            aria-label="Back to shows"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16" aria-hidden="true">
              <path
                fillRule="evenodd"
                d="M12.707 4.293a1 1 0 010 1.414L8.414 10l4.293 4.293a1 1 0 01-1.414 1.414l-5-5a1 1 0 010-1.414l5-5a1 1 0 011.414 0z"
                clipRule="evenodd"
              />
            </svg>
            <span>Shows</span>
          </button>
          {/* Once the page's own big title has scrolled past, its name appears
              here instead, so a bar stuck to the top of a long show page still
              says which show you are in. The gap it fills was the spacer the
              old save indicator used to occupy.

              aria-hidden because the page's <h1> is the real title and is
              still in the document — this is the same words a second time,
              which a screen reader has no use for. */}
          <div
            className={`show-detail__topbar-title${titleInBar ? ' show-detail__topbar-title--shown' : ''}`}
            aria-hidden="true"
          >
            {show.name}
          </div>
          <button
            className="show-detail__run-show"
            onClick={() => setRunShowOpen(true)}
            title="Run the live show"
          >
            <Icon name="play" size={14} />
            Run Show
          </button>
          <MoreMenu label="More show actions" items={moreItems} />
        </div>

      <div className="show-detail__hero">
        <div className="show-detail__header" ref={heroRef}>
          {editingShowName ? (
            <div className="show-detail__name-edit">
              {/* The page keeps exactly one h1 whether or not the name is being
                  edited, so the document outline never changes underfoot. */}
              <h1 className="visually-hidden">{tempShowName || show.name}</h1>
              <input
                className="section-field__input show-detail__name-input"
                value={tempShowName}
                onChange={(e) => setTempShowName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveShowName();
                  if (e.key === 'Escape') setEditingShowName(false);
                }}
                placeholder="Show name"
                aria-label="Show name"
                autoFocus
              />
              <button className="btn btn--primary btn--sm" onClick={handleSaveShowName}>
                Save
              </button>
              <button className="btn btn--ghost btn--sm" onClick={() => setEditingShowName(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <>
              <h1 className="show-detail__title">{show.name}</h1>
              <button
                className="show-detail__name-edit-btn"
                onClick={handleEditShowName}
                aria-label={`Edit show name, currently ${show.name}`}
              >
                <Icon name="edit" size={14} aria-hidden />
                <span>Edit</span>
              </button>
            </>
          )}
          <select
            className={`show-detail__status show-detail__status--select show-detail__status--${show.status}`}
            value={show.status}
            onChange={(e) => {
              onUpdate({ ...show, status: e.target.value as ShowStatus });
            }}
            aria-label="Show status"
            title="Change show status"
          >
            {(Object.keys(STATUS_LABELS) as ShowStatus[]).map((status) => (
              <option key={status} value={status}>{STATUS_LABELS[status]}</option>
            ))}
          </select>
          {/* On the same line as the status rather than a row of its own: both
              are facts about the show, and stacking them pushed the first real
              content another line down the phone. */}
          {metaParts.length > 0 && (
            <div className="show-detail__meta">
              {metaParts.map((part) => (
                <span
                  key={part.text}
                  className={part.kind === 'place' ? 'show-detail__meta-place' : undefined}
                >
                  {part.text}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Host — one row, not two.
          The name field and a "Pick someone…" select used to sit side by side,
          and on a phone the select dropped to a full-width line of its own
          (its label was being cut to "Use a performe" otherwise). Two rows of
          chrome for one optional field, directly above the lineup.

          A datalist folds the picker back into the field: type, or pick from
          the same names. The one loss is the On this show / Rolodex grouping,
          which a datalist can't render — so the bill is listed first, where
          the host almost always comes from. */}
      <div className="show-detail__host">
        <label className="show-detail__host-label" htmlFor="show-host-input">Host</label>
        <input
          id="show-host-input"
          type="text"
          className="section-field__input show-detail__host-input"
          placeholder="Host name"
          list={hostListId}
          value={show.host || ''}
          onChange={(e) => onUpdate({ ...show, host: e.target.value || undefined })}
        />
        {hostSuggestions.length > 0 && (
          <>
            <datalist id={hostListId}>
              {hostSuggestions.map((pick) => (
                <option key={pick.name} value={pick.name} label={pick.from} />
              ))}
            </datalist>
            <button
              type="button"
              className="btn btn--secondary btn--sm show-detail__host-pick"
              aria-expanded={hostPicking}
              onClick={() => setHostPicking((v) => !v)}
            >
              {hostPicking ? 'Close' : `Pick from ${rolodexTerm.plural.toLowerCase()}`}
            </button>
          </>
        )}
        {hostPicking && (
          <div className="show-detail__host-list">
            {hostSuggestions.map((pick) => (
              <button
                key={pick.name}
                type="button"
                className="show-detail__host-option"
                onClick={() => {
                  onUpdate({ ...show, host: pick.name });
                  setHostPicking(false);
                }}
              >
                <span className="show-detail__host-option-name">{pick.name}</span>
                <span className="show-detail__host-option-from">{pick.from}</span>
              </button>
            ))}
            {show.host && (
              <button
                type="button"
                className="show-detail__host-option show-detail__host-option--clear"
                onClick={() => {
                  onUpdate({ ...show, host: undefined });
                  setHostPicking(false);
                }}
              >
                Clear the host
              </button>
            )}
          </div>
        )}
      </div>

      {/* At a glance — one strip, not three stacked boxes.
          Counts, run time and readiness are all answers to "how is this show
          doing", so they share one grid of uniform cards instead of each
          getting its own bordered block. Each still earns its place: a tile
          appears once the show has some of that thing, a bar once there is
          something to be ready about, and run time once the cues have
          lengths — otherwise it was a green panel containing an em-dash on
          every show the day it was created. */}
      {(tiles.length > 0 || hasRunTime || progressStats.length > 0) && (
        <section className="show-summary" aria-label="Show at a glance">
          {tiles.map((tile) => {
            // A tile only jumps if there's a section on this page to land in.
            // Expenses and To-dos don't get their own section — they surface
            // inside Recap, and only once the show is in the past.
            const jumpsTo = tile.sectionKey && jumpableSectionKeys.has(tile.sectionKey) ? tile.sectionKey : undefined;
            // Those two keep the neutral chip, which also reads as "this one
            // isn't a link".
            const accent = (tile.sectionKey && accentBySection.get(tile.sectionKey)) || 'slate';
            const body = (
              <>
                <span className={`show-tile__icon accent--${accent}`}>
                  <Icon name={tile.icon} size={18} />
                </span>
                <span className="show-tile__body">
                  <span className="show-tile__value">{tile.value}</span>
                  <span className="show-tile__label">
                    {tile.value === 1 ? tile.labelOne ?? tile.label : tile.label}
                  </span>
                </span>
              </>
            );
            return jumpsTo ? (
              <button
                type="button"
                className="show-tile show-tile--jump"
                key={tile.label}
                onClick={() => jumpToSection(jumpsTo)}
              >
                {body}
              </button>
            ) : (
              <div className="show-tile" key={tile.label}>
                {body}
              </div>
            );
          })}

          {hasRunTime && (
            <div className="show-tile show-tile--runtime">
              <span className="show-tile__icon accent--slate">
                <Icon name="clock" size={18} />
              </span>
              <span className="show-tile__body">
                <span className="show-tile__value">{formatRunTime(stats.runMinutes)}</span>
                <span className="show-tile__label">Run time</span>
              </span>
            </div>
          )}

          {progressStats.map((stat) => {
            const percent = progressPercent(stat);
            const full = isComplete(stat);
            return (
              <div
                className={`show-progress__card${full ? ' show-progress__card--full' : ''}`}
                key={stat.key}
              >
                <span className="show-progress__label">{stat.label}</span>
                <span className="show-progress__figure">
                  <strong className="show-progress__value">
                    {stat.done}<span className="show-progress__of">/{stat.total}</span>
                  </strong>
                  {/* "100%" tells you the ratio; "Full" tells you to stop
                      booking. On the lineup that is the whole question. */}
                  <span className={`show-progress__pct${full ? ' show-progress__pct--full' : ''}`}>
                    {full ? 'Full' : `${percent}%`}
                  </span>
                </span>
                <span
                  className="show-progress__track"
                  role="progressbar"
                  aria-valuenow={percent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={stat.label}
                >
                  <span
                    className={`show-progress__bar show-progress__bar--${stat.key}`}
                    style={{ width: `${percent}%` }}
                  />
                </span>
              </div>
            );
          })}
        </section>
      )}

      <div className="show-detail__sections-accordion">
        {visibleSections.map((section) => {
          const isExpanded = expandedSections.has(section.key);
          const panelId = `show-section-panel-${section.key}`;
          const buttonId = `show-section-header-${section.key}`;
          const filled = typeof section.count === 'number' && section.count > 0;

          return (
            <section
              key={section.key}
              ref={(el) => {
                sectionRefs.current[section.key] = el;
              }}
              className={`accordion-section${isExpanded ? ' accordion-section--expanded' : ''}`}
            >
              {/* The whole header is one button, wrapped in the heading. It used
                  to be a div with a click handler and a separate arrow button,
                  so the only thing a keyboard could reach was the arrow — the
                  large obvious target was mouse-only. */}
              <h2 className="accordion-section__heading">
                <button
                  type="button"
                  id={buttonId}
                  className="accordion-section__header"
                  onClick={() => toggleSection(section.key)}
                  aria-expanded={isExpanded}
                  aria-controls={panelId}
                >
                  <span className={`accordion-section__icon accent--${section.accent}`}>
                    <Icon name={SECTION_ICONS[section.key] ?? 'file'} size={18} />
                  </span>
                  <span className="accordion-section__header-left">
                    <span className="accordion-section__title-row">
                      <span className="accordion-section__title">{section.title}</span>
                      {filled && (
                        <span className="accordion-section__count">
                          {section.count}
                          <span className="visually-hidden"> added</span>
                        </span>
                      )}
                    </span>
                    {/* One line under the title, doing the most useful job it
                        can: what's actually in there once the section has
                        content, and what belongs there while it's empty.
                        Hidden when open, where the content itself answers it. */}
                    {!isExpanded &&
                      (filled ? (
                        section.preview && (
                          <span className="accordion-section__preview">{section.preview}</span>
                        )
                      ) : (
                        <span className="accordion-section__subtitle">{section.subtitle}</span>
                      ))}
                  </span>
                  <svg
                    className="accordion-section__chevron"
                    viewBox="0 0 20 20"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="5 8 10 13 15 8" />
                  </svg>
                </button>
              </h2>

              {isExpanded && (
                <div
                  id={panelId}
                  role="region"
                  aria-labelledby={buttonId}
                  className="accordion-section__content"
                >
                  {section.content}
                </div>
              )}
            </section>
          );
        })}
      </div>

      <div className="show-detail__manage-row">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => setManageSectionsOpen(true)}
        >
          Add or remove sections
        </button>
      </div>

      {runShowOpen && (
        <RunShow
          showName={show.name}
          showId={show.id}
          viewToken={show.viewToken}
          schedule={show.schedule}
          performers={show.performers}
          djSongs={runnableDJSongs}
          libraryCount={(settings.musicLibrary ?? []).length}
          remoteKey={settings.remoteMusicKey}
          onStart={() => {
            if (show.status !== 'completed' && show.status !== 'in-progress') {
              onUpdate({ ...show, status: 'in-progress' });
            }
          }}
          onFinish={() => onUpdate({ ...show, status: 'completed' })}
          onClose={() => setRunShowOpen(false)}
        />
      )}

      {manageSectionsOpen && (
        <Modal onClose={() => setManageSectionsOpen(false)} labelledBy="manage-sections-title">
          <div className="manage-sections">
            <h2 id="manage-sections-title" className="manage-sections__title">Sections</h2>
            <p className="manage-sections__sub">
              Choose what this show tracks. Removing a section only hides it — nothing you've
              entered is deleted, and it all comes back if you add the section again.
            </p>
            <ul className="manage-sections__list">
              {sections.map((section) => {
                const hidden = isSectionHidden(section.sectionKey);
                const locked = section.sectionKey === 'basic';
                return (
                  <li key={section.key} className="manage-sections__row">
                    <div className="manage-sections__info">
                      <span className="manage-sections__name">{section.title}</span>
                      <span className="manage-sections__desc">{section.subtitle}</span>
                    </div>
                    {locked ? (
                      <span className="manage-sections__always">Always on</span>
                    ) : (
                      <button
                        type="button"
                        className={`btn btn--sm ${hidden ? 'btn--secondary' : 'btn--ghost'}`}
                        onClick={() =>
                          hidden
                            ? handleRestoreSection(section.sectionKey)
                            : handleHideSection(section.sectionKey)
                        }
                      >
                        {hidden ? 'Add' : 'Remove'}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            <div className="manage-sections__actions">
              <button className="btn btn--primary" onClick={() => setManageSectionsOpen(false)}>Done</button>
            </div>
          </div>
        </Modal>
      )}

      {viewerOpen && (
        <Modal onClose={() => setViewerOpen(false)} labelledBy="viewer-link-modal-title">
          <div className="viewer-link-modal">
            <h2 id="viewer-link-modal-title" className="viewer-link-modal__title">Public viewer link</h2>
            <p className="viewer-link-modal__sub">
              A read-only page anyone with the link can open — shows the timer, who's on stage,
              and who's coming up next. Until the show goes live, it shows the start time and
              your note below.
            </p>

            {show.viewToken ? (
              <div className="viewer-link-modal__url-row">
                <input
                  ref={viewerUrlRef}
                  className="section-field__input"
                  readOnly
                  value={viewerUrl(show.viewToken)}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button className="btn btn--secondary btn--sm" onClick={handleCopyViewer}>
                  {viewerCopied ? 'Copied!' : 'Copy'}
                </button>
              </div>
            ) : null}
            {show.viewToken && viewerCopyFailed ? (
              <p className="viewer-link-modal__hint" role="status">
                Couldn't reach the clipboard — the link is selected above, so copy it by hand.
              </p>
            ) : (
              <p className="viewer-link-modal__hint">
                Save to generate the link.
              </p>
            )}

            <label className="section-field__label" style={{ marginTop: 14 }}>Pre-show note (optional)</label>
            <textarea
              className="section-field__input"
              rows={4}
              value={viewerNoteDraft}
              onChange={(e) => setViewerNoteDraft(e.target.value)}
              placeholder="e.g. Doors at 7:30 PM · 21+ · BYOB"
              style={{ resize: 'vertical' }}
            />

            <div className="viewer-link-modal__actions">
              <button className="btn btn--primary" onClick={handleSaveViewer}>
                {show.viewToken ? 'Save & publish' : 'Generate link & publish'}
              </button>
              <button className="btn btn--ghost" onClick={() => setViewerOpen(false)}>Close</button>
            </div>
          </div>
        </Modal>
      )}
      {confirmDialog}
    </div>
  );
}
