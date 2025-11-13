import mongoose from "mongoose";
import { uploadImageFile } from "../utils/uploadServices/cloudinaryUploader.js";
import { v2 as cloudinary } from "cloudinary";
import bcrypt from "bcryptjs";
import User from "../models/User.js";
import Music from "../models/Music.js";
import Group from "../models/Group.js";
import { error, log } from "../utils/logger.js";

//twilio
import {
  startSmsVerification,
  startEmailVerification,
  checkVerificationForTo,
} from '../utils/twilioVerify.js';
import { sendFromTemplate } from '../utils/sendMail.js';

//helpers
const toClient = (u) => ({
  _id: u._id,
  fName: u.fName,
  lName: u.lName,
  email: u.email,
  mobileNo: u.mobileNo,
  profileId: u.profileId,
  profilePic: u.profilePic,         
  latitude: u.latitude,
  longitude: u.longitude,
  updatedAt: u.updatedAt,            
});

//validation
const emailRe = /^\S+@\S+\.\S+$/;
const e164 = /^\+\d{6,15}$/;

const etagFor = (u) =>
  `"user:${u._id}:${new Date(u.updatedAt || Date.now()).getTime()}"`;

//helper for cloud bulk delete
const _chunk = (arr, size = 100) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

//Upload profile picture
export const uploadProfilePic = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No Image uploaded." });

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    // remove old image
    if (user.profilePicPublicId) {
      try {
        await cloudinary.uploader.destroy(user.profilePicPublicId, { resource_type: "image" });
      } catch (_) {}
    }

    // upload new image
    const { url, publicId } = await uploadImageFile(req.file);
    user.profilePic = url;
    user.profilePicPublicId = publicId;
    await user.save();

    const payload = toClient(user);
    res
      .status(200)
      .set("ETag", etagFor(user))
      .set("Last-Modified", new Date(user.updatedAt).toUTCString())
      .json({ message: "Profile picture updated", user: payload });
  } catch (err) {
    res.status(500).json({ message: "Upload failed", error: err.message });
  }
};

//Get user full profile
export const getUserProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .select("fName lName email mobileNo profileId profilePic latitude longitude updatedAt");

    if (!user) return res.status(404).json({ message: "User Not Found" });

    const etag = etagFor(user);
    const lastMod = new Date(user.updatedAt).toUTCString();

    // Conditional GET
    const inm = req.headers["if-none-match"];
    const ims = req.headers["if-modified-since"];
    if ((inm && inm === etag) || (ims && new Date(ims) >= new Date(user.updatedAt))) {
      return res.status(304).set("ETag", etag).set("Last-Modified", lastMod).end();
    }

    res
      .status(200)
      .set("ETag", etag)
      .set("Last-Modified", lastMod)
      .json({ user: toClient(user) });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch profile", error: err.message });
  }
};

//Update profile
export const updateUserProfile = async (req, res) => {
  try {
    const { fName, lName, latitude, longitude, newPassword, profilePic } = req.body;
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User Not Found" });

    if (typeof fName === "string") user.fName = fName;
    if (typeof lName === "string") user.lName = lName;

    if (latitude !== undefined) user.latitude = latitude;
    if (longitude !== undefined) user.longitude = longitude;

    if (typeof profilePic === "string" && profilePic.trim() !== "") {
      user.profilePic = profilePic.trim();
    }

    
    if (newPassword) {
      user.password = await bcrypt.hash(newPassword, 10);
    }

    await user.save();

    const payload = toClient(user);

    res
      .status(200)
      .set("ETag", etagFor(user))
      .set("Last-Modified", new Date(user.updatedAt).toUTCString())
      .json({ message: "Profile Updated", user: payload });
  } catch (err) {
    res.status(500).json({ message: "Profile Update Failed", error: err.message });
  }
};

