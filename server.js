const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const express = require("express");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});
async function createTables() {

  await pool.query(`
    CREATE TABLE IF NOT EXISTS attendance (
      id SERIAL PRIMARY KEY,
      line_user_id TEXT,
      name TEXT,
      type TEXT,
      clock_time TIMESTAMP,
      latitude REAL,
      longitude REAL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS employees (
      id SERIAL PRIMARY KEY,
      line_user_id TEXT,
      name TEXT,
      department TEXT,
      position TEXT,
      hourly_wage REAL,
      base_salary REAL DEFAULT 27000,
      fixed_allowance REAL DEFAULT 3000,
      attendance_bonus REAL DEFAULT 3000,
      performance_bonus REAL DEFAULT 0,
      status TEXT DEFAULT '在職'
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS leaves (
      id SERIAL PRIMARY KEY,
      line_user_id TEXT,
      name TEXT,
      leave_type TEXT,
      start_date TEXT,
      end_date TEXT,
      reason TEXT,
      status TEXT DEFAULT '待審核',
      created_at TEXT
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clock_requests (
      id SERIAL PRIMARY KEY,
      line_user_id TEXT,
      name TEXT,
      clock_type TEXT,
      clock_time TEXT,
      reason TEXT,
      status TEXT DEFAULT '待審核',
      created_at TEXT
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      id SERIAL PRIMARY KEY,
      gps_enabled INTEGER DEFAULT 1,
      company_lat REAL DEFAULT 24.7906,
      company_lng REAL DEFAULT 120.9969,
      gps_radius REAL DEFAULT 300
    )
  `);

  console.log("✅ PostgreSQL Tables Ready");
}

createTables();
pool.connect()
.then(() => {
  console.log("✅ PostgreSQL Connected");
})
.catch(err => {
  console.error("❌ PostgreSQL Error:", err);
});
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
// GPS距離計算
// =========================

function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = value => value * Math.PI / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
    Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) *
    Math.sin(dLng / 2);

  const c =
    2 * Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    );

  return R * c;
}

function getTaiwanDateString() {
  return new Date().toLocaleDateString("zh-TW", {
    timeZone: "Asia/Taipei"
  });
}

