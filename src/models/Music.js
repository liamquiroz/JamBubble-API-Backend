import mongoose from "mongoose";

const musicSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },
    title: {
        type: String,
        required: true,
        trim: true,
    },
    artist: {
        type: String,
        default: '',
    },
    album: {
        type: String,
        default: '',
    },
    genre: {
        type: String,
        default: '',
    },
    fileUrl: {
        type: String,
        required: true,
    },
    publicId: {
        type: String,
        required: false,
    },
    artworkUrl: {
        type: String,
        required: false,
    },
    artworkPublicId: {
        type: String,
        required: false,
    },
    uploadedAt: {
        type: Date,
        default: Date.now,
    },
    duration: {
        type: Number,
        default: 0
    },
    isPublic: {
        type: Boolean,
        default: false,
    },
}, { timestamps: true} );

musicSchema.index({ userId: 1, createdAt: -1});

export default mongoose.model('Music', musicSchema);