import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

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

app.get("/", (req, res) => {
  res.send("Server berjalan & MongoDB terkoneksi!");
});

const PORT = process.env.PORT || 2006;

app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
  connectMongo();
});
