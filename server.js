// server.js (UPDATED)
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
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Setup Multer untuk file upload
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// MongoDB Schema dan Model
const chatSchema = new mongoose.Schema({
  roomId: { type: String, required: true },
  senderId: { type: String, required: true },
  senderName: { type: String, required: true },
  senderRole: { type: String, required: true }, // 'user', 'admin', 'sub_admin'
  receiverId: { type: String },
  receiverName: { type: String },
  message: { type: String },
  messageType: { 
    type: String, 
    enum: ['text', 'image', 'video', 'file', 'pdf', 'word'], 
    default: 'text' 
  },
  fileUrl: { type: String },
  fileName: { type: String },
  fileSize: { type: Number },
  read: { type: Boolean, default: false },
  delivered: { type: Boolean, default: false },
  timestamp: { type: Date, default: Date.now }
}, { timestamps: true });

const Chat = mongoose.model('Chat', chatSchema);

const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  nim: { type: String, required: true },
  prodi: { type: String, required: true },
  role: { 
    type: String, 
    enum: ['user', 'admin', 'sub_admin'], 
    default: 'user' 
  },
  lastSeen: { type: Date, default: Date.now },
  online: { type: Boolean, default: false },
  socketId: { type: String },
  avatar: { type: String }
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

// Koneksi MongoDB
async function connectMongo() {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 5000
    });
    console.log("✅ MongoDB Connected!");
    
    mongoose.connection.on("disconnected", () => {
      console.log("❌ MongoDB Lost Connection! Reconnecting...");
      setTimeout(connectMongo, 3000);
    });
    
  } catch (err) {
    console.log("❌ MongoDB Connect Failed, retrying in 3s...", err);
    setTimeout(connectMongo, 3000);
  }
}

// Socket.io Connection
const connectedUsers = new Map();

