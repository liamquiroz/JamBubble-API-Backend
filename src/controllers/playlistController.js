// src/controllers/playlistController.js
import mongoose from "mongoose";
import Playlist from "../models/Playlist.js";
import Music from "../models/Music.js";

//Helpers
function toClient(p, me) {
  const doc = p.toObject({ virtuals: true });
  const myId = me ? String(me) : null;

  doc.isMember = !!(myId && Array.isArray(doc.members) && doc.members.some(u => String(u) === myId));
  doc.memberCount = Array.isArray(doc.members) ? doc.members.length : 0;
  doc.trackCount = Array.isArray(doc.tracks) ? doc.tracks.length : 0;

  return doc;
}

function isOwner(playlist, userId) {
  return String(playlist.admin) === String(userId);
}

function notFound(res, msg = "Playlist not found") {
  return res.status(404).json({ message: msg });
}

function badRequest(res, msg) {
  return res.status(422).json({ message: msg });
}

//Create a new playlist
export async function createPlaylist(req, res) {
  try {
    const admin = req.user?.id;
    if (!admin) return res.status(401).json({ message: "Unauthorized" });

    const { playlistTitle, playlistDescription, playlistImage } = req.body || {};
    if (!playlistTitle || typeof playlistTitle !== "string" || playlistTitle.trim().length < 3) {
      return badRequest(res, "playlistTitle is required (min 3 chars)");
    }

    const playlist = await Playlist.create({
      playlistTitle: playlistTitle.trim(),
      playlistDescription: typeof playlistDescription === "string" ? playlistDescription.trim() : "",
      playlistImage: typeof playlistImage === "string" ? playlistImage.trim() : undefined,
      admin,
      members: [],
      tracks: [],
    });

    return res.status(200).json({
      message: "Playlist created",
      playlist: toClient(playlist, admin),
    });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({ message: "You already have a playlist with this title" });
    }
    return res.status(500).json({ message: "Failed to create playlist", error: String(err) });
  }
}

export async function getPlaylist(req, res) {
  try {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) return notFound(res);

    const playlist = await Playlist.findById(id)
      .populate([
        { path: "admin", select: "_id fName lName profilePic" },   // unchanged
        { path: "members", select: "_id" },                        // unchanged
        {
          // only the fields you asked for from Music
          path: "tracks.musicId",
          select: "_id title artist album fileUrl artworkUrl duration",
        },
      ]);

    if (!playlist) return notFound(res);

    const base = toClient(playlist, req.user?.id); // keeps isMember, counts, etc. :contentReference[oaicite:3]{index=3}

    // Map each track to the minimal shape
    const tracks = (playlist.tracks || []).map(t => ({
      trackId: t.musicId?._id ?? null,
      title: t.musicId?.title ?? null,
      artist: t.musicId?.artist ?? null,
      album: t.musicId?.album ?? null,
      fileUrl: t.musicId?.fileUrl ?? null,
      artworkUrl: t.musicId?.artworkUrl ?? null,
      duration: typeof t.musicId?.duration === "number" ? t.musicId.duration : null,
    }));

    return res.status(200).json({
      playlist: {
        ...base,          // title, description, image, admin, members, etc.
        tracks,           // minimal fields only
      },
    });
  } catch (err) {
    return res.status(500).json({ message: "Failed to get playlist", error: String(err) });
  }
}

