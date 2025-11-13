import Music from "../models/Music.js";
import Playlist from "../models/Playlist.js";
import { v2 as cloudinary } from "cloudinary";

//upload track
export const uploadTrack = async (req, res) => {
  const {
    title,
    genre,
    album,
    artist,
    fileUrl,
    publicId,          
    artworkUrl,
    artworkPublicId,
    duration,
    isPublic         
  } = req.body;

  // Basic validations (no req.file now)
  if (!title) {
    return res.status(400).json({ message: "Track title is required" });
  }
  if (!fileUrl) {
    return res.status(400).json({ message: "fileUrl is required" });
  }

  // Normalize duration
  let parsedDuration = 0;
  if (duration !== undefined && duration !== null && duration !== "") {
    const d = typeof duration === "string" ? parseFloat(duration) : duration;
    if (!Number.isNaN(d) && Number.isFinite(d) && d >= 0) {
      parsedDuration = d;
    }
  }

  try {
    const track = await Music.create({
      userId: req.user.id,
      title: title.trim(),
      genre: genre ?? "",
      album: album ?? "",
      artist: artist ?? "",
      fileUrl,
      publicId,
      artworkUrl,
      artworkPublicId,
      duration: parsedDuration,
      isPublic: Boolean(isPublic),
      uploadedAt: new Date(),  
    });

    return res
      .status(200)
      .json({ message: "Track uploaded successfully", track });
  } catch (error) {
    const hint =
      error?.name === "ValidationError"
        ? { errors: Object.keys(error.errors || {}) }
        : undefined;

    return res
      .status(500)
      .json({ message: "Upload failed", ...(hint || {}) });
  }
};

//get All track uploaded by user
export const getMyTrack = async (req, res) => {
    try {
        const tracks = await Music.find({ userId: req.user.id }).sort({ createdAt: -1 });
        res.status(200).json({ tracks });
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch tracks'});
    }
};

//Delete Track
// export const deleteTrack = async (req, res) => {
//     try {
//         const track = await Music.findOne({ _id: req.params.id, userId: req.user.id });
//         if (!track) return res.status(404).json({ message: 'Track not found'});

//         //Delete from cloudinary
//         if (track.publicId) {
//             await cloudinary.uploader.destroy(track.publicId, { resource_type: "video"});
//         }

//         await track.deleteOne();
//         res.status(200).json({ message: 'Track Deleted Successfully'});
//     } catch (error) {
//         res.status(500).json({ message: 'Error Delete Track'});
//     }
// };


// Delete Track (also remove artwork from Cloudinary and purge from all playlists)
export const deleteTrack = async (req, res) => {
  try {
    const track = await Music.findOne({ _id: req.params.id, userId: req.user.id });
    if (!track) {
      return res.status(404).json({ message: "Track not found" });
    }

    // Remove references from all playlists first
    // Pull out any track entries whose musicId matches this track._id
    const playlistResult = await Playlist.updateMany(
      { "tracks.musicId": track._id },
      { $pull: { tracks: { musicId: track._id } } }
    );

    // Delete Cloudinary assets (audio/video + artwork) in parallel, but don't fail the whole op if one fails
    const destroyOps = [];
    if (track.publicId) {
      destroyOps.push(
        cloudinary.uploader.destroy(track.publicId, { resource_type: "video" })
      );
    }
    if (track.artworkPublicId) {
      destroyOps.push(
        cloudinary.uploader.destroy(track.artworkPublicId, { resource_type: "image" })
      );
    }
    await Promise.allSettled(destroyOps);

    // Finally delete the DB record
    await track.deleteOne();

    return res.status(200).json({
      message: "Track deleted successfully",
      removedFromPlaylists: playlistResult?.modifiedCount ?? playlistResult?.nModified ?? 0,
    });
  } catch (error) {
    return res.status(500).json({ message: "Error deleting track" });
  }
};