import User from '../models/User.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { log, error } from '../utils/logger.js';
import {
  startSmsVerification,
  startEmailVerification,
  checkSmsThenEmail,
} from '../utils/twilioVerify.js';
import { sendOtpMail, sendWelcomeMail } from '../utils/sendMail.js';

//ForgotPass Token
import { randomBytes } from 'crypto';
import ResetTicket from '../models/ResetTicket.js';

//Google Apple Auth
import { OAuth2Client } from "google-auth-library";
import { jwtVerify, createRemoteJWKSet  } from "jose";

//google Apple Auth
const googleClient = new OAuth2Client(process.env.GOOGLE_WEB_CLIENT_ID);
const APPLE_ISS = "https://appleid.apple.com";
const AppleJWKS = createRemoteJWKSet (new URL("https://appleid.apple.com/auth/keys"));
const signAccessToken = (user) =>
  jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "15m" });


//for forgot password ticket
const TICKET_TTL_MIN = Number(process.env.RESET_TICKET_TTL_MINUTES);
const ABS_WINDOW_MIN = Number(process.env.RESET_ABSOLUTE_WINDOW_MINUTES);

// Token helper
const signToken = (user) =>
  jwt.sign({ id: user._id, email: user.email }, process.env.JWT_SECRET);


//SIGNUP send OTP to sms
export const signupUser = async (req, res) => {
  const { fName, lName, mobileNo, email, password } = req.body;

  try {
    if (!fName || !lName || !mobileNo || !email || !password) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    const byEmail = await User.findOne({ email });
    if (byEmail && byEmail.isVerified) {
      return res.status(409).json({ message: 'Email already registered' });
    }
    const byMobile = await User.findOne({ mobileNo });
    if (byMobile && byMobile.isVerified) {
      return res.status(409).json({ message: 'Mobile already registered' });
    }

    const hash = await bcrypt.hash(password, 10);

    let user = byEmail || byMobile;
    if (!user) {
      user = await User.create({
        fName, lName, mobileNo, email,
        password: hash,
        isVerified: false,
        devices: [],
      });
    } else {
      user.fName = fName;
      user.lName = lName;
      user.mobileNo = mobileNo;
      user.email = email;
      user.password = hash;
      user.isVerified = false;
      await user.save();
    }

    await startSmsVerification(mobileNo);
    return res.status(200).json({ message: 'OTP sent to mobile number' });
  } catch (err) {
    error('Signup start error', err);
    return res.status(500).json({ message: 'Something went wrong' });
  }
};

// send OTP to email on signup
export const sendSignupEmailOtp = async (req, res) => {
  const { mobileNo } = req.body;
  try {
    if (!mobileNo) return res.status(400).json({ message: 'mobileNo is required' });

    const user = await User.findOne({ mobileNo });
    if (!user) return res.status(404).json({ message: 'User not found' });

    await startEmailVerification(user.email);
    return res.status(200).json({ message: 'OTP sent to email' });
  } catch (err) {
    error('Signup email OTP error', err);
    return res.status(500).json({ message: 'Something went wrong' });
  }
};

// Verify signup OTP with sms or email
export const verifySignupOtp = async (req, res) => {
  const { mobileNo, code, deviceId } = req.body;

  try {
    if (!mobileNo || !code) {
      return res.status(400).json({ message: 'mobileNo and code are required' });
    }

    const user = await User.findOne({ mobileNo });
    if (!user) return res.status(404).json({ message: 'User not found' });

    const { ok } = await checkSmsThenEmail({ mobileNo, email: user.email, code });
    if (!ok) return res.status(400).json({ message: 'Invalid or expired OTP' });

    user.isVerified = true;

    if (deviceId) {
      const existing = user.devices?.find((d) => d.deviceId === deviceId);
      if (existing) existing.loginTime = new Date();
      else user.devices.push({ deviceId, loginTime: new Date() });
    }

    await user.save();

    
    sendWelcomeMail(user.email, { fName: user.fName, lName: user.lName }).catch(() => {});

    const token = signToken(user);
    return res.status(200).json({
      message: 'Signup Successful',
      token,
      user: { id: user._id, profileId: user.profileId },
    });
  } catch (err) {
    error('Verify signup OTP error', err);
    return res.status(500).json({ message: 'Something went wrong' });
  }
};

