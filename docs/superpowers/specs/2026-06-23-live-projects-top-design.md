# Float live projects to the top of the session drawer

**Date:** 2026-06-23
**Status:** Approved design

## Problem

In the session drawer's project list (sidebar), projects render in creation
order — the order each project's first session appears in `app.sessionOrder`.
Most projects have no live session at any given time, so the projects the user
is actually working in get buried among dormant folders. Pulling up "Create a
new session" or jumping into active work means scrolling past dead projects.

## Goal

Projects with a live attached Claude session appear above dormant projects in
the drawer, with no reshuffling during normal back-and-forth work.

## Definition of "live"

A session's status (`src/types/session.ts`) is one of: `busy` (Claude actively
generating), `idle` (process alive, waiting for input), `stopped` (no Claude
process), `error`, or `archived`. The frontend stores the server-provided
`status` verbatim and may leave it `undefined` if a payload omits it
(`app.js:6826-6828`, `6857-6872`). The drawer's green dot is effectively `busy`
only. Note: the drawer's `'running'`/`'active'` status checks are legacy/
defensive — no code actually assigns those to a session object.

The classification is therefore a strict allow-list:

- A project is **live** if any of its sessions has status **`busy` or `idle`**
  (the Claude process is alive). The check scans both `group.sessions` AND
  every array inside `group.worktrees` — a project whose only live session is
  a worktree session must classify as live.
- A project is **dormant** otherwise. `stopped`, `error`, `archived`, and
  `undefined` all fall through to dormant (safe default). Empty seeded project
  groups (cases from `app.cases` with no sessions yet) are dormant and sink —
  this is desired.

Key property: a session flipping `busy` ↔ `idle` between turns stays in the
*live* tier (both are live), so the list does **not** reshuffle as the user
works. It only re-partitions when a session crosses the live/dormant boundary
— i.e. actually starts or stops.

## Ordering

- Stable two-tier partition: all live groups first, then all dormant groups.
- **Within each tier, existing order is preserved** — the current
  creation / `sessionOrder` order. No alphabetical or recency sorting.
- The `__ungrouped__` bucket is partitioned by the same rule.

## Implementation

Single file: `src/web/public/app.js`. Three coordinated changes — the naive
"just sort in `_render()`" version is **broken** because of changes 2 and 3.

### 1. Shared partition helper

Add a small, pure-ish helper on `SessionDrawer`:

```js
// Returns Map entries reordered: live groups first, dormant second,
// each tier preserving the Map's original insertion order.
// getStatus maps a group member to its status string.
_partitionGroupsLiveFirst(groups, getStatus) {
  const live = [], dormant = [];
  const isLive = (group) => {
    if (group.sessions.some(m => { const st = getStatus(m); return st === 'busy' || st === 'idle'; })) return true;
    for (const arr of group.worktrees.values())
      if (arr.some(m => { const st = getStatus(m); return st === 'busy' || st === 'idle'; })) return true;
    return false;
  };
  for (const entry of groups) (isLive(entry[1]) ? live : dormant).push(entry);
  return [...live, ...dormant];
}
```

`getStatus` differs by caller: in `_render()` group members are session
**objects** (`m => m.status`); in `_getOrderedSessionIds()` they are session
**ids** (`id => app.sessions.get(id)?.status`).

Use raw `session.status`, not the debounced `displayStatus` — the busy/idle
merge already makes the partition stable against per-turn flicker.

### 2. `_render()` — render in partitioned order

Between building the `groups` Map (~line 22742) and the render loop
(`for (const [groupKey, group] of groups)` ~line 22744), replace the loop's
iterable with
`this._partitionGroupsLiveFirst(groups, m => m.status)`.

### 3. `_getOrderedSessionIds()` — keep swipe order in sync (CRITICAL)

`_getOrderedSessionIds()` (~line 22932) is the authoritative traversal order
for swipe navigation and rebuilds groups independently. If `_render()` reorders
groups but this does not, visual order and swipe order **diverge**. Apply the
same partition here before flattening to ids:
`for (const [, group] of this._partitionGroupsLiveFirst(groups, id => app.sessions.get(id)?.status))`.

### 4. `_tryIncrementalUpdate()` — force rebuild on tier change (CRITICAL)

`_tryIncrementalUpdate()` (~line 22549) short-circuits `_render()` whenever the
session **set** is unchanged, updating only dots/text in place — it never
reorders groups. Starting/stopping a session does **not** change the set (the
row's `status` changes but its id stays), so without a fix the partition would
never re-run on exactly the transitions it cares about.

Fix: track each session's live flag across renders. Maintain
`this._lastLiveBySession` (a `Map<sid, boolean>` where `live = status==='busy'
|| status==='idle'`). In `_tryIncrementalUpdate`, after the set-equality check,
compare each current session's live flag against the stored value; if **any**
differs, return `false` to force a full rebuild (which re-partitions). Update
the map on every full `_render()`.

Because the live flag is `busy || idle`, ordinary `busy ↔ idle` turns do **not**
flip it, so the incremental fast-path is preserved for normal work; a full
rebuild happens only on genuine start/stop transitions (rare).

## Out of scope

- No backend changes. The sort is purely presentational and recomputed each
  drawer render (which already happens on the SSE status events that mutate
  `status`).
- The top session-tabs bar (a flat per-session list, not grouped by project)
  is unchanged.

## Testing

`_partitionGroupsLiveFirst(groups, getStatus)` is deliberately
dependency-light (its only input is the Map and a status accessor), so it is
the unit-testable seam if a test is wanted: feed synthetic group Maps and
assert live-first ordering with within-tier order preserved.

End-to-end, `app.js` has no existing unit-test harness around `SessionDrawer`,
so verify by running the dev server with a mix of busy / idle / stopped
projects and confirming: (a) live projects float above dormant ones, (b)
within-tier order is preserved, (c) the order updates when a session is
started/stopped, (d) it does **not** reshuffle on ordinary busy↔idle turns,
and (e) swipe navigation order matches the visible order.