function getTaiwanTimeString(date = new Date()) {
  return date.toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei"
  });
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

  base_salary REAL DEFAULT 27000,
  fixed_allowance REAL DEFAULT 3000,
  attendance_bonus REAL DEFAULT 3000,
  performance_bonus REAL DEFAULT 0,

  status TEXT DEFAULT '在職'
)
`).run();

db.prepare(`
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gps_enabled INTEGER DEFAULT 1,
  company_lat REAL DEFAULT 24.7906,
  company_lng REAL DEFAULT 120.9969,
  gps_radius REAL DEFAULT 300
)
`).run();
// =========================
// 出勤規則資料表
// =========================

db.prepare(`
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_start TEXT DEFAULT '09:00',
  work_end TEXT DEFAULT '18:00',
  break_hours REAL DEFAULT 1,
  overtime_start TEXT DEFAULT '18:30'
)
`).run();

const rule = db.prepare(
  "SELECT * FROM rules LIMIT 1"
).get();

if (!rule) {
  db.prepare(`
    INSERT INTO rules
    (
      work_start,
      work_end,
      break_hours,
      overtime_start
    )
    VALUES
    (
      '09:00',
      '18:00',
      1,
      '18:30'
    )
  `).run();
}
const setting = db.prepare(
  "SELECT * FROM settings LIMIT 1"
).get();

if (!setting) {
  db.prepare(`
    INSERT INTO settings
    (
      gps_enabled,
      company_lat,
      company_lng,
      gps_radius
    )
    VALUES
    (
      1,
      24.7906,
      120.9969,
      300
    )
  `).run();
}

// =========================
// 打卡
// =========================

app.post("/api/clock", async (req, res) => {
  const {
    lineUserId,
    name,
    type,
    latitude,
    longitude
  } = req.body;

  if (!lineUserId || !name || !type) {
    return res.status(400).json({
      success: false,
      message: "缺少打卡資料"
    });
  }

  try {

  const today =
  getTaiwanDateString();

  // =========================
  // 打卡時間限制
  // =========================

  const taipeiNow = new Date(
    new Date().toLocaleString("en-US", {
      timeZone: "Asia/Taipei"
    })
  );

  const currentHour =
  taipeiNow.getHours();

  if (currentHour < 8) {
    return res.status(403).json({
      success:false,
      message:"08:00後才能打卡"
    });
  }

  // =========================
  // 今日請假禁止打卡
  // =========================

  const leaveResult =
  await pool.query(
    `
    SELECT *
    FROM leaves
    WHERE line_user_id = $1
    AND (
      status = '已核准'
      OR
      status = '核准'
    )
    `,
    [lineUserId]
  );

  const todayISO =
  taipeiNow.toISOString().split("T")[0];

  for (const leave of leaveResult.rows) {

    if (
      todayISO >= leave.start_date &&
      todayISO <= leave.end_date
    ) {
      return res.status(403).json({
        success:false,
        message:
        "今日已請假（" +
        leave.leave_type +
        "），無法打卡"
      });
    }

  }

    const recordsResult =
    await pool.query(
      "SELECT * FROM attendance WHERE line_user_id = $1 ORDER BY id DESC",
      [lineUserId]
    );

    const records =
    recordsResult.rows;

    const todayRecords =
    records.filter(item => {
      const itemDate =
      new Date(item.clock_time)
      .toLocaleDateString("zh-TW", {
        timeZone: "Asia/Taipei"
      });

      return itemDate === today;
    });

    const hasSameTypeToday =
    todayRecords.some(
      item => item.type === type
    );

    if (hasSameTypeToday) {
      return res.status(400).json({
        success: false,
        message:
          "今天已經完成「" +
          type +
          "」打卡，請勿重複打卡"
      });
    }

    if (type === "下班") {
      const hasClockIn =
      todayRecords.some(
        item => item.type === "上班"
      );

      if (!hasClockIn) {
        return res.status(400).json({
          success: false,
          message: "尚未上班打卡，不能下班打卡"
        });
      }
    }

    const gpsSettingResult =
    await pool.query(
      "SELECT * FROM settings LIMIT 1"
    );

    const gpsSetting =
    gpsSettingResult.rows[0];

    const userLat =
    Number(latitude);

    const userLng =
    Number(longitude);

    let distance = null;

    if (
      gpsSetting &&
      Number(gpsSetting.gps_enabled) === 1
    ) {
      if (
        !latitude ||
        !longitude ||
        isNaN(userLat) ||
        isNaN(userLng)
      ) {
        return res.status(400).json({
          success: false,
          message: "無法取得定位，請開啟GPS後再打卡"
        });
      }

      distance =
      calculateDistance(
        Number(gpsSetting.company_lat),
        Number(gpsSetting.company_lng),
        userLat,
        userLng
      );

      if (
        distance >
        Number(gpsSetting.gps_radius)
      ) {
        return res.status(403).json({
          success: false,
          message:
            "不在公司範圍內，無法打卡。目前距離約 " +
            Math.round(distance) +
            " 公尺"
        });
      }
    }

    const now =
    new Date();

    const nowISO =
    now.toISOString();

    await pool.query(
      `
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
      ($1,$2,$3,$4,$5,$6)
      `,
      [
        lineUserId,
        name,
        type,
        nowISO,
        latitude,
        longitude
      ]
    );

    const timeText =
    getTaiwanTimeString(now);

    await pushLineMessage(
      lineUserId,
`✅ 打卡成功

員工：${name}
類型：${type}

時間：
${timeText}

狀態：
已完成打卡`
    );

    await pushLineMessage(
      MANAGER_LINE_USER_ID,
`📍 員工打卡通知

員工：${name}
類型：${type}

時間：
${timeText}