// LOGIN with Password
export const loginUser = async (req, res) => {
  const { mobileNo, password, deviceId } = req.body;

  try {
    if (!mobileNo || !password)
      return res.status(400).json({ message: 'mobileNo and password are required' });

    // must include +password
    const user = await User.findOne({ mobileNo }).select('+password');
    if (!user || !user.isVerified)
      return res.status(401).json({ message: 'User not found or not verified' });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ message: 'Invalid credentials' });

    const existing = user.devices?.find((d) => d.deviceId === deviceId);
    if (existing) existing.loginTime = new Date();
    else if (deviceId) user.devices.push({ deviceId, loginTime: new Date() });
    await user.save();

    const token = signToken(user);
    return res.status(200).json({ message: 'Login Successful', token, user: { id: user._id } });
  } catch (err) {
    error('Password login error', err);
    return res.status(500).json({ message: 'Something went wrong' });
  }
};


//LOGIN with sms otp
export const loginOtpStart = async (req, res) => {
  const { mobileNo } = req.body;
  try {
    if (!mobileNo) return res.status(400).json({ message: 'mobileNo is required' });

    const user = await User.findOne({ mobileNo });
    if (!user || !user.isVerified) {
      return res.status(404).json({ message: 'User not found or not verified' });
    }

    await startSmsVerification(mobileNo);
    return res.status(200).json({ message: 'OTP sent to mobile number' });
  } catch (err) {
    error('loginOtpStart error', err);
    return res.status(500).json({ message: 'Something went wrong' });
  }
};

export const loginOtpStartEmail = async (req, res) => {
  const { mobileNo } = req.body;
  try {
    if (!mobileNo) return res.status(400).json({ message: 'mobileNo is required' });

    const user = await User.findOne({ mobileNo });
    if (!user || !user.isVerified) {
      return res.status(404).json({ message: 'User not found or not verified' });
    }

    await startEmailVerification(user.email);
    return res.status(200).json({ message: 'OTP sent to email' });
  } catch (err) {
    error('loginOtpStartEmail error', err);
    return res.status(500).json({ message: 'Something went wrong' });
  }
};

//Verify Login sms otp
export const loginOtpVerify = async (req, res) => {
  const { mobileNo, code, deviceId } = req.body;
  try {
    if (!mobileNo || !code) {
      return res.status(400).json({ message: 'mobileNo and code are required' });
    }

    const user = await User.findOne({ mobileNo });
    if (!user || !user.isVerified) {
      return res.status(404).json({ message: 'User not found or not verified' });
    }

    const { ok } = await checkSmsThenEmail({ mobileNo, email: user.email, code });
    if (!ok) return res.status(400).json({ message: 'Invalid or expired OTP' });

    const existing = user.devices?.find((d) => d.deviceId === deviceId);
    if (existing) existing.loginTime = new Date();
    else if (deviceId) user.devices.push({ deviceId, loginTime: new Date() });

    await user.save();

    const token = signToken(user);
    return res.status(200).json({ message: 'Login Successful', token, user: { id: user._id } });
  } catch (err) {
    error('loginOtpVerify error', err);
    return res.status(500).json({ message: 'Something went wrong' });
  }
};

//FORGOT Password sends otp to sms
// export const forgotPassword = async (req, res) => {
//   const { mobileNo } = req.body;
//   try {
//     if (!mobileNo) return res.status(400).json({ message: 'mobileNo is required' });

//     const user = await User.findOne({ mobileNo });
//     if (!user || !user.isVerified) {
//       return res.status(404).json({ message: 'User not found or not verified' });
//     }

//     await startSmsVerification(mobileNo);
//     return res.status(200).json({ message: 'OTP sent to mobile number' });
//   } catch (err) {
//     error('forgotPassword error', err);
//     return res.status(500).json({ message: 'Something went wrong' });
//   }
// };

//FORGOT Password send otp to Email
// export const forgotPasswordEmail = async (req, res) => {
//   const { mobileNo } = req.body;
//   try {
//     if (!mobileNo) return res.status(400).json({ message: 'mobileNo is required' });