export async function listPlaylists(req, res) {
  try {
    const me = req.user?.id;
    const { mine, admin: adminOnly, search, page = 1, limit = 20, sort = "new" } = req.query;

    const q = {};

    if (adminOnly === "true" && me) {
      q.admin = me;
    } else if (mine === "true" && me) {
      q.$or = [{ admin: me }, { members: me }];
    }

    if (search && typeof search === "string" && search.trim()) {
      const term = search.trim();
      const searchCond = {
        $or: [
          { playlistTitle: { $regex: term, $options: "i" } },
          { playlistDescription: { $regex: term, $options: "i" } },
        ],
      };

      if (Object.keys(q).length > 0) {
        q.$and = [q, searchCond];
        delete q.$or;
      } else {
        Object.assign(q, searchCond);
      }
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);

    let sortSpec = { createdAt: -1 };
    if (sort === "popular") sortSpec = { likesCount: -1, createdAt: -1 };
    if (sort === "new") sortSpec = { createdAt: -1 };

    const [items, total] = await Promise.all([
      Playlist.find(q)
        .sort(sortSpec)
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .select("-tracks")
        .lean({ virtuals: true }),
      Playlist.countDocuments(q),
    ]);

    const result = (items || []).map((p) => toClient({ toObject: () => p }, me));

    return res.status(200).json({
      items: result,
      page: pageNum,
      limit: limitNum,
      total,
      hasMore: pageNum * limitNum < total,
    });
  } catch (err) {
    return res.status(500).json({
      message: "Failed to list playlists",
      error: String(err),
    });
  }
}


export async function updatePlaylist(req, res) {
  try {
    const me = req.user?.id;
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) return notFound(res);

    const playlist = await Playlist.findById(id);
    if (!playlist) return notFound(res);
    if (!isOwner(playlist, me)) return res.status(403).json({ message: "Forbidden" });

    const { playlistTitle, playlistDescription, playlistImage } = req.body || {};

    if (typeof playlistTitle === "string" && playlistTitle.trim().length >= 3) {
      playlist.playlistTitle = playlistTitle.trim();
    }
    if (typeof playlistDescription === "string") {
      playlist.playlistDescription = playlistDescription.trim();
    }
    if (typeof playlistImage === "string") {
      playlist.playlistImage = playlistImage.trim();
    }

    await playlist.save();

    return res.status(200).json({
      message: "Playlist updated",
      playlist: toClient(playlist, me),
    });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({ message: "You already have a playlist with this title" });
    }
    return res.status(500).json({ message: "Failed to update playlist", error: String(err) });
  }
}


export async function deletePlaylist(req, res) {
  try {
    const me = req.user?.id;
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) return notFound(res);

    const playlist = await Playlist.findById(id);
    if (!playlist) return notFound(res);
    if (!isOwner(playlist, me)) return res.status(403).json({ message: "Forbidden" });

    await Playlist.deleteOne({ _id: id });

    return res.status(200).json({ message: "Playlist deleted" });
  } catch (err) {
    return res.status(500).json({ message: "Failed to delete playlist", error: String(err) });
  }
}

export async function joinPlaylist(req, res) {
  try {
    const me = req.user?.id;
    const id = req.params.id;
    if (!me) return res.status(401).json({ message: "Unauthorized" });
    if (!mongoose.isValidObjectId(id)) return notFound(res);

    const playlist = await Playlist.findById(id);
    if (!playlist) return notFound(res);

    const already = playlist.members.some(u => String(u) === String(me));
    if (!already) {
      playlist.members.push(me);
      await playlist.save();
    }

    return res.status(200).json({
      message: "Joined playlist",
      playlist: toClient(playlist, me),
    });
  } catch (err) {
    return res.status(500).json({ message: "Failed to join playlist", error: String(err) });
  }
}

export async function leavePlaylist(req, res) {
  try {
    const me = req.user?.id;
    const id = req.params.id;
    if (!me) return res.status(401).json({ message: "Unauthorized" });
    if (!mongoose.isValidObjectId(id)) return notFound(res);

    const playlist = await Playlist.findById(id);
    if (!playlist) return notFound(res);

    playlist.members = (playlist.members || []).filter(u => String(u) !== String(me));
    await playlist.save();

    return res.status(200).json({
      message: "Left playlist",
      playlist: toClient(playlist, me),
    });
  } catch (err) {
    return res.status(500).json({ message: "Failed to leave playlist", error: String(err) });
  }
}