//Delete User from DB + Cloud File also
export const deleteMyAccount = async (req, res) => {
  const userId = req.user?.id || req.user?._id;
  if (!userId) return res.status(401).json({ message: "Unauthorized" });

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const user = await User.findById(userId).session(session);
    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({ message: "User Not Found"});
    }

    const tracks = await Music.find({ userId }, "publicId").session(session);
    const trackPublicIds = tracks.map(t => t.publicId).filter(Boolean);

    const adminGroup = await Group.find(
      {"members.user.ref": userId, "members.user.isAdmin": true}, "members groupImagePublicId"
    ).session(session);

    const soleAdminGroupIds = [];
    const soleAdminGroupImagePublicIds = [];

    for (const g of adminGroup) {
      const admins = (g.members || []).filter(m => m?.user?.isAdmin === true);
      const isOnlyAdmin = admins.length === 1 && String(admins[0]?.user?.ref) === String(userId);
      if (isOnlyAdmin) {
        soleAdminGroupIds.push(g._id);
        if (g.groupImagePublicId) {
          soleAdminGroupImagePublicIds.push(g.groupImagePublicId);
        }
      }
    }

    const cloud = {
      tracksDeleted: 0,
      tracksFailed: 0,
      profilePicDeleted: false,
      groupImagesDeleted: 0,
      groupImagesFailed: 0,
    };

    for (const batch of _chunk(trackPublicIds, 100)) {
      try {
        const resp = await cloudinary.api.delete_resources(batch, {
          resource_type: "video",
        });
        const deletedCount = Object.values(resp?.deleted || {}).filter(v => v === "deleted").length;
        cloud.tracksDeleted += deletedCount;
        cloud.tracksFailed += batch.length - deletedCount;

      } catch {
        cloud.tracksFailed += batch.length;
      }
    }

    if (user.profilePicPublicId) {
      try {
        const resp = await cloudinary.uploader.destroy(user.profilePicPublicId, {
          resource_type: "image",
        });
        cloud.profilePicDeleted = resp?.result === "ok";
      } catch {
        cloud.profilePicDeleted = false;
      }
    }

    for (const pid of soleAdminGroupImagePublicIds) {
      try {
        const resp = await cloudinary.uploader.destroy(pid, {resource_type: "image"});
        if (resp?.result === "ok") cloud.groupImagesDeleted += 1;
        else cloud.groupImagesFailed += 1;
      } catch {
        cloud.groupImagesFailed += 1;
      }
    }

    const musicDelRes = await Music.deleteMany({ userId}).session(session);

    let groupsDeleted = 0;
    if (soleAdminGroupIds.length) {
      const grpDelRes = await Group.deleteMany({ _id: { $in: soleAdminGroupIds } }).session(session);
      groupsDeleted = grpDelRes.deletedCount || 0;
    }

    const pullRes = await Group.updateMany(
      {"members.user.ref": userId},
      {
        $pull: {
          "members": { "user.ref": userId },
          "queue.item": { addedBy: userId },
        },
      }
    ).session(session);

    await Group.updateMany(
      {"playback.updatedBy": userId },
      {$set: {"playback.updatedBy": null}}
    ).session(session);

    await User.deleteOne({ _id: userId }).session(session);

    await session.commitTransaction();
    session.endSession();

    return res.status(200).json({
      ok: true,
      db: {
        musicDeleted: musicDelRes.deletedCount || 0,
        groupsDeleted,
        leftGroupsMatched: pullRes.matchedCount || 0,
        leftGroupModified: pullRes.modifiedCount || 0,
      },
      cloud,
      message: "Account and associated assets deleted.",
    });

  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    error("delete Error", err);
    return res.status(500).json({
      ok: false,
      message: "Failed to delete account.",
    });
  }
};

export const fcmToken = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id;
    const { deviceId, fcmToken } = req.body || {};

    if (!userId) return res.status(401).json({ message: "Unauthorized"});
    if (!deviceId || !fcmToken) {
      return res.status(400).json({ message: "deviceId and fcmToken are required" });
    }

    const updateExisting = await User.updateOne(
      { _id: userId, "devices.deviceId": deviceId},
      {
        $set: {
          "devices.$.fcmToken": fcmToken
        },
      }
    );

    if(updateExisting.matchedCount > 0) {
      return res.status(200).json({
        ok: true,
        updated: true,
        created: false,
        deviceId,
        message: 'fcm Token updated',
      });
    }

    const pushNew = await User.updateOne(
      {_id: userId},
      {
        $push:{
          devices: {
            deviceId,
            fcmToken,
          },
        },
      }
    );

    return res.status(200).json({
      ok: true,
      updated: false,
      created : pushNew.modifiedCount > 0,
      deviceId,
      message: "Fcm Token Registred",
    });
  } catch (err) {
    error("Fcm Token error", err);
    return res.status(500).json({
      ok: false,
      message: "Faild to registor fcm Token",
    });
  }
};

//Update Contact
export const startUpdateContact = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    let { email, mobileNo } = req.body || {};
    email = typeof email === 'string' ? email.trim().toLowerCase() : undefined;
    mobileNo = typeof mobileNo === 'string' ? mobileNo.trim() : undefined;

    if (!email && !mobileNo) {
      return res.status(400).json({ message: 'Provide at least one of: email, mobileNo' });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User Not Found' });

    // Validate + uniqueness (ignore self)
    const toSend = [];

    if (email) {
      if (!emailRe.test(email)) {
        return res.status(400).json({ message: 'Invalid email format' });
      }
      if (email !== user.email) {
        const exists = await User.findOne({ email, _id: { $ne: userId } }).lean();
        if (exists) return res.status(409).json({ message: 'Email already in use' });
        toSend.push('email');
      }
    }

    if (mobileNo) {
      if (!e164.test(mobileNo)) {
        return res.status(400).json({ message: 'Invalid mobile number format. Use E.164 like +919876543210' });
      }
      if (mobileNo !== user.mobileNo) {
        const exists = await User.findOne({ mobileNo, _id: { $ne: userId } }).lean();
        if (exists) return res.status(409).json({ message: 'Mobile number already in use' });
        toSend.push('mobile');
      }
    }

    // Nothing to change
    if (toSend.length === 0) {
      return res.status(200).json({ message: 'No changes', sent: [] });
    }

    // Send via Twilio Verify (mirrors signup/login/reset flows)
    const tasks = [];
    if (toSend.includes('email')) tasks.push(startEmailVerification(email));
    if (toSend.includes('mobile')) tasks.push(startSmsVerification(mobileNo));
    await Promise.all(tasks);

    return res.status(200).json({
      message: 'OTP sent',
      sent: toSend,              // e.g., ["email","mobile"]
      hint: 'Submit codes to /api/user/contact/verify',
    });
  } catch (err) {
    error('startUpdateContact error', err);
    return res.status(500).json({ message: 'Failed to start contact update' });
  }
};

