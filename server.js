const express = require("express");
const Database = require("better-sqlite3");
const cors = require("cors");
const path = require("path");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const db = new Database("attendance.db");

// =========================
// 出勤資料表
// =========================

db.prepare(`
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line_user_id TEXT,
  name TEXT,
  type TEXT,
  clock_time TEXT,
  latitude REAL,
  longitude REAL
)
`).run();

// =========================
// 請假資料表
// =========================

db.prepare(`
CREATE TABLE IF NOT EXISTS leaves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line_user_id TEXT,
  name TEXT,
  leave_type TEXT,
  start_date TEXT,
  end_date TEXT,
  reason TEXT,
  status TEXT DEFAULT '待審核',
  created_at TEXT
)
`).run();

// =========================
// 員工資料表
// =========================

db.prepare(`
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line_user_id TEXT,
  name TEXT,
  department TEXT,
  position TEXT,
  hourly_wage REAL,
  status TEXT DEFAULT '在職'
)
`).run();

// =========================
// 打卡
// =========================

app.post("/api/clock", (req, res) => {
  const {
    lineUserId,
    name,
    type,
    latitude,
    longitude
  } = req.body;

  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO attendance
    (
      line_user_id,
      name,
      type,
      clock_time,
      latitude,
      longitude
    )
    VALUES
    (?, ?, ?, ?, ?, ?)
  `).run(
    lineUserId,
    name,
    type,
    now,
    latitude,
    longitude
  );

  res.json({
    success: true,
    message: "打卡成功",
    time: now
  });
});

// =========================
// 出勤查詢
// =========================

app.get("/api/attendance", (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM attendance ORDER BY id DESC"
  ).all();

  res.json(rows);
});

// =========================
// 請假申請
// =========================

app.post("/api/leave", (req, res) => {
  const {
    lineUserId,
    name,
    leaveType,
    startDate,
    endDate,
    reason
  } = req.body;

  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO leaves
    (
      line_user_id,
      name,
      leave_type,
      start_date,
      end_date,
      reason,
      status,
      created_at
    )
    VALUES
    (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    lineUserId,
    name,
    leaveType,
    startDate,
    endDate,
    reason,
    "待審核",
    now
  );

  res.json({
    success: true,
    message: "請假申請已送出"
  });
});

// =========================
// 請假查詢
// =========================

app.get("/api/leaves", (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM leaves ORDER BY id DESC"
  ).all();

  res.json(rows);
});

// =========================
// 請假核准 / 駁回
// =========================

app.post("/api/leave/status", (req, res) => {
  const { id, status } = req.body;

  if (!id || !status) {
    return res.status(400).json({
      success: false,
      message: "缺少請假ID或狀態"
    });
  }

  db.prepare(`
    UPDATE leaves
    SET status = ?
    WHERE id = ?
  `).run(status, id);

  res.json({
    success: true,
    message: "請假狀態已更新"
  });
});

// =========================
// 新增員工
// =========================

app.post("/api/employees", (req, res) => {
  const {
    lineUserId,
    name,
    department,
    position,
    hourlyWage
  } = req.body;

  if (!name) {
    return res.status(400).json({
      success: false,
      message: "請輸入員工姓名"
    });
  }

  db.prepare(`
    INSERT INTO employees
    (
      line_user_id,
      name,
      department,
      position,
      hourly_wage,
      status
    )
    VALUES
    (?, ?, ?, ?, ?, ?)
  `).run(
    lineUserId || "",
    name,
    department || "",
    position || "",
    Number(hourlyWage || 0),
    "在職"
  );

  res.json({
    success: true,
    message: "員工已新增"
  });
});

// =========================
// 員工列表
// =========================

app.get("/api/employees", (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM employees ORDER BY id DESC"
  ).all();

  res.json(rows);
});

// =========================
// 更新員工狀態
// =========================

app.post("/api/employees/status", (req, res) => {
  const { id, status } = req.body;

  db.prepare(`
    UPDATE employees
    SET status = ?
    WHERE id = ?
  `).run(status, id);

  res.json({
    success: true,
    message: "員工狀態已更新"
  });
});

// =========================
// 首頁
// =========================

app.get("/", (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "public",
      "index.html"
    )
  );
});

// =========================
// 啟動
// =========================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server Running");
  console.log(`Port: ${PORT}`);
});