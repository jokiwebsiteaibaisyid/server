import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import { v2 as cloudinary } from "cloudinary";

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
    // Test koneksi Cloudinary
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

// Upload endpoint (akan dikembangkan nanti)
app.post("/upload", (req, res) => {
  res.json({
    message: "Upload endpoint ready - will handle image uploads to Cloudinary"
  });
});

app.get("/", (req, res) => {
  res.send("Server berjalan & MongoDB terkoneksi! Cloudinary siap digunakan.");
});

const PORT = process.env.PORT || 2006;

app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
  console.log("✅  Cloudinary configured with cloud_name:", process.env.CLOUDINARY_CLOUD_NAME);
  connectMongo();
});