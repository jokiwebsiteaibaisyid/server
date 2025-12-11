import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import { v2 as cloudinary } from "cloudinary";
import multer from "multer";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";

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
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Konfigurasi Multer untuk upload file
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx|mp4|mov|avi/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (extname && mimetype) {
      return cb(null, true);
    } else {
      cb(new Error('Hanya file gambar, video, PDF, dan dokumen yang diperbolehkan'));
    }
  }
});

// Schema untuk Chat
const chatSchema = new mongoose.Schema({
  senderId: String,
  senderName: String,
  senderRole: String, // 'user', 'sub_admin', 'admin'
  receiverId: String,
  receiverName: String,
  receiverRole: String,
  message: String,
  fileUrl: String,
  fileName: String,
  fileType: String, // 'image', 'video', 'pdf', 'word', 'other'
  fileSize: Number,
  timestamp: { type: Date, default: Date.now },
  isRead: { type: Boolean, default: false },
  roomId: String // Tambahkan roomId untuk grouping chat
});

const Chat = mongoose.model('Chat', chatSchema);

// Schema untuk User Status
const userStatusSchema = new mongoose.Schema({
  userId: String,
  userName: String,
  userRole: String,
  isOnline: Boolean,
  lastSeen: Date,
  socketId: String,
  email: String // Tambahkan email untuk identifikasi
});

const UserStatus = mongoose.model('UserStatus', userStatusSchema);

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

