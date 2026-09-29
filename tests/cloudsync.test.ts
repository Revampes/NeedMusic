/**
 * Unit tests for the deterministic cross-device merge (`mergeDeviceFiles`).
 *
 * Run with:  npm run test:sync
 * (Node's built-in test runner + native TypeScript type stripping — no deps.)
 *
 * `cloudsync.ts` is a pure module with no imports, which is why it can be
 * exercised directly from Node.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  mergeDeviceFiles,
  isTombstoneExpired,
  songKeyOf,
  wantsAudioInDrive,
  unionAudioRequests,
  resolveAudioId,
  reconcileAudioUrl,
  TOMBSTONE_TTL_DAYS,
  type DeviceSyncFile,
  type SyncTrackMeta,
} from "../src/core/services/cloudsync.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-06-01T00:00:00.000Z");

const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function track(songKey: string, extra: Partial<SyncTrackMeta> = {}): SyncTrackMeta {
  return {
    songKey,
    title: songKey.split("|")[1] ?? songKey,
    artist: songKey.split("|")[0] ?? "artist",
    album: "album",
    durationSecs: 180,
    isFavorite: false,
    ...extra,
  };
}

/** A minimal, valid device file. */
function file(over: Partial<DeviceSyncFile> = {}): DeviceSyncFile {
  return {
    deviceId: "desk-A",
    updatedAt: iso(0),
    version: 3,
    tracks: [],
    favorites: [],
    playlists: [],
    ...over,
  };
}

test("metadata syncs even when no device uploaded audio (Layer 1 vs Layer 2)", () => {
  // The old v2 merge dropped any track without a driveFileId entirely.
  const merged = mergeDeviceFiles(
    [file({ tracks: [track("a|song|album|180")] })],
    NOW,
  );
  assert.equal(merged.tracks.length, 1);
  assert.equal(merged.tracks[0].songKey, "a|song|album|180");
  assert.equal(merged.tracks[0].driveFileId, undefined);
});

test("an audio reference from one device survives another device's metadata write", () => {
  const older = file({
    deviceId: "desk-A",
    updatedAt: iso(2 * DAY),
    tracks: [track("k1", { driveFileId: "F1", audioUploadedAt: iso(2 * DAY) })],
  });
  const newer = file({
    deviceId: "phone-B",
    updatedAt: iso(1 * DAY), // newer writer, but no audio of its own
    tracks: [track("k1", { title: "Renamed" })],
  });

  const merged = mergeDeviceFiles([older, newer], NOW);
  assert.equal(merged.tracks.length, 1);
  assert.equal(merged.tracks[0].title, "Renamed", "newest metadata wins");
  assert.equal(merged.tracks[0].driveFileId, "F1", "audio ref is carried over");
});

test("tombstone removes the song on every device", () => {
  const merged = mergeDeviceFiles(
    [
      file({ deviceId: "A", tracks: [track("k1", { addedAt: iso(5 * DAY) })] }),
      file({
        deviceId: "B",
        tombstones: [{ songKey: "k1", deletedAt: iso(1 * DAY), deviceId: "B" }],
      }),
    ],
    NOW,
  );
  assert.deepEqual(merged.tracks, []);
  assert.deepEqual(merged.deletedTracks, ["k1"]);
});

test("re-importing a song after deleting it resurrects it (addedAt > deletedAt)", () => {
  const merged = mergeDeviceFiles(
    [
      file({ deviceId: "A", tracks: [track("k1", { addedAt: iso(1 * DAY) })] }),
      file({
        deviceId: "B",
        tombstones: [{ songKey: "k1", deletedAt: iso(5 * DAY), deviceId: "B" }],
      }),
    ],
    NOW,
  );
  assert.equal(merged.tracks.length, 1, "re-added song survives the older tombstone");
  assert.deepEqual(merged.deletedTracks, []);
});

test("a song merely listed before its deletion does NOT resurrect", () => {
  const merged = mergeDeviceFiles(
    [
      // Added long before the deletion — an offline device's stale snapshot.
      file({ deviceId: "A", tracks: [track("k1", { addedAt: iso(10 * DAY) })] }),
      file({
        deviceId: "B",
        tombstones: [{ songKey: "k1", deletedAt: iso(1 * DAY), deviceId: "B" }],
      }),
    ],
    NOW,
  );
  assert.deepEqual(merged.tracks, [], "deletion wins over a stale listing");
  assert.deepEqual(merged.deletedTracks, ["k1"]);
});