距離公司：
${
  distance === null
  ? "未啟用GPS限制"
  : Math.round(distance) + " 公尺"
}`
    );

    res.json({
      success: true,
      message: "打卡成功",
      time: nowISO
    });

  } catch(err) {

    console.error(err);

    res.status(500).json({
      success: false,
      message: "打卡失敗，請稍後再試"
    });

  }
});
app.get("/api/attendance", async (req, res) => {

  try {

    const result = await pool.query(
      "SELECT * FROM attendance ORDER BY id DESC"
    );

    res.json(result.rows);

  } catch(err) {

    console.error(err);

    res.status(500).json({
      success:false,
      message:"讀取打卡資料失敗"
    });

  }

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

  const now =
  new Date().toISOString();

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

app.get("/api/leaves", async (req, res) => {

  try {

    const result = await pool.query(
      "SELECT * FROM leaves ORDER BY id DESC"
    );

    res.json(result.rows);

  } catch(err) {

    console.error(err);

    res.status(500).json({
      success:false,
      message:"讀取請假資料失敗"
    });

  }

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
// =========================
// 員工管理
// =========================

app.post("/api/employees", async (req, res) => {
  const {
    lineUserId,
    name,
    department,
    position,
    hourlyWage,
    baseSalary,
    fixedAllowance,
    attendanceBonus,
    performanceBonus
  } = req.body;

  if (!name) {
    return res.status(400).json({
      success: false,
      message: "請輸入員工姓名"
    });
  }

  try {
    await pool.query(
      `
      INSERT INTO employees
      (
        line_user_id,
        name,
        department,
        position,
        hourly_wage,
        base_salary,
        fixed_allowance,
        attendance_bonus,
        performance_bonus,
        status
      )
      VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      `,
      [
        lineUserId || "",
        name,
        department || "",
        position || "",
        Number(hourlyWage || 0),
        Number(baseSalary || 27000),
        Number(fixedAllowance || 3000),
        Number(attendanceBonus || 3000),
        Number(performanceBonus || 0),
        "在職"
      ]
    );

    res.json({
      success: true,
      message: "員工已新增"
    });

  } catch(err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: "新增員工失敗"
    });
  }
});

app.get("/api/employees", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM employees ORDER BY id DESC"
    );

    res.json(result.rows);

  } catch(err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: "讀取員工資料失敗"
    });
  }
}); 

app.post("/api/employees/status", async (req, res) => {
  const { id, status } = req.body;

  try {
    await pool.query(
      `
      UPDATE employees
      SET status = $1
      WHERE id = $2
      `,
      [status, id]
    );

    res.json({
      success: true,
      message: "員工狀態已更新"
    });

  } catch(err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: "員工狀態更新失敗"
    });
  }
});

// =========================
// 員工綁定 LINE ID
// =========================

app.post("/api/employees/bind", async (req, res) => {
  const {
    name,
    lineUserId
  } = req.body;

  if (!name || !lineUserId) {
    return res.status(400).json({
      success: false,
      message: "缺少員工姓名或 LINE ID"
    });
  }

  try {
    const employee = await pool.query(
      "SELECT * FROM employees WHERE name = $1",
      [name]
    );

    if (employee.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "找不到這位員工，請先到員工管理新增"
      });
    }

    await pool.query(
      `
      UPDATE employees
      SET line_user_id = $1
      WHERE name = $2
      `,
      [lineUserId, name]
    );

    res.json({
      success: true,
      message: "LINE ID 綁定成功"
    });

  } catch(err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: "LINE ID 綁定失敗"
    });
  }
});

// =========================
// GPS設定
// =========================

app.get("/api/settings", (req, res) => {
  const setting =
  db.prepare(
    "SELECT * FROM settings LIMIT 1"
  ).get();

  res.json(setting);
});

app.post("/api/settings", (req, res) => {
  const {
    gps_enabled,
    company_lat,
    company_lng,
    gps_radius
  } = req.body;

  db.prepare(`
    UPDATE settings
    SET
      gps_enabled = ?,
      company_lat = ?,
      company_lng = ?,
      gps_radius = ?
    WHERE id = 1
  `).run(
    gps_enabled,
    company_lat,
    company_lng,
    gps_radius
  );

  res.json({
    success: true,
    message: "GPS設定已儲存"
  });
});
// =========================
// 匯出月薪總表 CSV
// =========================

app.get("/api/export-monthly", (req, res) => {
  const attendance = db.prepare(
    "SELECT * FROM attendance ORDER BY id ASC"
  ).all();

  const employees = db.prepare(
    "SELECT * FROM employees"
  ).all();

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();

  const dayGroups = {};

  attendance.forEach(item => {
    const d = new Date(item.clock_time);

    if (
      d.getFullYear() !== year ||
      d.getMonth() !== month
    ) {
      return;
    }

    const date = d.toLocaleDateString("zh-TW", {
      timeZone: "Asia/Taipei"
    });

    const key = item.name + "_" + date;

    if (!dayGroups[key]) {
      dayGroups[key] = {
        name: item.name,
        date: date,
        start: null,
        end: null
      };
    }

    if (item.type === "上班") {
      if (
        !dayGroups[key].start ||
        new Date(item.clock_time) <
        new Date(dayGroups[key].start)
      ) {
        dayGroups[key].start = item.clock_time;
      }
    }

    if (item.type === "下班") {
      if (
        !dayGroups[key].end ||
        new Date(item.clock_time) >
        new Date(dayGroups[key].end)
      ) {
        dayGroups[key].end = item.clock_time;
      }
    }
  });

  const monthly = {};

  Object.values(dayGroups).forEach(day => {
    if (!monthly[day.name]) {
      monthly[day.name] = 0;
    }

    if (day.start && day.end) {
      const hours =
        (new Date(day.end) - new Date(day.start)) /
        1000 / 60 / 60;

      monthly[day.name] += hours;
    }
  });

  let csv = "\uFEFF員工,本月總工時,時薪,預估薪資\n";

  Object.keys(monthly).forEach(name => {
    const emp = employees.find(e => e.name === name);
    const wage = emp ? Number(emp.hourly_wage || 200) : 200;
    const hours = monthly[name];
    const salary = Math.round(hours * wage);

    csv += `${name},${hours.toFixed(2)},${wage},${salary}\n`;
  });

  res.setHeader(
    "Content-Type",
    "text/csv; charset=utf-8"
  );

  res.setHeader(
    "Content-Disposition",
    "attachment; filename=monthly-report.csv"
  );

  res.send(csv);
});
// =========================
// 薪資總表 API
// =========================

app.get("/api/salary-report", (req, res) => {

  const employees = db.prepare(
    "SELECT * FROM employees WHERE status='在職'"
  ).all();

  const result = employees.map(emp => {

    const baseSalary =
    Number(emp.base_salary || 27000);

    const fixedAllowance =
    Number(emp.fixed_allowance || 3000);

    const attendanceBonus =
    Number(emp.attendance_bonus || 3000);

    const performanceBonus =
    Number(emp.performance_bonus || 0);

    const overtimePay = 0;

    const grossSalary =
      baseSalary +
      fixedAllowance +
      attendanceBonus +
      performanceBonus +
      overtimePay;

    const laborInsurance =
    Math.round(grossSalary * 0.02);

    const healthInsurance =
    Math.round(grossSalary * 0.015);

    const laborPension =
    Math.round(grossSalary * 0.06);

    const netSalary =
      grossSalary -
      laborInsurance -
      healthInsurance;

    return {

      name: emp.name,

      baseSalary,
      fixedAllowance,

      attendanceBonus,
      performanceBonus,

      overtimePay,

      grossSalary,

      laborInsurance,
      healthInsurance,
      laborPension,

      netSalary

    };

  });

  res.json(result);

});
// =========================
// 出勤規則設定 API
// =========================

app.get("/api/rules", (req, res) => {

  const rule =
  db.prepare(
    "SELECT * FROM rules LIMIT 1"
  ).get();

  res.json(rule);

});

app.post("/api/rules", (req, res) => {

  const {
    work_start,
    work_end,
    break_hours,
    overtime_start
  } = req.body;

  db.prepare(`
    UPDATE rules
    SET
      work_start = ?,
      work_end = ?,
      break_hours = ?,
      overtime_start = ?
    WHERE id = 1
  `).run(
    work_start,
    work_end,
    Number(break_hours),
    overtime_start
  );

  res.json({
    success:true,
    message:"出勤規則已儲存"
  });

});
// =========================
// 測試 LINE
// =========================

app.get("/test-line", async (req, res) => {
  const result =
  await pushLineMessage(
    MANAGER_LINE_USER_ID,
    "✅ LINE 通知測試成功"
  );

  res.json({
    success: true,
    message: "測試通知已送出",
    result: result
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

const PORT =
process.env.PORT || 3000;
app.get("/api/check-employee/:lineUserId", async (req, res) => {
  try {
    const { lineUserId } = req.params;

    const result = await pool.query(
      `
      SELECT *
      FROM employees
      WHERE line_user_id = $1
      AND status = '在職'
      LIMIT 1
      `,
      [lineUserId]
    );

    if (result.rows.length === 0) {
      return res.json({
        success: true,
        isEmployee: false,
        exists: false,
        message: "不是員工"
      });
    }

    const emp = result.rows[0];

    res.json({
      success: true,
      isEmployee: true,
      exists: true,
      employee: {
        id: emp.id,
        name: emp.name,
        department: emp.department,
        position: emp.position
      }
    });

  } catch (err) {
    console.error("check employee error:", err);

    res.status(500).json({
      success: false,
      isEmployee: false,
      exists: false,
      message: "身份檢查失敗"
    });
  }
});
app.get("/api/my-worktime/:lineUserId", async (req, res) => {
  try {
    const lineUserId = req.params.lineUserId;

    const result = await pool.query(
      `
      SELECT *
      FROM attendance
      WHERE line_user_id = $1
      ORDER BY clock_time ASC
      `,
      [lineUserId]
    );

    res.json(result.rows);

  } catch (err) {
    console.error(err);
    res.status(500).json({
      success:false,
      message:"讀取工時失敗"
    });
  }
});

app.get("/api/my-salary/:lineUserId", async (req, res) => {
  try {
    const lineUserId = req.params.lineUserId;

    const empResult = await pool.query(
      `
      SELECT *
      FROM employees
      WHERE line_user_id = $1
      AND status = '在職'
      LIMIT 1
      `,
      [lineUserId]
    );

    if (empResult.rows.length === 0) {
      return res.status(404).json({
        success:false,
        message:"找不到員工資料"
      });
    }

    const emp = empResult.rows[0];

    const baseSalary = Number(emp.base_salary || 27000);
    const fixedAllowance = Number(emp.fixed_allowance || 3000);
    let attendanceBonus = Number(emp.attendance_bonus || 3000);

let lateCount = 0;
let earlyLeaveCount = 0;
    const performanceBonus = Number(emp.performance_bonus || 0);

    let overtimePay = 0;
    let leaveDeduction = 0;

    const attendanceResult = await pool.query(
      `
      SELECT *
      FROM attendance
      WHERE line_user_id = $1
      ORDER BY clock_time ASC
      `,
      [lineUserId]
    );

    const dayGroups = {};

    attendanceResult.rows.forEach(item => {
      const date = new Date(item.clock_time).toLocaleDateString("zh-TW", {
        timeZone:"Asia/Taipei"
      });

      if (!dayGroups[date]) {
        dayGroups[date] = {
          start:null,
          end:null
        };
      }

      if (item.type === "上班") {
        if (!dayGroups[date].start || new Date(item.clock_time) < new Date(dayGroups[date].start)) {
          dayGroups[date].start = item.clock_time;
        }
      }

      if (item.type === "下班") {
        if (!dayGroups[date].end || new Date(item.clock_time) > new Date(dayGroups[date].end)) {
          dayGroups[date].end = item.clock_time;
        }
      }
    });

    Object.values(dayGroups).forEach(day => {

  if (day.start && day.end) {

    const startTime = new Date(day.start);
    const endTime = new Date(day.end);

    const workStartHour = 9;
    const workStartMinute = 0;

    const workEndHour = 16;
    const workEndMinute = 0;

    const startMinutes =
      startTime.getHours() * 60 +
      startTime.getMinutes();

    const endMinutes =
      endTime.getHours() * 60 +
      endTime.getMinutes();

    const ruleStartMinutes =
      workStartHour * 60 +
      workStartMinute;

    const ruleEndMinutes =
      workEndHour * 60 +
      workEndMinute;

    if (startMinutes > ruleStartMinutes) {
      lateCount++;
    }

    if (endMinutes < ruleEndMinutes) {
      earlyLeaveCount++;
    }

    const totalHours =
      (endTime - startTime) / 1000 / 60 / 60;

    const overtimeHours =
      Math.max(0, totalHours - 6);

    const hourlyRate =
      Number(emp.hourly_wage || 200);

    const first2Hours =
      Math.min(overtimeHours, 2);

    const after2Hours =
      Math.max(0, overtimeHours - 2);

    overtimePay +=
      first2Hours * hourlyRate * 1.34 +
      after2Hours * hourlyRate * 1.67;
  }

});

    overtimePay = Math.round(overtimePay);

    const leavesResult = await pool.query(
      `
      SELECT *
      FROM leaves
      WHERE line_user_id = $1
      AND (status = '已核准' OR status = '核准')
      `,
      [lineUserId]
    );

    const dailySalary = baseSalary / 30;

    leavesResult.rows.forEach(leave => {
      const start = new Date(leave.start_date);
      const end = new Date(leave.end_date);

      const days =
        Math.floor((end - start) / (1000 * 60 * 60 * 24)) + 1;

      switch (leave.leave_type) {
        case "事假":
          leaveDeduction += dailySalary * days;
          break;
        case "病假":
          leaveDeduction += dailySalary * 0.5 * days;
          break;
        case "曠職":
          leaveDeduction += dailySalary * days;
          break;
        case "特休":
        case "公假":
          break;
      }
    });

    leaveDeduction = Math.round(leaveDeduction);

    // =========================
// 全勤獎金判斷
// =========================

if (
  lateCount > 0 ||
  earlyLeaveCount > 0 ||
  leaveDeduction > 0
) {
  attendanceBonus = 0;
}

    const grossSalary =
      baseSalary +
      fixedAllowance +
      attendanceBonus +
      performanceBonus +
      overtimePay -
      leaveDeduction;

    const laborInsurance = Math.round(grossSalary * 0.02);
    const healthInsurance = Math.round(grossSalary * 0.015);
    const laborPension = Math.round(grossSalary * 0.06);

    const netSalary =
      grossSalary -
      laborInsurance -
      healthInsurance;

    res.json({
  success:true,
  id: emp.id,
  name: emp.name,

  lateCount,
  earlyLeaveCount,

  baseSalary,
  fixedAllowance,
  attendanceBonus,
  performanceBonus,

  overtimePay,
  leaveDeduction,

  grossSalary,

  laborInsurance,
  healthInsurance,
  laborPension,

  netSalary
});

  } catch (err) {
    console.error(err);
    res.status(500).json({
      success:false,
      message:"讀取薪資失敗"
    });
  }
});
app.get("/api/payslip/:id", async (req, res) => {
  try {
    const employeeId = req.params.id;

    const empResult = await pool.query(
      "SELECT * FROM employees WHERE id = $1",
      [employeeId]
    );

    if (empResult.rows.length === 0) {
      return res.status(404).send("找不到員工");
    }

    const emp = empResult.rows[0];

    const salaryRes = await fetch(
      `https://line-attendance-blt1.onrender.com/api/my-salary/${emp.line_user_id}`
    );

    const salary = await salaryRes.json();

    if (!salary.success) {
      return res.status(500).send("薪資資料讀取失敗");
    }

    const doc = new PDFDocument({
      size: "A4",
      margin: 50
    });
