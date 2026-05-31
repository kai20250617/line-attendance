const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");
const path = require("path");

const app = express();

app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, "public")));

const db = new sqlite3.Database("attendance.db");

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      line_user_id TEXT,
      name TEXT,
      type TEXT,
      clock_time TEXT,
      latitude REAL,
      longitude REAL
    )
  `);
});

app.post("/api/clock", (req, res) => {
  const {
    lineUserId,
    name,
    type,
    latitude,
    longitude
  } = req.body;

  const now = new Date().toISOString();

  db.run(
    `
    INSERT INTO attendance (
      line_user_id,
      name,
      type,
      clock_time,
      latitude,
      longitude
    )
    VALUES (?, ?, ?, ?, ?, ?)
    `,
    [
      lineUserId,
      name,
      type,
      now,
      latitude,
      longitude
    ],
    function (err) {
      if (err) {
        return res.status(500).json({
          success: false,
          error: err.message
        });
      }

      res.json({
        success: true,
        message: "打卡成功",
        time: now
      });
    }
  );
});

app.get("/api/attendance", (req, res) => {
  db.all(
    "SELECT * FROM attendance ORDER BY id DESC",
    [],
    (err, rows) => {
      if (err) {
        return res.status(500).json({
          success: false,
          error: err.message
        });
      }

      res.json(rows);
    }
  );
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("=================================");
  console.log("Server Running");
  console.log(`Port: ${PORT}`);
  console.log("=================================");
});