//     const user = await User.findOne({ mobileNo });
//     if (!user || !user.isVerified) {
//       return res.status(404).json({ message: 'User not found or not verified' });
//     }

//     await startEmailVerification(user.email);
//     return res.status(200).json({ message: 'OTP sent to email' });
//   } catch (err) {
//     error('forgotPasswordEmail error', err);
//     return res.status(500).json({ message: 'Something went wrong' });
//   }
// };

//FORGOT Password Verify with sms or Email 
// export const verifyResetOtp = async (req, res) => {
//   const { mobileNo, otp } = req.body;
//   try {
//     if (!mobileNo || !otp) {
//       return res.status(400).json({ message: 'mobileNo and otp required' });
//     }

//     const user = await User.findOne({ mobileNo });
//     if (!user || !user.isVerified) {
//       return res.status(404).json({ message: 'User not found or not verified' });
//     }

//     const { ok } = await checkSmsThenEmail({ mobileNo, email: user.email, code: otp });
//     if (!ok) return res.status(400).json({ message: 'Invalid or expired OTP' });

//     return res.status(200).json({ message: 'Otp Verified' });
//   } catch (err) {
//     error('verifyResetOtp error', err);
//     return res.status(500).json({ message: 'Something went wrong' });
//   }
// };

// export const resetPassword = async (req, res) => {
//   const { mobileNo, otp, password } = req.body;
//   try {
//     if (!mobileNo || !otp || !password) {
//       return res.status(400).json({ message: 'mobileNo, otp and password required' });
//     }

//     const user = await User.findOne({ mobileNo });
//     if (!user) return res.status(404).json({ message: 'User not found' });

//     const { ok } = await checkSmsThenEmail({ mobileNo, email: user.email, code: otp });
//     if (!ok) return res.status(400).json({ message: 'Invalid or expired OTP' });

//     user.password = await bcrypt.hash(password, 10);
//     await user.save();

//     return res.status(200).json({ message: 'Password reset successful' });
//   } catch (err) {
//     error('resetPassword error', err);
//     return res.status(500).json({ message: 'Something went wrong' });
//   }
// };

//helpers forgot password
function secondsUntil(date) {
  const ms = new Date(date).getTime() - Date.now();
  return Math.max(0, Math.floor(ms / 1000));
}

async function findActiveResetTicket(userId) {
  return ResetTicket.findOne({
    userId,
    purpose: 'reset_password',
    used: false,
    expiresAt: { $gt: new Date() },
  });
}

// Issue ticket
async function issueFirstResetTicket(userId) {
  
  await ResetTicket.deleteMany({ userId, purpose: 'reset_password' });

  const jti = randomBytes(32).toString('hex');
  const rootExpiresAt = new Date(Date.now() + ABS_WINDOW_MIN * 60 * 1000);
  const perRotationExpiry = new Date(Date.now() + TICKET_TTL_MIN * 60 * 1000);
  const expiresAt = new Date(Math.min(perRotationExpiry.getTime(), rootExpiresAt.getTime()));

  const doc = await ResetTicket.create({
    jti,
    userId,
    purpose: 'reset_password',
    expiresAt,
    rootExpiresAt,
  });

  return { resetTicket: doc.jti, expiresIn: secondsUntil(doc.expiresAt) };
}

//invalidate current & issue fresh ticket
async function rotateResetTicket(userId, rootExpiresAt) {
  await ResetTicket.deleteMany({ userId, purpose: 'reset_password' });

  const jti = randomBytes(32).toString('hex');
  const perRotationExpiry = new Date(Date.now() + TICKET_TTL_MIN * 60 * 1000);
  const expiresAt = new Date(Math.min(perRotationExpiry.getTime(), new Date(rootExpiresAt).getTime()));

  const doc = await ResetTicket.create({
    jti,
    userId,
    purpose: 'reset_password',
    expiresAt,
    rootExpiresAt,
  });

  return { resetTicket: doc.jti, expiresIn: secondsUntil(doc.expiresAt) };
}