test("legacy v2 entries (no addedAt) fall back to the 'owns audio' rule", () => {
  const tomb = { songKey: "k1", deletedAt: iso(1 * DAY), deviceId: "B" };
  // No addedAt + no audio → deletion wins.
  const withoutAudio = mergeDeviceFiles(
    [
      file({ tracks: [{ ...track("k1"), addedAt: undefined }] }),
      file({ deviceId: "B", tombstones: [tomb] }),
    ],
    NOW,
  );
  assert.deepEqual(withoutAudio.tracks, []);

  // No addedAt but the device still owns the audio → resurrected (v2 behaviour).
  const withAudio = mergeDeviceFiles(
    [
      file({ tracks: [{ ...track("k1"), addedAt: undefined, driveFileId: "F9" }] }),
      file({ deviceId: "B", tombstones: [tomb] }),
    ],
    NOW,
  );
  assert.equal(withAudio.tracks.length, 1);
});

test("v2 files (deletedTracks list, no tombstones) still delete", () => {
  const legacy: any = {
    deviceId: "legacy",
    updatedAt: iso(1 * DAY),
    tracks: [],
    deletedTracks: ["k1"],
    favorites: [],
    playlists: [],
  };
  const merged = mergeDeviceFiles([legacy], NOW);
  assert.deepEqual(merged.deletedTracks, ["k1"]);
  // The legacy list becomes a timestamped tombstone.
  assert.equal(merged.tombstones.length, 1);
  assert.equal(merged.tombstones[0].deletedAt, legacy.updatedAt);
});

test("tombstones are GC'd after the TTL window", () => {
  const fresh = mergeDeviceFiles(
    [
      file({
        tombstones: [
          { songKey: "recent", deletedAt: iso(TOMBSTONE_TTL_DAYS * DAY - DAY), deviceId: "A" },
        ],
      }),
    ],
    NOW,
  );
  assert.equal(fresh.tombstones.length, 1, "inside the window → kept");
  assert.equal(isTombstoneExpired(fresh.tombstones[0], NOW), false);

  const old = mergeDeviceFiles(
    [
      file({
        tombstones: [
          { songKey: "ancient", deletedAt: iso(TOMBSTONE_TTL_DAYS * DAY + DAY), deviceId: "A" },
        ],
      }),
    ],
    NOW,
  );
  assert.deepEqual(old.tombstones, [], "past the window → collected");
  assert.equal(
    isTombstoneExpired({ songKey: "ancient", deletedAt: iso(TOMBSTONE_TTL_DAYS * DAY + DAY), deviceId: "A" }, NOW),
    true,
  );
});

test("favourites are last-writer-wins per song (un-favourite propagates)", () => {
  const merged = mergeDeviceFiles(
    [
      file({ deviceId: "A", favorites: [{ songKey: "k1", fav: true, ts: iso(2 * DAY) }] }),
      file({ deviceId: "B", favorites: [{ songKey: "k1", fav: false, ts: iso(1 * DAY) }] }),
    ],
    NOW,
  );
  assert.equal(merged.favorites.get("k1"), false, "newer un-favourite wins");
});

test("ratings are last-writer-wins per song", () => {
  const merged = mergeDeviceFiles(
    [
      file({ deviceId: "A", ratings: [{ songKey: "k1", stars: 5, ts: iso(3 * DAY) }] }),
      file({ deviceId: "B", ratings: [{ songKey: "k1", stars: 2, ts: iso(1 * DAY) }] }),
    ],
    NOW,
  );
  assert.equal(merged.ratings.get("k1"), 2, "newer rating wins");
});

test("resume positions are last-writer-wins per song", () => {
  const merged = mergeDeviceFiles(
    [
      file({ deviceId: "A", positions: [{ songKey: "k1", secs: 30, ts: iso(2 * DAY) }] }),
      file({ deviceId: "B", positions: [{ songKey: "k1", secs: 91.5, ts: iso(1 * DAY) }] }),
    ],
    NOW,
  );
  assert.equal(merged.positions.get("k1"), 91.5);
});

test("play counters sum across devices without double counting", () => {
  const merged = mergeDeviceFiles(
    [
      file({
        deviceId: "A",
        playStats: [{ date: "2026-05-31", count: 3, seconds: 540 }],
      }),
      file({
        deviceId: "B",
        playStats: [
          { date: "2026-05-31", count: 2, seconds: 300 },
          { date: "2026-05-30", count: 1, seconds: 120 },
        ],
      }),
      // A device that pushed the same day twice must only be counted once.
      file({
        deviceId: "A",
        playStats: [{ date: "2026-05-31", count: 3, seconds: 540 }],
      }),
    ],
    NOW,
  );
  assert.deepEqual(merged.playStats.get("2026-05-31"), { count: 5, seconds: 840 });
  assert.deepEqual(merged.playStats.get("2026-05-30"), { count: 1, seconds: 120 });
});

