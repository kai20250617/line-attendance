const express = require("express");
const Database = require("better-sqlite3");
const cors = require("cors");
const path = require("path");

const LINE_CHANNEL_ACCESS_TOKEN =
process.env.LINE_CHANNEL_ACCESS_TOKEN;

const MANAGER_LINE_USER_ID =
process.env.MANAGER_LINE_USER_ID;

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const db = new Database("attendance.db");

// =========================
// LINE 推播通知
// =========================

async function pushLineMessage(userId, text) {
  if (!LINE_CHANNEL_ACCESS_TOKEN || !userId) {
    console.log("LINE通知未設定");
    return;
  }

  try {
    const response = await fetch(
      "https://api.line.me/v2/bot/message/push",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + LINE_CHANNEL_ACCESS_TOKEN
        },
        body: JSON.stringify({
          to: userId,
          messages: [
            {
              type: "text",
              text: text
            }
          ]
        })
      }
    );

    const result = await response.text();

    console.log("LINE通知結果：", result);
  } catch (err) {
    console.error("LINE通知失敗：", err);
  }
}

// =========================
// 資料表
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
  const { lineUserId, name, type, latitude, longitude } = req.body;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO attendance
    (line_user_id, name, type, clock_time, latitude, longitude)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(lineUserId, name, type, now, latitude, longitude);

  res.json({
    success: true,
    message: "打卡成功",
    time: now
  });
});

app.get("/api/attendance", (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM attendance ORDER BY id DESC"
  ).all();

  res.json(rows);
});

// =========================
// 請假
// =========================

app.post("/api/leave", async (req, res) => {
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
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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

  await pushLineMessage(
    MANAGER_LINE_USER_ID,
`📌 新請假申請

員工：${name}
假別：${leaveType}

日期：
${startDate}
~
${endDate}

原因：
${reason}

請至後台審核：
https://line-attendance-blt1.onrender.com/leave-admin.html`
  );

  res.json({
    success: true,
    message: "請假申請已送出"
  });
});

app.get("/api/leaves", (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM leaves ORDER BY id DESC"
  ).all();

  res.json(rows);
});

// =========================
// 請假核准 / 駁回
// =========================

app.post("/api/leave/status", async (req, res) => {
  const { id, status } = req.body;

  if (!id || !status) {
    return res.status(400).json({
      success: false,
      message: "缺少請假ID或狀態"
    });
  }

  const leave = db.prepare(
    "SELECT * FROM leaves WHERE id = ?"
  ).get(id);

  db.prepare(`
    UPDATE leaves
    SET status = ?
    WHERE id = ?
  `).run(status, id);

  if (leave && leave.line_user_id) {
    await pushLineMessage(
      leave.line_user_id,
`📢 請假審核結果

員工：${leave.name}
假別：${leave.leave_type}

日期：
${leave.start_date}
~
${leave.end_date}

狀態：${status}`
    );
  }

  res.json({
    success: true,
    message: "請假狀態已更新"
  });
});

// =========================
// 員工管理
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

app.get("/api/employees", (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM employees ORDER BY id DESC"
  ).all();

  res.json(rows);
});

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
// 員工綁定 LINE ID
// =========================

app.post("/api/employees/bind", (req, res) => {
  const { name, lineUserId } = req.body;

  if (!name || !lineUserId) {
    return res.status(400).json({
      success: false,
      message: "缺少員工姓名或 LINE ID"
    });
  }

  const employee = db.prepare(
    "SELECT * FROM employees WHERE name = ?"
  ).get(name);

  if (!employee) {
    return res.status(404).json({
      success: false,
      message: "找不到這位員工，請先到員工管理新增"
    });
  }

  db.prepare(`
    UPDATE employees
    SET line_user_id = ?
    WHERE name = ?
  `).run(lineUserId, name);

  res.json({
    success: true,
    message: "LINE ID 綁定成功"
  });
});

// =========================
// 首頁
// =========================

app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server Running");
  console.log(`Port: ${PORT}`);
});