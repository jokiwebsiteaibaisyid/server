import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import { v2 as cloudinary } from "cloudinary";
import { createServer } from "http";
import { Server } from "socket.io";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";

// ES Module fix
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    origin: "*", // Ganti dengan domain Flutter Anda jika diperlukan
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// MongoDB Models
const messageSchema = new mongoose.Schema({
  roomId: String,
  senderId: String,
  senderName: String,
  senderRole: String,
  message: String,
  type: { type: String, default: 'text' },
  fileUrl: String,
  fileName: String,
  fileSize: Number,
  timestamp: { type: Date, default: Date.now }
});

const roomSchema = new mongoose.Schema({
  roomId: String,
  userId: String,
  userName: String,
  userEmail: String,
  userNim: String,
  adminId: String,
  adminName: String,
  lastMessage: String,
  lastMessageTime: { type: Date, default: Date.now },
  unreadCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

const Message = mongoose.model('Message', messageSchema);
const Room = mongoose.model('Room', roomSchema);

// Multer untuk upload file
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

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

// Socket.io connection
io.on('connection', (socket) => {
  console.log('✅ User connected:', socket.id);

  // Join room
  socket.on('join-room', async (data) => {
    const { roomId, userId, userName, userRole } = data;
    
    socket.join(roomId);
    console.log(`👤 ${userName} joined room: ${roomId}`);
    
    // Update user online status
    socket.to(roomId).emit('user-status', {
      userId,
      userName,
      status: 'online'
    });
    
    // Send previous messages
    try {
      const messages = await Message.find({ roomId })
        .sort({ timestamp: 1 })
        .limit(50);
      
      socket.emit('previous-messages', messages);
      
      // Reset unread count if user is admin
      if (userRole === 'admin' || userRole === 'sub_admin') {
        await Room.findOneAndUpdate(
          { roomId },
          { unreadCount: 0 }
        );
      }
    } catch (error) {
      console.error('Error fetching messages:', error);
    }
  });

  // Send message
  socket.on('send-message', async (data) => {
    const { roomId, senderId, senderName, senderRole, message, type = 'text', fileUrl, fileName, fileSize } = data;
    
    try {
      // Save message to database
      const newMessage = new Message({
        roomId,
        senderId,
        senderName,
        senderRole,
        message,
        type,
        fileUrl,
        fileName,
        fileSize,
        timestamp: new Date()
      });
      
      await newMessage.save();
      
      // Update room info
      await Room.findOneAndUpdate(
        { roomId },
        {
          lastMessage: type === 'text' ? message : `📎 ${fileName || 'File'}`,
          lastMessageTime: new Date(),
          $inc: { unreadCount: 1 }
        },
        { upsert: true, new: true }
      );
      
      // Broadcast message to room
      io.to(roomId).emit('receive-message', newMessage);
      
      // Notify typing stopped
      socket.to(roomId).emit('typing-stopped', { senderId });
      
    } catch (error) {
      console.error('Error saving message:', error);
      socket.emit('message-error', { error: 'Failed to send message' });
    }
  });

  // Typing indicator
  socket.on('typing', (data) => {
    const { roomId, senderId, senderName } = data;
    socket.to(roomId).emit('user-typing', {
      userId: senderId,
      userName: senderName
    });
  });

  // Typing stopped
  socket.on('typing-stopped', (data) => {
    const { roomId, senderId } = data;
    socket.to(roomId).emit('typing-stopped', { userId: senderId });
  });

  // User disconnected
  socket.on('disconnect', () => {
    console.log('❌ User disconnected:', socket.id);
  });

  // Read receipt
  socket.on('message-read', async (data) => {
    const { roomId, userId } = data;
    
    try {
      await Room.findOneAndUpdate(
        { roomId, userId },
        { unreadCount: 0 }
      );
      
      socket.to(roomId).emit('message-read', { userId });
    } catch (error) {
      console.error('Error updating read status:', error);
    }
  });

  // Get user rooms
  socket.on('get-rooms', async (data) => {
    const { userId, role } = data;
    
    try {
      let rooms;
      if (role === 'admin' || role === 'sub_admin') {
        // Admin can see all rooms
        rooms = await Room.find().sort({ lastMessageTime: -1 });
      } else {
        // User can only see their own room
        rooms = await Room.find({ userId }).sort({ lastMessageTime: -1 });
      }
      
      socket.emit('user-rooms', rooms);
    } catch (error) {
      console.error('Error fetching rooms:', error);
      socket.emit('rooms-error', { error: 'Failed to fetch rooms' });
    }
  });
});

// Upload file to Cloudinary
app.post('/upload-file', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Convert buffer to base64
    const b64 = Buffer.from(req.file.buffer).toString('base64');
    const dataURI = `data:${req.file.mimetype};base64,${b64}`;

    // Upload to Cloudinary
    const result = await cloudinary.uploader.upload(dataURI, {
      folder: 'taiso-talk',
      resource_type: 'auto'
    });

    res.json({
      success: true,
      fileUrl: result.secure_url,
      fileName: req.file.originalname,
      fileSize: req.file.size,
      fileType: req.file.mimetype
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Get room messages
app.get('/messages/:roomId', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { limit = 50, skip = 0 } = req.query;

    const messages = await Message.find({ roomId })
      .sort({ timestamp: -1 })
      .skip(parseInt(skip))
      .limit(parseInt(limit));

    res.json(messages.reverse());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create or get room
app.post('/room', async (req, res) => {
  try {
    const { userId, userName, userEmail, userNim, adminId = 'admin' } = req.body;
    
    // Create unique room ID
    const roomId = `room_${userId}_${adminId}`;
    
    // Check if room exists
    let room = await Room.findOne({ roomId });
    
    if (!room) {
      room = new Room({
        roomId,
        userId,
        userName,
        userEmail,
        userNim,
        adminId,
        adminName: 'Admin Taiso Talk',
        lastMessage: 'Selamat datang di Taiso Talk! 🎉',
        unreadCount: 0
      });
      
      await room.save();
      
      // Create welcome message
      const welcomeMessage = new Message({
        roomId,
        senderId: 'system',
        senderName: 'System',
        senderRole: 'system',
        message: `Selamat datang ${userName}! Admin siap membantu Anda.`,
        type: 'text',
        timestamp: new Date()
      });
      
      await welcomeMessage.save();
    }
    
    res.json({
      roomId: room.roomId,
      userName: room.userName,
      adminName: room.adminName,
      lastMessage: room.lastMessage,
      lastMessageTime: room.lastMessageTime,
      unreadCount: room.unreadCount
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get user rooms
app.get('/rooms/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { role } = req.query;
    
    let rooms;
    if (role === 'admin' || role === 'sub_admin') {
      rooms = await Room.find().sort({ lastMessageTime: -1 });
    } else {
      rooms = await Room.find({ userId }).sort({ lastMessageTime: -1 });
    }
    
    res.json(rooms);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mark messages as read
app.post('/messages/read', async (req, res) => {
  try {
    const { roomId, userId } = req.body;
    
    await Room.findOneAndUpdate(
      { roomId, userId },
      { unreadCount: 0 }
    );
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Test routes
app.get("/test-cloudinary", async (req, res) => {
  try {
    const result = await cloudinary.api.ping();
    res.json({
      success: true,
      message: "✅ Cloudinary connected successfully!",
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
  res.send("✅ Server berjalan & MongoDB terkoneksi! Socket.io & Cloudinary siap digunakan.");
});

const PORT = process.env.PORT || 2006;

httpServer.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
  console.log("✅ Cloudinary configured with cloud_name:", process.env.CLOUDINARY_CLOUD_NAME);
  console.log("✅ Socket.io ready for realtime communication");
  connectMongo();
});