test("audio requests union across devices", () => {
  const merged = mergeDeviceFiles(
    [
      file({ deviceId: "A", audioRequests: ["k1", "k2"] }),
      file({ deviceId: "B", audioRequests: ["k2", "k3"] }),
    ],
    NOW,
  );
  assert.deepEqual(merged.audioRequests, ["k1", "k2", "k3"]);
});

test("audio mode is LWW; defaults to 'selected' with no data", () => {
  assert.equal(mergeDeviceFiles([], NOW).audioMode, "selected");

  const merged = mergeDeviceFiles(
    [
      file({ deviceId: "A", audioMode: "all", audioModeTs: iso(5 * DAY) }),
      file({ deviceId: "B", audioMode: "none", audioModeTs: iso(1 * DAY) }),
    ],
    NOW,
  );
  assert.equal(merged.audioMode, "none", "newest mode setting wins");
});

test("playlists are last-writer-wins per id", () => {
  const merged = mergeDeviceFiles(
    [
      file({
        deviceId: "A",
        playlists: [{ id: "p1", name: "Mix", trackKeys: ["k1"], ts: iso(2 * DAY) }],
      }),
      file({
        deviceId: "B",
        playlists: [{ id: "p1", name: "Mix", trackKeys: ["k1", "k2"], ts: iso(1 * DAY) }],
      }),
    ],
    NOW,
  );
  assert.equal(merged.playlists.length, 1);
  assert.deepEqual(merged.playlists[0].trackKeys, ["k1", "k2"]);
});

test("merge is deterministic regardless of input order", () => {
  const a = file({ deviceId: "A", tracks: [track("k1", { addedAt: iso(2 * DAY) })] });
  const b = file({
    deviceId: "B",
    tracks: [track("k2", { addedAt: iso(2 * DAY) })],
    favorites: [{ songKey: "k2", fav: true, ts: iso(1 * DAY) }],
  });
  assert.deepEqual(mergeDeviceFiles([a, b], NOW), mergeDeviceFiles([b, a], NOW));
});

test("songKeyOf normalizes case, whitespace and separators", () => {
  // Case-insensitive; runs of whitespace / - _ . ' / collapse to a single space;
  // duration is rounded.
  assert.equal(
    songKeyOf({ title: "Hey-Jude", artist: "The  Beatles", album: "1", durationSecs: 431.6 }),
    songKeyOf({ title: "hey jude", artist: "the beatles", album: "1", durationSecs: 432 }),
  );
  // Both keys must be identical strings, and stable across calls.
  assert.equal(
    songKeyOf({ title: "A.B", artist: "X", album: "Y", durationSecs: 10 }),
    songKeyOf({ title: "a_b", artist: "x", album: "y", durationSecs: 10 }),
  );
});

/* ─── Layer-2 (audio) gating ────────────────────────────────────────────────
 * Regression tests for the "tracks sync but cannot be downloaded" bug: the
 * upload/download decision must honour requests made on ANY device, not just
 * the device making the decision.
 * ------------------------------------------------------------------------ */

test("wantsAudioInDrive honours a request made on ANOTHER device (selected mode)", () => {
  const local = new Set<string>(); // this device asked for nothing
  const fromOtherDevices = new Set(["k1"]);
  assert.equal(
    wantsAudioInDrive("k1", "selected", local, fromOtherDevices),
    true,
    "the device holding the file must upload when another device asks",
  );
  assert.equal(wantsAudioInDrive("k2", "selected", local, fromOtherDevices), false);
});

test("wantsAudioInDrive: 'all' uploads everything, 'none' uploads nothing", () => {
  assert.equal(wantsAudioInDrive("k1", "all"), true);
  assert.equal(wantsAudioInDrive("k1", "none", ["k1"], ["k1"]), false, "'none' wins over requests");
});

test("unionAudioRequests merges local marks with merged device requests", () => {
  const u = unionAudioRequests(["a", "b"], new Set(["b", "c"]), []);
  assert.deepEqual([...u].sort(), ["a", "b", "c"]);
});

test("a metadata-only track gains its audio reference once a device uploads it", () => {  // The phone's own file lists the song WITHOUT audio; the computer's file has
  // the same song WITH audio. The merge must surface the audio so the phone can
  // download it (previously a row that already existed locally never regained
  // its audio reference, so downloads were permanently impossible).
  const phone = file({
    deviceId: "phone",
    updatedAt: iso(1 * DAY),
    tracks: [track("k1")], // no driveFileId
  });
  const computer = file({
    deviceId: "desk",
    updatedAt: iso(2 * DAY), // older writer
    tracks: [track("k1", { driveFileId: "F1", audioUploadedAt: iso(2 * DAY) })],
  });

  const merged = mergeDeviceFiles([phone, computer], NOW);
  assert.equal(merged.tracks.length, 1);
  assert.equal(
    merged.tracks[0].driveFileId,
    "F1",
    "audio reference must be visible to every device",
  );
});