// Helper function untuk membuat roomId unik
function generateRoomId(userId1, userId2) {
  const ids = [userId1, userId2].sort();
  return `room_${ids[0]}_${ids[1]}`;
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('🔗 New client connected:', socket.id);

  // User join room
  socket.on('join', async (userData) => {
    try {
      const { userId, userName, userRole, email } = userData;
      
      // Update atau buat user status
      await UserStatus.findOneAndUpdate(
        { userId },
        {
          userName,
          userRole,
          email,
          isOnline: true,
          lastSeen: new Date(),
          socketId: socket.id
        },
        { upsert: true, new: true }
      );

      // Join personal room
      socket.join(`user_${userId}`);
      
      // Join rooms berdasarkan role untuk broadcast
      if (userRole === 'user') {
        socket.join('users_group');
      } else if (userRole === 'sub_admin') {
        socket.join('sub_admins_group');
      } else if (userRole === 'admin') {
        socket.join('admins_group');
      }

      // Notify all users about online status
      io.emit('user_status', {
        userId,
        userName,
        userRole,
        email,
        isOnline: true
      });

      console.log(`👤 ${userName} (${userRole}) joined as ${socket.id}`);
    } catch (error) {
      console.error('Error joining user:', error);
    }
  });

  // Send message
  socket.on('send_message', async (messageData) => {
    try {
      const {
        senderId,
        senderName,
        senderRole,
        receiverId,
        receiverName,
        receiverRole,
        message,
        fileUrl,
        fileName,
        fileType,
        fileSize
      } = messageData;

      // Generate room ID untuk kedua pengguna
      const roomId = generateRoomId(senderId, receiverId);

      // Simpan ke database
      const chat = new Chat({
        senderId,
        senderName,
        senderRole,
        receiverId,
        receiverName,
        receiverRole,
        message,
        fileUrl,
        fileName,
        fileType,
        fileSize,
        roomId,
        timestamp: new Date()
      });

      await chat.save();

      // Kirim ke receiver personal room
      io.to(`user_${receiverId}`).emit('receive_message', {
        ...chat._doc,
        timestamp: chat.timestamp.toISOString()
      });

      // Kirim ke sender sebagai konfirmasi
      socket.emit('message_sent', {
        ...chat._doc,
        timestamp: chat.timestamp.toISOString()
      });

      console.log(`📨 Message sent from ${senderName} to ${receiverName}`);
    } catch (error) {
      console.error('Error sending message:', error);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });

  // Get chat history
  socket.on('get_chat_history', async (data) => {
    try {
      const { userId, otherUserId, limit = 50 } = data;
      
      const roomId = generateRoomId(userId, otherUserId);
      
      const chats = await Chat.find({ roomId })
        .sort({ timestamp: -1 })
        .limit(limit);

      socket.emit('chat_history', {
        chats: chats.reverse().map(chat => ({
          ...chat._doc,
          timestamp: chat.timestamp.toISOString()
        }))
      });
    } catch (error) {
      console.error('Error getting chat history:', error);
    }
  });

  // Get online users berdasarkan role
  socket.on('get_online_users', async (data) => {
    try {
      const { userRole, currentUserId, currentUserEmail } = data;
      
      let query = { isOnline: true, userId: { $ne: currentUserId } };
      
      // Admin bisa lihat semua user
      // Sub admin hanya bisa lihat user biasa (tidak bisa lihat admin lain)
      // User hanya bisa lihat admin dan sub admin (tidak bisa lihat user lain)
      if (userRole === 'sub_admin') {
        query.userRole = 'user';
      } else if (userRole === 'user') {
        query.userRole = { $in: ['admin', 'sub_admin'] };
      }

      const onlineUsers = await UserStatus.find(query);
      
      socket.emit('online_users', onlineUsers.map(user => ({
        userId: user.userId,
        userName: user.userName,
        userRole: user.userRole,
        email: user.email,
        isOnline: user.isOnline,
        lastSeen: user.lastSeen
      })));
    } catch (error) {
      console.error('Error getting online users:', error);
    }
  });

  // Get all users untuk admin/sub-admin (untuk dropdown pilih user)
  socket.on('get_all_users', async (data) => {
    try {
      const { userRole } = data;
      
      let query = {};
      
      // Filter berdasarkan role yang bisa dilihat
      if (userRole === 'sub_admin') {
        query.userRole = 'user';
      } else if (userRole === 'user') {
        // User tidak bisa melihat user lain, hanya admin/sub-admin
        socket.emit('all_users', []);
        return;
      }

      const allUsers = await UserStatus.find(query);
      
      socket.emit('all_users', allUsers.map(user => ({
        userId: user.userId,
        userName: user.userName,
        userRole: user.userRole,
        email: user.email,
        isOnline: user.isOnline,
        lastSeen: user.lastSeen
      })));
    } catch (error) {
      console.error('Error getting all users:', error);
    }
  });

  // Typing indicator
  socket.on('typing', (data) => {
    const { receiverId, senderName, isTyping } = data;
    io.to(`user_${receiverId}`).emit('user_typing', {
      senderId: socket.userId,
      senderName,
      isTyping
    });
  });

  // Mark as read
  socket.on('mark_as_read', async (data) => {
    try {
      const { senderId, receiverId } = data;
      const roomId = generateRoomId(senderId, receiverId);
      
      await Chat.updateMany(
        { roomId, receiverId, isRead: false },
        { $set: { isRead: true } }
      );

      // Notify sender that messages are read
      io.to(`user_${senderId}`).emit('messages_read', {
        receiverId,
        timestamp: new Date()
      });
    } catch (error) {
      console.error('Error marking as read:', error);
    }
  });

  // User disconnect
  socket.on('disconnect', async () => {
    try {
      const userStatus = await UserStatus.findOne({ socketId: socket.id });
      
      if (userStatus) {
        await UserStatus.findOneAndUpdate(
          { userId: userStatus.userId },
          {
            isOnline: false,
            lastSeen: new Date()
          }
        );

        io.emit('user_status', {
          userId: userStatus.userId,
          userName: userStatus.userName,
          userRole: userStatus.userRole,
          email: userStatus.email,
          isOnline: false
        });

        console.log(`👋 ${userStatus.userName} disconnected`);
      }
    } catch (error) {
      console.error('Error handling disconnect:', error);
    }
  });
});

