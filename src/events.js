/**
 * Event detection (notifications design §4). Pure: every request goes through the `get`
 * function the caller passes in, so this module runs under `node --test` unchanged.
 */

import { DISCUSSION_PAGES_MAX, EVENTS_MAX, EVENTS_MAX_AGE_MS, EXCERPT_MAX } from './config.js';
import {
  ApiError,
  discussionsUrl,
  mapDiscussion,
  mapNote,
  mapOutcome,
  mergeRequestUrl,
  notesUrl,
} from './gitlab.js';
import { coveredByTodo } from './store.js';

/** A note by someone else on an MR the user reviews; a reply only if its thread holds the user. */
export const REPLY_CANDIDATE = 'reply_candidate';

/**
 * GitLab's English system-note wording on the user's own merge request, matched by prefix
 * (notifications design §4.3). `unapproved` is listed on its own: it does not start with
 * `approved`, so the order does not matter.
 */
const AUTHOR_SYSTEM_NOTES = [
  ['approved this merge request', 'approved'],
  ['unapproved this merge request', 'unapproved'],
  ['requested changes', 'changes_requested'],
];

/** The system note GitLab leaves when commits are pushed to a merge request (§4.3). */
const COMMITS_NOTE = /^added \d+ commits?\b/;

/**
 * Compares the stored watch with a fresh snapshot (notifications design §4.2 steps 1, 2, 4).
 *
 * Returns the watch to carry forward, the ids whose notes must be fetched, and the ids of
 * author entries that left both lists. Nothing is advanced here: a changed entry keeps its old
 * state until its fetches succeed, and a disappeared author entry stays until its outcome is
 * known. A merge request with no project id or iid cannot be addressed and is not watched.
 */
export function planWatch(watch, snapshot) {
  const current = new Map();
  for (const mr of snapshot.reviews ?? []) current.set(String(mr.id), { mr, role: 'reviewer' });
  for (const mr of snapshot.mine ?? []) current.set(String(mr.id), { mr, role: 'author' });

  const next = {};
  const changed = [];
  const disappeared = [];
  for (const [id, { mr, role }] of current) {
    if (!mr.projectId || !mr.iid) continue;
    const known = watch?.[id];
    if (!known) {
      next[id] = {
        projectId: mr.projectId,
        iid: mr.iid,
        role,
        updatedAt: mr.updatedAt,
        notesCount: mr.notesCount,
        since: mr.updatedAt,
        lastNoteId: 0,
      };
      continue;
    }
    next[id] = { ...known, role };
    if (known.updatedAt !== mr.updatedAt || known.notesCount !== mr.notesCount) changed.push(id);
  }
  for (const [id, known] of Object.entries(watch ?? {})) {
    if (current.has(id) || known.role !== 'author') continue;
    next[id] = known;
    disappeared.push(id);
  }
  return { watch: next, changed, disappeared };
}

/**
 * The notes of a newest-first page that are not yet classified: those after `lastNoteId` and
 * created after the entry's baseline (notifications design §4.2 step 2).
 */
export function newNotes(notes, entry) {
  const fresh = [];
  for (const note of notes) {
    if (note.id <= entry.lastNoteId || note.createdAt <= entry.since) break;
    fresh.push(note);
  }
  return fresh;
}

/**
 * The event kind a note raises for the user, `REPLY_CANDIDATE` when that depends on its thread,
 * or null (notifications design §4.3).
 */
export function classifyNote(note, entry, me) {
  if (note.authorId === me.id) return null;
  if (!note.system) return entry.role === 'author' ? 'comment' : REPLY_CANDIDATE;
  if (entry.role === 'author') {
    const match = AUTHOR_SYSTEM_NOTES.find(([prefix]) => note.body.startsWith(prefix));
    return match ? match[1] : null;
  }
  return COMMITS_NOTE.test(note.body) ? 'commits' : null;
}

/**
 * The candidate note ids that sit in a thread the user has a note in (notifications design
 * §4.2 step 3). A stand-alone note is nobody's thread.
 */
export function replyNoteIds(discussions, candidateIds, me) {
  const replies = new Set();
  for (const discussion of discussions) {
    if (discussion.individual) continue;
    if (!discussion.notes.some((note) => note.authorId === me.id && !note.system)) continue;
    for (const note of discussion.notes) {
      if (candidateIds.has(note.id)) replies.add(note.id);
    }
  }
  return replies;
}

/**
 * The entry after a successful fetch: the MR's current state, and the newest note id seen
 * (notifications design §4.2 step 5).
 */
export function advanceEntry(entry, mr, notes) {
  const newest = notes.reduce((max, note) => Math.max(max, note.id), entry.lastNoteId);
  return { ...entry, updatedAt: mr.updatedAt, notesCount: mr.notesCount, lastNoteId: newest };
}

