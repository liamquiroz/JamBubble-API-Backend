// src/models/User.js
import mongoose from "mongoose";
import crypto from "crypto";

const deviceSchema = new mongoose.Schema(
  {
    deviceId: { 
      type: String, 
      required: true 
    },
    fcmToken: { 
      type: String 
    },
    loginTime: { 
      type: Date, 
      default: Date.now 
    },
  },{ _id: false });

const providerIdentitySchema = new mongoose.Schema(
  {
    provider: { 
      type: String, 
      enum: ["google", "apple"], 
      required: true 
    },
    providerUserId: { 
      type: String, 
      required: true 
    }, 
    emailAtSignIn: { 
      type: String, 
      lowercase: true, 
      trim: true 
    },
    createdAt: { 
      type: Date, 
      default: Date.now 
    },
  },{ _id: false });

const refreshTokenSchema = new mongoose.Schema(
  {
    tokenHash: { 
      type: String, 
      required: true, 
      index: true 
    },
    deviceId: { 
      type: String 
    },
    createdAt: { 
      type: Date, 
      default: Date.now 
    },
    expiresAt: { 
      type: Date, 
      required: true 
    },
    revokedAt: { 
      type: Date 
    },
  },{ _id: false });

const userSchema = new mongoose.Schema(
  {
    fName: { 
      type: String, 
      trim: true 
    },
        lName: { 
      type: String, 
      trim: true 
    },

    mobileNo: { 
      type: String, 
      trim: true, 
      unique: true, 
      sparse: true 
    },

    email: {
      type: String,
      unique: true,
      sparse: true,
      lowercase: true,
      trim: true,
      index: true,
    },

    password: {
      type: String,
      select: false, 
    },

    profilePic: { 
      type: String 
    },
    profilePicPublicId: { 
      type: String 
    },

    latitude: { 
      type: Number 
    },
    longitude: { 
      type: Number 
    },

    profileId: {
      type: String,
      unique: true,
      default: function () {
        const rand = Math.floor(100000000 + Math.random() * 900000000);
        return "1" + String(rand);
      },
    },

    isVerified: { 
      type: Boolean, 
      default: false 
    },

    providerIdentities: { 
      type: [providerIdentitySchema], 
      default: [] 
    },

    devices: { 
      type: [deviceSchema], 
      default: [] 
    },

    refreshTokens: { 
      type: [refreshTokenSchema], 
      default: [] 
    },

    lastLoginAt: { type: Date },
  },{ timestamps: true });

userSchema.index(
  { "providerIdentities.provider": 1, "providerIdentities.providerUserId": 1 },
  { unique: true, sparse: true }
);

userSchema.methods.publicProfile = function () {
  return {
    id: this._id,
    fName: this.fName || "",
    lName: this.lName || "",
    email: this.email || null,
    profilePic: this.profilePic || null,
    profileId: this.profileId,
    isVerified: !!this.isVerified,
  };
};

userSchema.methods.linkProvider = async function ({
  provider,
  providerUserId,
  emailAtSignIn,
}) {
  const exists = this.providerIdentities?.some(
    (pi) => pi.provider === provider && pi.providerUserId === providerUserId
  );
  if (!exists) {
    this.providerIdentities.push({ provider, providerUserId, emailAtSignIn });
    await this.save();
  }
  return this;
};

userSchema.methods.issueRefreshToken = async function ({ ttlDays = 30, deviceId } = {}) {
  const raw = crypto.randomUUID();
  const tokenHash = crypto.createHash("sha256").update(raw).digest("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
  this.refreshTokens.push({ tokenHash, deviceId, createdAt: now, expiresAt });
  await this.save();
  return { raw, expiresAt };
};

userSchema.methods.rotateRefreshToken = async function (rawOld, { ttlDays = 30, deviceId } = {}) {
  const oldHash = crypto.createHash("sha256").update(rawOld).digest("hex");
  const token = this.refreshTokens.find((t) => t.tokenHash === oldHash && !t.revokedAt);
  if (token) token.revokedAt = new Date();
  return this.issueRefreshToken({ ttlDays, deviceId });
};

userSchema.statics.findByProvider = function (provider, providerUserId) {
  return this.findOne({
    providerIdentities: { $elemMatch: { provider, providerUserId } },
  });
};

userSchema.statics.findByActiveRefreshToken = async function (raw) {
  const tokenHash = crypto.createHash("sha256").update(raw).digest("hex");
  return this.findOne({
    refreshTokens: {
      $elemMatch: {
        tokenHash,
        revokedAt: { $exists: false },
        expiresAt: { $gt: new Date() },
      },
    },
  }).select("+refreshTokens");
};

export default mongoose.model("User", userSchema);