/* ─── Stale Drive audio ids ─────────────────────────────────────────────────
 * Regression tests for "File not found: <id>" on the phone after another device
 * ran "Clean everything" (which wipes the whole Drive app folder): the owning
 * device must stop republishing ids that are gone, and must not re-check them
 * on every sync cycle.
 * ------------------------------------------------------------------------ */

test("resolveAudioId trusts a previously verified id without re-checking", async () => {
  const cache = { verified: new Set(["F1"]), dead: new Set<string>() };
  let calls = 0;
  const id = await resolveAudioId("F1", async () => { calls++; return true; }, cache);
  assert.equal(id, "F1");
  assert.equal(calls, 0, "a verified id must not cost another request");
});

test("resolveAudioId forgets a dead id and caches that verdict", async () => {
  const cache = { verified: new Set<string>(), dead: new Set<string>() };
  let calls = 0;
  const verify = async () => { calls++; return false; };

  assert.equal(await resolveAudioId("DEAD", verify, cache), undefined, "dead id must not be published");
  assert.deepEqual([...cache.dead], ["DEAD"]);
  // Second time: remembered as dead, so no second request.
  assert.equal(await resolveAudioId("DEAD", verify, cache), undefined);
  assert.equal(calls, 1, "a dead id must only be probed once per run");
});

test("resolveAudioId keeps a live id and passes through undefined", async () => {
  const cache = { verified: new Set<string>(), dead: new Set<string>() };
  assert.equal(await resolveAudioId("F9", async () => true, cache), "F9");
  assert.deepEqual([...cache.verified], ["F9"]);
  assert.equal(await resolveAudioId(undefined, async () => true, cache), undefined);
});

test("resolveAudioId keeps trusting an id when verification fails (transient error)", async () => {
  // A network/auth blip must NOT be read as "the file is gone", or every device
  // would re-upload its whole library.
  const cache = { verified: new Set<string>(), dead: new Set<string>() };
  const id = await resolveAudioId("F1", async () => { throw new Error("network"); }, cache);
  assert.equal(id, "F1");
  assert.equal(cache.dead.size, 0, "a transient failure must not mark the id dead");
});

test("a track whose audio id went dead loses its reference on merge", () => {  // After the owning device forgets the dead id it publishes the song with no
  // audio at all — so other devices show "reference only" instead of trying a
  // file that no longer exists.
  const before = mergeDeviceFiles(
    [file({ deviceId: "desk", tracks: [track("k1", { driveFileId: "DEAD" })] })],
    NOW,
  );
  assert.equal(before.tracks[0].driveFileId, "DEAD");

  const after = mergeDeviceFiles(
    [file({ deviceId: "desk", tracks: [track("k1")] })], // id forgotten
    NOW,
  );
  assert.equal(after.tracks.length, 1, "metadata still syncs");
  assert.equal(after.tracks[0].driveFileId, undefined, "no dead id handed to other devices");
});

/* ─── Adopting a re-uploaded audio id ───────────────────────────────────────
 * Regression tests for the phone continuing to fail with "File not found"
 * AFTER the desktop had already re-uploaded under a NEW id: the row must adopt
 * the new id instead of clinging to the old one.
 * ------------------------------------------------------------------------ */

test("reconcileAudioUrl adopts a NEW id when the owner re-uploaded", () => {
  assert.equal(
    reconcileAudioUrl("drive://OLD", "NEW"),
    "drive://NEW",
    "a replaced id must be picked up (this was the persistent File-not-found bug)",
  );
});

test("reconcileAudioUrl gives a source-less row its Drive audio", () => {
  assert.equal(reconcileAudioUrl("", "F1"), "drive://F1");
  assert.equal(reconcileAudioUrl(undefined, "F1"), "drive://F1");
});

test("reconcileAudioUrl drops the pointer when the cloud no longer has it", () => {
  assert.equal(reconcileAudioUrl("drive://OLD", undefined), "");
});

test("reconcileAudioUrl never overwrites a local (LAN / blob) source", () => {
  const lan = "http://192.168.1.10:17963/audio/track_abc?token=t";
  assert.equal(reconcileAudioUrl(lan, "F1"), null, "LAN stays preferred over Drive");
  assert.equal(reconcileAudioUrl(lan, undefined), null);
  assert.equal(reconcileAudioUrl("blob:http://x/abc", "F1"), null);
  assert.equal(reconcileAudioUrl("data:audio/mpeg;base64,AAA", "F1"), null);
});

test("reconcileAudioUrl is a no-op when nothing changed", () => {
  assert.equal(reconcileAudioUrl("drive://F1", "F1"), null);
  assert.equal(reconcileAudioUrl("", undefined), null);
});
