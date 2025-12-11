import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import { v2 as cloudinary } from "cloudinary";
import multer from "multer";
import { CloudinaryStorage } from "multer-storage-cloudinary";

dotenv.config();

// Konfigurasi Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const app = express();
app.use(cors());
app.use(express.json());

// Konfigurasi Multer dengan Cloudinary Storage
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: "taiso_chat",
    allowed_formats: ["jpg", "jpeg", "png", "gif", "pdf", "doc", "docx", "mp4", "mov", "avi"],
    resource_type: "auto",
  },
});

const upload = multer({ storage });

// MongoDB Schema untuk Chat
const chatSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  userName: { type: String, required: true },
  message: { type: String, required: true },
  fileUrl: { type: String },
  fileName: { type: String },
  fileType: { type: String },
  fileSize: { type: Number },
  timestamp: { type: Date, default: Date.now },
  isUser: { type: Boolean, default: true },
  read: { type: Boolean, default: false }
});

const Chat = mongoose.model("Chat", chatSchema);

// User Schema
const userSchema = new mongoose.Schema({
  uid: { type: String, required: true, unique: true },
  nama: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  nim: { type: String, required: true },
  prodi: { type: String, required: true },
  role: { type: String, default: "user" },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model("User", userSchema);

async function connectMongo() {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 5000
    });

    console.log("✅ MongoDB Connected!");

    mongoose.connection.on("disconnected", () => {
      console.log("❌ MongoDB Lost Connection! Reconnecting...");
      connectMongo();
    });

    mongoose.connection.on("error", (err) => {
      console.log("⚠️ MongoDB Error:", err);
    });

  } catch (err) {
    console.log("❌ MongoDB Connect Failed, retrying in 3s...");
    setTimeout(connectMongo, 2006);
  }
}

// Test route untuk Cloudinary
app.get("/test-cloudinary", async (req, res) => {
  try {
    const result = await cloudinary.api.ping();
    res.json({
      success: true,
      message: "✅Cloudinary connected successfully!",
      cloudinary: result
    });
  } catch (error) {
    console.error("❌ Cloudinary connection error:", error);
    res.status(500).json({
      success: false,
      message: "❌ Cloudinary connection failed",
      error: error.message
    });
  }
});

// Upload endpoint dengan Multer
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No file uploaded"
      });
    }

    // Dapatkan URL dari Cloudinary
    const fileUrl = req.file.path;
    
    res.json({
      success: true,
      message: "File uploaded successfully",
      url: fileUrl,
      fileName: req.file.originalname,
      fileType: req.file.mimetype,
      fileSize: req.file.size
    });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({
      success: false,
      message: "Upload failed",
      error: error.message
    });
  }
});

// API untuk menyimpan chat
app.post("/api/chat", async (req, res) => {
  try {
    const { userId, userName, message, fileUrl, fileName, fileType, fileSize, isUser } = req.body;
    
    const newChat = new Chat({
      userId,
      userName,
      message,
      fileUrl,
      fileName,
      fileType,
      fileSize,
      isUser: isUser || true,
      read: false
    });

    await newChat.save();
    
    res.json({
      success: true,
      message: "Chat saved successfully",
      chat: newChat
    });
  } catch (error) {
    console.error("Chat save error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to save chat",
      error: error.message
    });
  }
});

// API untuk mendapatkan chat berdasarkan user
app.get("/api/chat/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const chats = await Chat.find({ userId }).sort({ timestamp: 1 });
    
    res.json({
      success: true,
      chats
    });
  } catch (error) {
    console.error("Get chat error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to get chats",
      error: error.message
    });
  }
});

// API untuk user registration (backup)
app.post("/api/register", async (req, res) => {
  try {
    const { uid, nama, email, nim, prodi } = req.body;
    
    // Cek apakah user sudah ada
    const existingUser = await User.findOne({ $or: [{ email }, { nim }] });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: "User already exists"
      });
    }
    
    const newUser = new User({
      uid,
      nama,
      email,
      nim,
      prodi,
      role: "user"
    });

    await newUser.save();
    
    // Buat chat welcome
    const welcomeChat = new Chat({
      userId: uid,
      userName: "Admin",
      message: `Halo ${nama}! Selamat datang di TAISOTALK! 👋\n\nSaya Admin, siap membantu Anda dalam forum diskusi ini.`,
      isUser: false,
      read: false
    });

    await welcomeChat.save();
    
    res.json({
      success: true,
      message: "User registered successfully",
      user: newUser
    });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({
      success: false,
      message: "Registration failed",
      error: error.message
    });
  }
});

// API untuk check user login
app.get("/api/user/:uid", async (req, res) => {
  try {
    const { uid } = req.params;
    const user = await User.findOne({ uid });
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }
    
    res.json({
      success: true,
      user
    });
  } catch (error) {
    console.error("Get user error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to get user",
      error: error.message
    });
  }
});

app.get("/", (req, res) => {
  res.send("Server berjalan & MongoDB terkoneksi! Cloudinary siap digunakan.");
});

const PORT = process.env.PORT || 2006;

app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
  console.log("✅ Cloudinary configured with cloud_name:", process.env.CLOUDINARY_CLOUD_NAME);
  connectMongo();
});