io.on('connection', (socket) => {
  console.log(`🔌 User connected: ${socket.id}`);
  
  // User login/register
  socket.on('user-login', async (userData) => {
    try {
      const { userId, name, email, nim, prodi, role = 'user' } = userData;
      
      // Update user status
      const user = await User.findOneAndUpdate(
        { email: email },
        {
          $set: {
            userId: userId,
            name: name,
            email: email,
            nim: nim,
            prodi: prodi,
            role: role,
            online: true,
            socketId: socket.id,
            lastSeen: new Date()
          }
        },
        { upsert: true, new: true }
      );
      
      // Store socket connection
      connectedUsers.set(userId, {
        socketId: socket.id,
        user: user
      });
      
      // Join user to their personal room
      socket.join(`user_${userId}`);
      
      // If user is not admin, join admin room
      if (role === 'user') {
        socket.join('admin_room');
        
        // Send automatic welcome message from admin
        setTimeout(async () => {
          const welcomeMessage = {
            roomId: `user_${userId}`,
            senderId: 'admin_system',
            senderName: 'Admin Taiso Talk',
            senderRole: 'admin',
            receiverId: userId,
            receiverName: name,
            message: `Halo ${name}! Selamat datang di Taiso Talk. Ada yang bisa kami bantu?`,
            messageType: 'text',
            timestamp: new Date()
          };
          
          await Chat.create(welcomeMessage);
          socket.emit('new-message', welcomeMessage);
        }, 2000);
      }
      
      // Notify online status to admin if user logs in
      if (role === 'user') {
        io.to('admin_room').emit('user-status-changed', {
          userId,
          name,
          online: true,
          lastSeen: new Date()
        });
      }
      
      // Send previous messages
      const messages = await Chat.find({
        $or: [
          { roomId: `user_${userId}` },
          { senderId: userId },
          { receiverId: userId }
        ]
      }).sort({ timestamp: 1 });
      
      socket.emit('previous-messages', messages);
      
      console.log(`✅ User logged in: ${name} (${email})`);
      
    } catch (error) {
      console.error('Login error:', error);
      socket.emit('login-error', { message: 'Login failed' });
    }
  });
  
  // Send message
  socket.on('send-message', async (data) => {
    try {
      const {
        roomId,
        senderId,
        senderName,
        senderRole,
        receiverId,
        receiverName,
        message,
        messageType = 'text',
        fileUrl,
        fileName,
        fileSize
      } = data;
      
      const chatMessage = {
        roomId,
        senderId,
        senderName,
        senderRole,
        receiverId,
        receiverName,
        message,
        messageType,
        fileUrl,
        fileName,
        fileSize,
        read: false,
        delivered: false,
        timestamp: new Date()
      };
      
      // Save to database
      const savedMessage = await Chat.create(chatMessage);
      
      // Determine who should receive the message
      if (senderRole === 'user') {
        // User sending to admin - broadcast to all admins
        io.to('admin_room').emit('new-message', savedMessage);
        // Also send to user themselves
        socket.emit('new-message', savedMessage);
      } else {
        // Admin sending to user
        const receiver = connectedUsers.get(receiverId);
        if (receiver) {
          io.to(receiver.socketId).emit('new-message', savedMessage);
        }
        // Also send to sender (admin)
        socket.emit('new-message', savedMessage);
      }
      
      // Mark as delivered
      savedMessage.delivered = true;
      await savedMessage.save();
      
    } catch (error) {
      console.error('Send message error:', error);
      socket.emit('message-error', { message: 'Failed to send message' });
    }
  });
  
  // Mark message as read
  socket.on('mark-as-read', async (messageIds) => {
    try {
      await Chat.updateMany(
        { _id: { $in: messageIds } },
        { $set: { read: true } }
      );
    } catch (error) {
      console.error('Mark as read error:', error);
    }
  });
  
  // Get all users for admin
  socket.on('get-all-users', async () => {
    try {
      const users = await User.find({ role: 'user' })
        .sort({ lastSeen: -1 })
        .select('userId name email nim prodi online lastSeen');
      
      socket.emit('all-users', users);
    } catch (error) {
      console.error('Get users error:', error);
    }
  });
  
  // Get user messages
  socket.on('get-user-messages', async (userId) => {
    try {
      const messages = await Chat.find({
        $or: [
          { roomId: `user_${userId}` },
          { senderId: userId },
          { receiverId: userId }
        ]
      }).sort({ timestamp: 1 });
      
      socket.emit('user-messages', messages);
    } catch (error) {
      console.error('Get user messages error:', error);
    }
  });
  
  // Typing indicator
  socket.on('typing', (data) => {
    const { userId, receiverId, isTyping } = data;
    
    if (receiverId) {
      const receiver = connectedUsers.get(receiverId);
      if (receiver) {
        io.to(receiver.socketId).emit('user-typing', {
          userId,
          isTyping
        });
      }
    }
  });
  
  // User disconnected
  socket.on('disconnect', async () => {
    let disconnectedUser = null;
    
    // Find and remove disconnected user
    for (const [userId, userData] of connectedUsers.entries()) {
      if (userData.socketId === socket.id) {
        disconnectedUser = { userId, ...userData.user._doc };
        connectedUsers.delete(userId);
        
        // Update user status in database
        await User.findOneAndUpdate(
          { userId: userId },
          {
            $set: {
              online: false,
              lastSeen: new Date()
            }
          }
        );
        
        // Notify admin if user is not admin
        if (disconnectedUser.role === 'user') {
          io.to('admin_room').emit('user-status-changed', {
            userId: disconnectedUser.userId,
            name: disconnectedUser.name,
            online: false,
            lastSeen: new Date()
          });
        }
        
        break;
      }
    }
    
    console.log(`🔌 User disconnected: ${socket.id}`, disconnectedUser?.name || 'Unknown');
  });
});

// Endpoint untuk upload file ke Cloudinary
app.post("/upload", upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No file uploaded"
      });
    }
    
    // Upload ke Cloudinary
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: "auto",
          folder: "taiso_talk"
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      
      stream.end(req.file.buffer);
    });
    
    res.json({
      success: true,
      fileUrl: result.secure_url,
      fileType: result.resource_type,
      fileName: req.file.originalname,
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

// Get all users (for admin)
app.get("/users", async (req, res) => {
  try {
    const users = await User.find({ role: 'user' })
      .sort({ lastSeen: -1 })
      .select('userId name email nim prodi online lastSeen');
    
    res.json({
      success: true,
      users: users
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch users"
    });
  }
});

// Get user messages
app.get("/messages/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const messages = await Chat.find({
      $or: [
        { roomId: `user_${userId}` },
        { senderId: userId },
        { receiverId: userId }
      ]
    }).sort({ timestamp: 1 });
    
    res.json({
      success: true,
      messages: messages
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch messages"
    });
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
  res.send("Server berjalan & MongoDB terkoneksi! Cloudinary siap digunakan. Socket.io aktif.");
});

const PORT = process.env.PORT || 2006;

httpServer.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
  console.log("✅ Cloudinary configured");
  console.log("🔌 Socket.io ready");
  connectMongo();
});