// Endpoint untuk upload file ke Cloudinary
app.post("/upload", upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Tidak ada file yang diupload"
      });
    }

    // Convert buffer to base64
    const b64 = Buffer.from(req.file.buffer).toString('base64');
    const dataURI = `data:${req.file.mimetype};base64,${b64}`;

    // Upload ke Cloudinary
    const result = await cloudinary.uploader.upload(dataURI, {
      folder: "chat_files",
      resource_type: "auto"
    });

    res.json({
      success: true,
      message: "✅ File berhasil diupload",
      fileUrl: result.secure_url,
      fileName: req.file.originalname,
      fileType: req.file.mimetype,
      fileSize: req.file.size
    });
  } catch (error) {
    console.error("❌ Upload error:", error);
    res.status(500).json({
      success: false,
      message: "Gagal mengupload file",
      error: error.message
    });
  }
});

// Endpoint untuk mendapatkan chat history (REST API)
app.get("/api/chats", async (req, res) => {
  try {
    const { userId, otherUserId, page = 1, limit = 20 } = req.query;
    
    const roomId = generateRoomId(userId, otherUserId);
    
    const chats = await Chat.find({ roomId })
      .sort({ timestamp: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await Chat.countDocuments({ roomId });

    res.json({
      success: true,
      chats: chats.reverse(),
      total,
      page: parseInt(page),
      pages: Math.ceil(total / limit)
    });
  } catch (error) {
    console.error("❌ Get chats error:", error);
    res.status(500).json({
      success: false,
      message: "Gagal mengambil chat history"
    });
  }
});

// Endpoint untuk mendapatkan online users
app.get("/api/online-users", async (req, res) => {
  try {
    const { userRole, currentUserId } = req.query;
    
    let query = { isOnline: true, userId: { $ne: currentUserId } };
    
    if (userRole === 'sub_admin') {
      query.userRole = 'user';
    } else if (userRole === 'user') {
      query.userRole = { $in: ['admin', 'sub_admin'] };
    }

    const onlineUsers = await UserStatus.find(query);
    
    res.json({
      success: true,
      onlineUsers: onlineUsers.map(user => ({
        userId: user.userId,
        userName: user.userName,
        userRole: user.userRole,
        email: user.email,
        isOnline: user.isOnline,
        lastSeen: user.lastSeen
      }))
    });
  } catch (error) {
    console.error("❌ Get online users error:", error);
    res.status(500).json({
      success: false,
      message: "Gagal mengambil data online users"
    });
  }
});

// Endpoint untuk update user status
app.post("/api/update-status", async (req, res) => {
  try {
    const { userId, userName, userRole, email, isOnline } = req.body;
    
    await UserStatus.findOneAndUpdate(
      { userId },
      {
        userName,
        userRole,
        email,
        isOnline,
        lastSeen: new Date()
      },
      { upsert: true, new: true }
    );

    res.json({
      success: true,
      message: "✅ Status updated"
    });
  } catch (error) {
    console.error("❌ Update status error:", error);
    res.status(500).json({
      success: false,
      message: "Gagal update status"
    });
  }
});

// Endpoint untuk mendapatkan semua users (untuk admin/sub-admin)
app.get("/api/all-users", async (req, res) => {
  try {
    const { userRole } = req.query;
    
    let query = {};
    
    if (userRole === 'sub_admin') {
      query.userRole = 'user';
    } else if (userRole === 'user') {
      // User tidak bisa melihat user lain
      return res.json({
        success: true,
        users: []
      });
    }

    const allUsers = await UserStatus.find(query);
    
    res.json({
      success: true,
      users: allUsers.map(user => ({
        userId: user.userId,
        userName: user.userName,
        userRole: user.userRole,
        email: user.email,
        isOnline: user.isOnline,
        lastSeen: user.lastSeen
      }))
    });
  } catch (error) {
    console.error("❌ Get all users error:", error);
    res.status(500).json({
      success: false,
      message: "Gagal mengambil data users"
    });
  }
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

app.get("/", (req, res) => {
  res.send("Server berjalan & MongoDB terkoneksi! Chat system ready.");
});

const PORT = process.env.PORT || 2006;

httpServer.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
  console.log("✅ Cloudinary configured");
  console.log("✅ Socket.IO ready");
  connectMongo();
});