//Forgot Password send SMS
export const forgotPassword = async (req, res) => {
  const { mobileNo } = req.body;
  try {
    if (!mobileNo) return res.status(400).json({ message: 'mobileNo is required' });

    const user = await User.findOne({ mobileNo });
    if (!user || !user.isVerified) {
      return res.status(404).json({ message: 'User not found or not verified' });
    }

    
    await ResetTicket.deleteMany({ userId: user._id, purpose: 'reset_password' });

    
    await startSmsVerification(mobileNo);

    return res.status(200).json({ message: 'OTP sent to mobile number' });
  } catch (err) {
    error('forgotPassword error', err);
    return res.status(500).json({ message: 'Something went wrong' });
  }
};

//Forgot Password send Email
export const forgotPasswordEmail = async (req, res) => {
  const { mobileNo } = req.body;
  try {
    if (!mobileNo) return res.status(400).json({ message: 'mobileNo is required' });

    const user = await User.findOne({ mobileNo });
    if (!user || !user.isVerified) {
      return res.status(404).json({ message: 'User not found or not verified' });
    }

    
    await ResetTicket.deleteMany({ userId: user._id, purpose: 'reset_password' });

   
    await startEmailVerification(user.email);

    return res.status(200).json({ message: 'OTP sent to email' });
  } catch (err) {
    error('forgotPasswordEmail error', err);
    return res.status(500).json({ message: 'Something went wrong' });
  }
};

//Verify ForgotPassword OTP
export const verifyResetOtp = async (req, res) => {
  const { mobileNo, otp } = req.body;
  try {
    if (!mobileNo || !otp) {
      return res.status(400).json({ message: 'mobileNo and otp required' });
    }

    const user = await User.findOne({ mobileNo });
    if (!user || !user.isVerified) {
      return res.status(404).json({ message: 'User not found or not verified' });
    }

    const existing = await findActiveResetTicket(user._id);
    if (existing) {
      const payload = await rotateResetTicket(user._id, existing.rootExpiresAt);
      return res.status(200).json(payload);
    }

    const { ok } = await checkSmsThenEmail({
      mobileNo,
      email: user.email,
      code: otp,
    });
    if (!ok) return res.status(400).json({ message: 'Invalid or expired OTP' });

    const payload = await issueFirstResetTicket(user._id);
    return res.status(200).json(payload);
  } catch (err) {
    error('verifyResetOtp (rotate) error', err);
    return res.status(500).json({ message: 'Something went wrong' });
  }
};