/** The stored event for a classified note (notifications design §5). */
export function noteEvent(kind, note, mr) {
  return {
    id: `note:${note.id}`,
    kind,
    mrTitle: mr.title,
    mrReference: mr.reference,
    url: mr.url ? `${mr.url}#note_${note.id}` : '',
    actorName: note.authorName,
    actorAvatar: note.authorAvatar,
    excerpt: note.system ? '' : note.body.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_MAX),
    createdAt: note.createdAt,
  };
}

/**
 * The stored event for a merge request that left the open list, or null when it is still open
 * or the user did it themselves (notifications design §4.2 step 4). An outcome GitLab reports
 * without an actor or a timestamp is still an event: an empty name and the detection time are
 * better than a lost merge.
 */
export function outcomeEvent(outcome, me, now) {
  if (outcome.state !== 'merged' && outcome.state !== 'closed') return null;
  if (outcome.actor?.id === me.id) return null;
  return {
    id: `${outcome.state}:${outcome.id}`,
    kind: outcome.state,
    mrTitle: outcome.title,
    mrReference: outcome.reference,
    url: outcome.url,
    actorName: outcome.actor?.name ?? '',
    actorAvatar: outcome.actor?.avatar ?? '',
    excerpt: '',
    createdAt: outcome.at || now,
  };
}

/**
 * The events to store: stored and new merged, one per id, newest first, none a to-do covers,
 * none older than `EVENTS_MAX_AGE_MS`, at most `EVENTS_MAX` (notifications design §5).
 */
export function mergeEvents(existing, added, todos, now) {
  const cutoff = now - EVENTS_MAX_AGE_MS;
  const seen = new Set();
  return [...added, ...(existing ?? [])]
    .filter((event) => {
      if (seen.has(event.id)) return false;
      seen.add(event.id);
      return event.createdAt > cutoff && !coveredByTodo(event, todos);
    })
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, EVENTS_MAX);
}

async function walkDiscussions(get, entry) {
  const discussions = [];
  for (let page = 1; page <= DISCUSSION_PAGES_MAX; page += 1) {
    const { body, nextPage } = await get(discussionsUrl(entry.projectId, entry.iid, page));
    discussions.push(...body.map(mapDiscussion));
    if (nextPage === '') break;
  }
  return discussions;
}

async function inspectChanged(get, entry, mr, me) {
  const notes = (await get(notesUrl(entry.projectId, entry.iid))).body.map(mapNote);
  const events = [];
  const candidates = new Map();
  for (const note of newNotes(notes, entry)) {
    const kind = classifyNote(note, entry, me);
    if (kind === REPLY_CANDIDATE) candidates.set(note.id, note);
    else if (kind) events.push(noteEvent(kind, note, mr));
  }
  if (candidates.size > 0) {
    const discussions = await walkDiscussions(get, entry);
    for (const id of replyNoteIds(discussions, new Set(candidates.keys()), me)) {
      events.push(noteEvent('reply', candidates.get(id), mr));
    }
  }
  return { entry: advanceEntry(entry, mr, notes), events };
}

async function inspectDisappeared(get, entry, me, now) {
  try {
    const outcome = mapOutcome((await get(mergeRequestUrl(entry.projectId, entry.iid))).body);
    const event = outcomeEvent(outcome, me, now);
    return { entry: null, events: event ? [event] : [] };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { entry: null, events: [] };
    throw error;
  }
}

/**
 * One detection pass over a fresh snapshot (notifications design §4.2, §4.4).
 *
 * Returns the watch to store, the new events, and every fetch failure. A failure never
 * rejects the pass: its entry stays as `planWatch` returned it, so the next poll retries it and
 * nothing is lost or raised twice. A disappeared merge request that answers 404 is gone for good
 * and is removed without a failure. `now` stamps an outcome GitLab reports without a timestamp.
 */
export async function collectEvents({ watch, snapshot, me, get, now }) {
  const plan = planWatch(watch, snapshot);
  const mrs = new Map(
    [...(snapshot.reviews ?? []), ...(snapshot.mine ?? [])].map((mr) => [String(mr.id), mr]),
  );
  const jobs = [
    ...plan.changed.map((id) => [id, inspectChanged(get, plan.watch[id], mrs.get(id), me)]),
    ...plan.disappeared.map((id) => [id, inspectDisappeared(get, plan.watch[id], me, now)]),
  ];
  const settled = await Promise.allSettled(jobs.map(([, job]) => job));

  const next = { ...plan.watch };
  const added = [];
  const failures = [];
  settled.forEach((result, index) => {
    const [id] = jobs[index];
    if (result.status === 'rejected') {
      failures.push(result.reason);
      return;
    }
    if (result.value.entry) next[id] = result.value.entry;
    else delete next[id];
    added.push(...result.value.events);
  });
  return { watch: next, added, failures };
}