/**
 * PHASE 2: Verify OTP(s) and apply update atomically
 * - Body can include:
 *   { email?, emailCode?, mobileNo?, mobileCode? }
 *   Provide a code for each field you intend to change.
 */
export const verifyUpdateContact = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    let { email, emailCode, mobileNo, mobileCode } = req.body || {};
    email = typeof email === 'string' ? email.trim().toLowerCase() : undefined;
    mobileNo = typeof mobileNo === 'string' ? mobileNo.trim() : undefined;

    if (!email && !mobileNo) {
      return res.status(400).json({ message: 'Provide at least one of: email, mobileNo' });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User Not Found' });

    // Determine which changes are actually requested
    const wantsEmailUpdate = Boolean(email && email !== user.email);
    const wantsMobileUpdate = Boolean(mobileNo && mobileNo !== user.mobileNo);

    if (!wantsEmailUpdate && !wantsMobileUpdate) {
      return res.status(200).json({ message: 'No changes', updated: [] });
    }

    // Validate formats + uniqueness (same as Phase 1)
    if (wantsEmailUpdate) {
      if (!emailRe.test(email)) return res.status(400).json({ message: 'Invalid email format' });
      const exists = await User.findOne({ email, _id: { $ne: userId } }).lean();
      if (exists) return res.status(409).json({ message: 'Email already in use' });
    }
    if (wantsMobileUpdate) {
      if (!e164.test(mobileNo)) {
        return res.status(400).json({ message: 'Invalid mobile number format. Use E.164 like +919876543210' });
      }
      const exists = await User.findOne({ mobileNo, _id: { $ne: userId } }).lean();
      if (exists) return res.status(409).json({ message: 'Mobile number already in use' });
    }

    // Require OTP codes for each requested change
    if (wantsEmailUpdate && !emailCode) {
      return res.status(400).json({ message: 'emailCode is required to update email' });
    }
    if (wantsMobileUpdate && !mobileCode) {
      return res.status(400).json({ message: 'mobileCode is required to update mobileNo' });
    }

    // Verify via Twilio Verify for each target (same util used in login/reset flows)
    if (wantsEmailUpdate) {
      const v = await checkVerificationForTo(email, String(emailCode).trim());
      if (!v) return res.status(400).json({ message: 'Invalid or expired email OTP' });
    }
    if (wantsMobileUpdate) {
      const v = await checkVerificationForTo(mobileNo, String(mobileCode).trim());
      if (!v) return res.status(400).json({ message: 'Invalid or expired mobile OTP' });
    }

    // Apply updates atomically
    if (wantsEmailUpdate) user.email = email;
    if (wantsMobileUpdate) user.mobileNo = mobileNo;
    await user.save();

    // OPTIONAL: notify via SendGrid (align with your reset success template style)
    try {
      await sendFromTemplate?.(
        'generic', // if you have a template key; otherwise add one like 'contactChanged'
        user.email || email,
        {
          subject: 'Contact info updated',
          name: [user.fName, user.lName].filter(Boolean).join(' ') || undefined,
        }
      );
    } catch (_) { /* non-blocking */ }

    return res.status(200).json({
      message: 'Contact info updated',
      updated: [
        ...(wantsEmailUpdate ? ['email'] : []),
        ...(wantsMobileUpdate ? ['mobile'] : []),
      ],
      user: {
        _id: user._id,
        fName: user.fName,
        lName: user.lName,
        email: user.email,
        mobileNo: user.mobileNo,
        profilePic: user.profilePic,
        updatedAt: user.updatedAt,
      },
    });
  } catch (err) {
    // Handle unique index race
    if (err && err.code === 11000) {
      const field = Object.keys(err.keyPattern || {})[0] || 'field';
      return res.status(409).json({ message: `${field} already in use` });
    }
    error('verifyUpdateContact error', err);
    return res.status(500).json({ message: 'Failed to verify and update contact info' });
  }
};