const fontPath = path.join(
  __dirname,
  "public",
  "fonts",
  "NotoSansTC-Regular.ttf"
);

if (fs.existsSync(fontPath)) {
  doc.font(fontPath);
} else {
  console.log("找不到中文字型：", fontPath);
}
    const filename =
      `payslip_${emp.name}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(filename)}"`
    );

    doc.pipe(res);

    doc.fontSize(22).text("薪資單", {
      align: "center"
    });

    doc.moveDown();

    doc.fontSize(12);
    doc.text(`員工姓名：${salary.name}`);
    doc.text(`部門：${salary.department || "-"}`);
    doc.text(`職稱：${salary.position || "-"}`);
    doc.text(`月份：${new Date().getFullYear()} / ${new Date().getMonth() + 1}`);

    doc.moveDown();
    doc.text("----------------------------------------");

    doc.fontSize(14).text("應發項目");
    doc.fontSize(12);
    doc.text(`底薪：NT$ ${salary.baseSalary.toLocaleString("zh-TW")}`);
    doc.text(`固定津貼：NT$ ${salary.fixedAllowance.toLocaleString("zh-TW")}`);
    doc.text(`加班費：NT$ ${salary.overtimePay.toLocaleString("zh-TW")}`);
    doc.text(`全勤獎金：NT$ ${salary.attendanceBonus.toLocaleString("zh-TW")}`);
    doc.text(`績效獎金：NT$ ${salary.performanceBonus.toLocaleString("zh-TW")}`);

    doc.moveDown();

    doc.fontSize(14).text("扣除項目");
    doc.fontSize(12);
    doc.text(`請假扣款：NT$ ${salary.leaveDeduction.toLocaleString("zh-TW")}`);
    doc.text(`勞保：NT$ ${salary.laborInsurance.toLocaleString("zh-TW")}`);
    doc.text(`健保：NT$ ${salary.healthInsurance.toLocaleString("zh-TW")}`);
    doc.text(`勞退提繳：NT$ ${salary.laborPension.toLocaleString("zh-TW")}（公司提繳，不自薪資扣除）`);

    doc.moveDown();
    doc.text("----------------------------------------");

    doc.fontSize(16).text(
      `應發薪資：NT$ ${salary.grossSalary.toLocaleString("zh-TW")}`
    );

    doc.fontSize(18).text(
      `實發薪資：NT$ ${salary.netSalary.toLocaleString("zh-TW")}`,
      { align: "right" }
    );

    doc.moveDown();

    doc.fontSize(10).text(
      "備註：本薪資單為系統自動產生，實際金額仍以公司核定為準。"
    );

    doc.end();

  } catch (err) {
    console.error("PDF ERROR:", err);
    res.status(500).send("薪資單產生失敗：" + err.message);
  }
});
app.listen(PORT, () => {
  console.log("Server Running");
  console.log(`Port: ${PORT}`);
});