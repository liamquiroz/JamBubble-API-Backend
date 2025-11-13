// src/routes/userRoutes.js
import express from 'express';
import multer from 'multer';
import { protect } from '../middlewares/authMiddleware.js';
import { 
    uploadProfilePic, 
    getUserProfile, 
    updateUserProfile, 
    deleteMyAccount, 
    fcmToken,
    startUpdateContact, //Email Mobile Update
    verifyUpdateContact, // verify Email Mobie Update
} from '../controllers/userController.js';

const router = express.Router();
const upload = multer({ dest: 'temp/' });

router.post('/upload-profile-pic', protect, upload.single('file'), uploadProfilePic);
router.get('/profile', protect, getUserProfile);
router.patch('/update-profile', protect, updateUserProfile);

//Delete User Account and Data
router.delete('/account', protect, deleteMyAccount);

//FCM Token
router.post('/devices/fcmtoken', protect, fcmToken);

//Email phone Update
router.patch('/contact', protect, startUpdateContact);
router.patch('/contact/verify', protect, verifyUpdateContact);

export default router;