//Reset password using the reset ticket
export const resetPassword = async (req, res) => {
  const { resetTicket, password } = req.body;
  try {
    if (!resetTicket || !password) {
      return res.status(400).json({ message: 'resetTicket and password required' });
    }

    const ticket = await ResetTicket.findOne({ jti: resetTicket });
    if (!ticket) return res.status(400).json({ message: 'Invalid reset ticket' });
    if (ticket.used) return res.status(400).json({ message: 'Reset ticket already used' });
    if (ticket.expiresAt.getTime() <= Date.now()) {
      return res.status(400).json({ message: 'Reset ticket expired' });
    }

    const user = await User.findById(ticket.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    user.password = await bcrypt.hash(password, 10);
    await user.save();

    ticket.used = true;
    await ticket.save();
    await ResetTicket.deleteMany({
      userId: user._id,
      purpose: 'reset_password',
      used: false,
      _id: { $ne: ticket._id },
    });

    return res.status(200).json({ message: 'Password reset successful' });
  } catch (err) {
    error('resetPassword (ticket) error', err);
    return res.status(500).json({ message: 'Something went wrong' });
  }
};

// Checkers EMAIL MOBILE Existence
export const checkEmailExists = async (req, res) => {
  const { email, type } = req.body;

  if (!email || !type) {
    return res.status(400).json({ message: 'email and type required' });
  }

  try {
    const user = await User.findOne({ email });
    if (type === 'signup') {
      if (user && user.isVerified) {
        return res.status(409).json({ message: 'Email is already Registered' });
      }
      return res.status(200).json({ message: 'Email is Available for Signup' });
    }
    if (type === 'forgot-password') {
      if (!user || !user.isVerified) {
        return res.status(400).json({ message: 'Email Not Registered' });
      }
      return res.status(200).json({ message: 'Email valid for password reset' });
    }
    return res.status(400).json({ message: 'Invalid type' });
  } catch {
    return res.status(500).json({ message: 'Server error' });
  }
};


export const checkMobileExists = async (req, res) => {
  const { mobileNo, type } = req.body;

  if (!mobileNo || !type) {
    return res.status(400).json({ message: 'mobileNo and type required' });
  }

  try {
    const user = await User.findOne({ mobileNo });
    if (type === 'signup') {
      if (user && user.isVerified) {
        return res.status(409).json({ message: 'Mobile is already Registered' });
      }
      return res.status(200).json({ message: 'Mobile is Available for Signup' });
    }
    if (type === 'forgot-password') {
      if (!user || !user.isVerified) {
        return res.status(400).json({ message: 'Mobile Not Registered' });
      }
      return res.status(200).json({ message: 'Mobile valid for password reset' });
    }
    return res.status(400).json({ message: 'Invalid type' });
  } catch {
    return res.status(500).json({ message: 'Server error' });
  }
};


//google Apple Auth
export const authGoogle = async (req, res) => {
  try {
    const { idToken, deviceId } = req.body;
    if (!idToken) return res.status(400).json({ message: "Missing idToken" });

    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_WEB_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload) return res.status(401).json({ message: "Invalid Google token" });

    const provider = "google";
    const providerUserId = payload.sub;
    const verifiedEmail = payload.email_verified ? payload.email : undefined;

    // 1) Find by provider identity
    let user = await User.findByProvider(provider, providerUserId);

    // 2) If not found and we have a verified email, link to existing account by email
    if (!user && verifiedEmail) {
      user = await User.findOne({ email: verifiedEmail });
      if (user) {
        await user.linkProvider({ provider, providerUserId, emailAtSignIn: verifiedEmail });
      }
    }

    // 3) If still not found, create new user
    if (!user) {
      user = await User.create({
        email: verifiedEmail || undefined,
        fName: payload.given_name || "",
        lName: payload.family_name || "",
        isVerified: true,
        providerIdentities: [{ provider, providerUserId, emailAtSignIn: verifiedEmail }],
        devices: deviceId ? [{ deviceId }] : [],
      });
    }

    user.lastLoginAt = new Date();
    await user.save();

    const token = signAccessToken(user);

    return res.json({
      message: "Login Successful",
      token,
      user: { id: user._id, profileId: user.profileId },
    });
  } catch (err) {
    return res.status(500).json({ message: "Something went wrong" });
  }
};

export const authApple = async (req, res) => {
  try {
    const { identityToken, rawNonce, deviceId } = req.body;
    if (!identityToken || !rawNonce) {
      return res.status(400).json({ message: "Missing identityToken or nonce" });
    }

    // Verify Apple identity token (audience must be your iOS bundle id)
    const { payload } = await jwtVerify(identityToken, AppleJWKS, {
      issuer: APPLE_ISS,
      audience: process.env.APPLE_BUNDLE_ID,
    });

    // Verify the nonce: token contains SHA-256(nonce)
    const crypto = await import("crypto");
    const expected = crypto.createHash("sha256").update(rawNonce).digest("hex");
    if (payload.nonce !== expected) {
      return res.status(401).json({ message: "Nonce mismatch" });
    }

    const provider = "apple";
    const providerUserId = String(payload.sub);
    const verifiedEmail =
      payload.email_verified === "true" || payload.email_verified === true
        ? payload.email
        : undefined;

    // 1) Find by provider identity
    let user = await User.findByProvider(provider, providerUserId);

    // 2) If not found and verified email exists, link to existing account
    if (!user && verifiedEmail) {
      user = await User.findOne({ email: verifiedEmail });
      if (user) {
        await user.linkProvider({ provider, providerUserId, emailAtSignIn: verifiedEmail });
      }
    }

    // 3) If still not found, create new user (Apple may hide email; that's fine)
    if (!user) {
      user = await User.create({
        email: verifiedEmail || undefined,
        isVerified: true,
        providerIdentities: [{ provider, providerUserId, emailAtSignIn: verifiedEmail }],
        devices: deviceId ? [{ deviceId }] : [],
      });
    }

    user.lastLoginAt = new Date();
    await user.save();

    const token = signAccessToken(user);

    return res.json({
      message: "Login Successful",
      token,
      user: { id: user._id, profileId: user.profileId },
    });
  } catch (err) {
    return res.status(500).json({ message: "Something went wrong" });
  }
};