export async function addTrack(req, res) {
  try {
    const me = req.user?.id;
    const id = req.params.id;
    const { trackId } = req.body || {};

    if (!mongoose.isValidObjectId(id)) return notFound(res);
    if (!mongoose.isValidObjectId(trackId)) return badRequest(res, "Valid trackId is required");

    const playlist = await Playlist.findById(id);
    if (!playlist) return notFound(res);
    if (String(playlist.admin) !== String(me)) return res.status(403).json({ message: "Forbidden" });

    // ensure the Music doc exists
    const music = await Music.findById(trackId).select("_id").lean();
    if (!music) return notFound(res, "Track not found in Music");

    // prevent duplicates (optional but recommended)
    const exists = (playlist.tracks || []).some(t => String(t.musicId) === String(trackId));
    if (exists) return badRequest(res, "Track already in playlist");

    playlist.tracks.push({
      musicId: trackId,
      addedBy: me,
      addedAt: new Date(),
    });

    await playlist.save();

    const created = playlist.tracks[playlist.tracks.length - 1];

    return res.status(200).json({
      message: "Track added",
      track: created, // {_id, musicId, addedBy, addedAt}
      playlistId: playlist._id,
    });
  } catch (err) {
    return res.status(500).json({ message: "Failed to add track", error: String(err) });
  }
}


export async function updateTrack(req, res) {
  try {
    const me = req.user?.id;
    const { id, trackId } = req.params;
    if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(trackId)) return notFound(res);

    const playlist = await Playlist.findById(id);
    if (!playlist) return notFound(res);
    if (!isOwner(playlist, me)) return res.status(403).json({ message: "Forbidden" });

    const track = playlist.tracks.id(trackId);
    if (!track) return notFound(res, "Track not found");

    const { title, artwork, trackUrl } = req.body || {};
    if (typeof title === "string") track.title = title.trim();
    if (typeof artwork === "string") track.artwork = artwork.trim();
    if (typeof trackUrl === "string") track.trackUrl = trackUrl.trim();

    await playlist.save();

    return res.status(200).json({
      message: "Track updated",
      track,
      playlistId: playlist._id,
    });
  } catch (err) {
    return res.status(500).json({ message: "Failed to update track", error: String(err) });
  }
}


export async function removeTrack(req, res) {
  try {
    const me = req.user?.id;
    const { id, trackId } = req.params;
    if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(trackId)) {
      return notFound(res);
    }

    const playlist = await Playlist.findById(id);
    if (!playlist) return notFound(res);
    if (String(playlist.admin) !== String(me)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    // 1) Try by subdocument _id (the old way / UI drag handles, etc.)
    let track = playlist.tracks.id(trackId);

    // 2) If not found, try by musicId (Music._id)
    if (!track) {
      const idx = (playlist.tracks || []).findIndex(t => String(t.musicId) === String(trackId));
      if (idx === -1) return notFound(res, "Track not found");
      // Remove by index using the subdoc _id we do have
      const subdocId = playlist.tracks[idx]._id;
      playlist.tracks.id(subdocId).deleteOne();
    } else {
      track.deleteOne();
    }

    await playlist.save();

    return res.status(200).json({ message: "Track removed", playlistId: playlist._id });
  } catch (err) {
    return res.status(500).json({ message: "Failed to remove track", error: String(err) });
  }
}



export async function reorderTracks(req, res) {
  try {
    const me = req.user?.id;
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) return notFound(res);

    const playlist = await Playlist.findById(id);
    if (!playlist) return notFound(res);
    if (!isOwner(playlist, me)) return res.status(403).json({ message: "Forbidden" });

    const { order } = req.body || {};
    if (!Array.isArray(order) || order.length !== playlist.tracks.length) {
      return badRequest(res, "order must be an array with all trackIds in desired order");
    }

    const map = new Map(playlist.tracks.map(t => [String(t._id), t]));
    const next = [];

    for (const tid of order) {
      const t = map.get(String(tid));
      if (!t) return badRequest(res, "order contains invalid trackId");
      next.push(t);
    }

    playlist.tracks = next;
    await playlist.save();

    return res.status(200).json({ message: "Tracks reordered", playlistId: playlist._id });
  } catch (err) {
    return res.status(500).json({ message: "Failed to reorder tracks", error: String(err) });
  }
}
