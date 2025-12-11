import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import { v2 as cloudinary } from "cloudinary";
import { createServer } from "http";
import { Server } from "socket.io";

dotenv.config();

// Konfigurasi Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*", // Ganti dengan origin yang sesuai untuk produksi
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Koneksi MongoDB
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

// Model untuk pesan (jika ingin menyimpan di MongoDB)
const messageSchema = new mongoose.Schema({
  senderId: String,
  receiverId: String,
  message: String,
  fileUrl: String,
  fileName: String,
  fileType: String,
  timestamp: { type: Date, default: Date.now }
});

const Message = mongoose.model('Message', messageSchema);

// Socket.io connection
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // Bergabung ke room berdasarkan userId
  socket.on('join-room', (userId) => {
    socket.join(userId);
    console.log(`User ${userId} joined room`);
  });

  // Mengirim pesan
  socket.on('send-message', async (data) => {
    const { senderId, receiverId, message, fileUrl, fileName, fileType } = data;

    // Simpan pesan ke MongoDB (opsional)
    const newMessage = new Message({
      senderId,
      receiverId,
      message,
      fileUrl,
      fileName,
      fileType
    });

    await newMessage.save();

    // Kirim pesan ke receiver
    io.to(receiverId).emit('receive-message', newMessage);
    // Juga kirim kembali ke sender untuk konfirmasi (jika diperlukan)
    io.to(senderId).emit('message-sent', newMessage);
  });

  // Mendapatkan riwayat pesan
  socket.on('get-messages', async ({ userId, otherUserId }) => {
    const messages = await Message.find({
      $or: [
        { senderId: userId, receiverId: otherUserId },
        { senderId: otherUserId, receiverId: userId }
      ]
    }).sort({ timestamp: 1 });

    socket.emit('load-messages', messages);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

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

// Upload endpoint untuk file
app.post("/upload", async (req, res) => {
  try {
    const { file, fileName, fileType } = req.body;

    if (!file) {
      return res.status(400).json({ error: "No file provided" });
    }

    // Upload ke Cloudinary
    const uploadResponse = await cloudinary.uploader.upload(file, {
      resource_type: "auto",
      public_id: `taiso_chat/${Date.now()}_${fileName}`
    });

    res.json({
      success: true,
      fileUrl: uploadResponse.secure_url,
      publicId: uploadResponse.public_id
    });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/", (req, res) => {
  res.send("Server berjalan & MongoDB terkoneksi! Cloudinary siap digunakan.");
});

const PORT = process.env.PORT || 2006;

httpServer.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
  console.log("✅  Cloudinary configured with cloud_name:", process.env.CLOUDINARY_CLOUD_NAME);
  connectMongo();
});