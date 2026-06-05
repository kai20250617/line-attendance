const path = require("path");

const express = require("express");

const { Pool } = require("pg");

const cors = require("cors");

const app = express();

app.use(cors());

app.use(express.json());

app.use(express.static(path.join(__dirname, "public")));

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

const MANAGER_LINE_USER_ID = process.env.MANAGER_LINE_USER_ID;

const pool = new Pool({

  connectionString: process.env.DATABASE_URL,

  ssl: { rejectUnauthorized: false }

});

// =========================

// 初始化 PostgreSQL

// =========================

async function safeQuery(sql, message) {

  try {

    await pool.query(sql);

  } catch (err) {

    console.log(message || "資料表欄位已存在或無法轉換");

  }

}

async function createTables() {

  await pool.query(`

    CREATE TABLE IF NOT EXISTS attendance (

      id SERIAL PRIMARY KEY,

      line_user_id TEXT,

      name TEXT,

      type TEXT,

      clock_time TIMESTAMPTZ,

      latitude REAL,

      longitude REAL

    )

  `);

  await pool.query(`

    CREATE TABLE IF NOT EXISTS employees (

      id SERIAL PRIMARY KEY,

      line_user_id TEXT UNIQUE,

      name TEXT,

      department TEXT,

      position TEXT,

      hourly_wage REAL DEFAULT 0,

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

      start_date DATE,

      end_date DATE,

      reason TEXT,

      status TEXT DEFAULT '待審核',

      created_at TIMESTAMPTZ

    )

  `);

  await pool.query(`

    CREATE TABLE IF NOT EXISTS clock_requests (

      id SERIAL PRIMARY KEY,

      line_user_id TEXT,

      name TEXT,

      clock_type TEXT,

      clock_time TIMESTAMPTZ,

      reason TEXT,

      status TEXT DEFAULT '待審核',

      created_at TIMESTAMPTZ

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

  await pool.query(`

    CREATE TABLE IF NOT EXISTS rules (

      id SERIAL PRIMARY KEY,

      work_start TEXT DEFAULT '08:00',

      work_end TEXT DEFAULT '17:00',

      break_hours REAL DEFAULT 1,

      overtime_start TEXT DEFAULT '17:30'

    )

  `);

  await safeQuery(`

    ALTER TABLE attendance

    ALTER COLUMN clock_time TYPE TIMESTAMPTZ

    USING NULLIF(clock_time::text, '')::timestamptz

  `, "attendance.clock_time 已是正確格式或無法轉換");

  await safeQuery(`

    ALTER TABLE leaves

    ALTER COLUMN start_date TYPE DATE

    USING NULLIF(start_date::text, '')::date

  `, "leaves.start_date 已是正確格式或無法轉換");

  await safeQuery(`

    ALTER TABLE leaves

    ALTER COLUMN end_date TYPE DATE

    USING NULLIF(end_date::text, '')::date

  `, "leaves.end_date 已是正確格式或無法轉換");

  await safeQuery(`

    ALTER TABLE leaves

    ALTER COLUMN created_at TYPE TIMESTAMPTZ

    USING NULLIF(created_at::text, '')::timestamptz

  `, "leaves.created_at 已是正確格式或無法轉換");

  await safeQuery(`

    ALTER TABLE clock_requests

    ALTER COLUMN clock_time TYPE TIMESTAMPTZ

    USING NULLIF(clock_time::text, '')::timestamptz

  `, "clock_requests.clock_time 已是正確格式或無法轉換");

  await safeQuery(`

    ALTER TABLE clock_requests

    ALTER COLUMN created_at TYPE TIMESTAMPTZ

    USING NULLIF(created_at::text, '')::timestamptz

  `, "clock_requests.created_at 已是正確格式或無法轉換");

  const settings = await pool.query("SELECT * FROM settings LIMIT 1");

  if (settings.rows.length === 0) {

    await pool.query(`

      INSERT INTO settings

      (gps_enabled, company_lat, company_lng, gps_radius)

      VALUES (1, 24.7906, 120.9969, 300)

    `);

  }

  const rules = await pool.query("SELECT * FROM rules LIMIT 1");

  if (rules.rows.length === 0) {

    await pool.query(`

      INSERT INTO rules

      (work_start, work_end, break_hours, overtime_start)

      VALUES ('08:00', '17:00', 1, '17:30')

    `);

  }

  console.log("✅ PostgreSQL Tables Ready");

}

pool.query("SELECT 1")

  .then(() => {

    console.log("✅ PostgreSQL Connected");

    return createTables();

  })

  .catch(err => {

    console.error("❌ PostgreSQL Error:", err);

  });

// =========================

// LINE 推播

// =========================

async function pushLineMessage(userId, text) {

  if (!LINE_CHANNEL_ACCESS_TOKEN || !userId) {

    console.log("LINE通知未設定");

    return;

  }

  try {

    const response = await fetch("https://api.line.me/v2/bot/message/push", {

      method: "POST",

      headers: {

        "Content-Type": "application/json",

        Authorization: "Bearer " + LINE_CHANNEL_ACCESS_TOKEN

      },

      body: JSON.stringify({

        to: userId,

        messages: [{ type: "text", text }]

      })

    });

    const result = await response.text();

    console.log("LINE通知結果：", result);

  } catch (err) {

    console.error("LINE通知失敗：", err);

  }

}

// =========================

// 工具函式

// =========================

function calculateDistance(lat1, lng1, lat2, lng2) {

  const R = 6371000;

  const toRad = value => value * Math.PI / 180;

  const dLat = toRad(lat2 - lat1);

  const dLng = toRad(lng2 - lng1);

  const a =

    Math.sin(dLat / 2) ** 2 +

    Math.cos(toRad(lat1)) *

    Math.cos(toRad(lat2)) *

    Math.sin(dLng / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

}

function getTaiwanDateString(date = new Date()) {

  const formatter = new Intl.DateTimeFormat("zh-TW", {

    timeZone: "Asia/Taipei",

    year: "numeric",

    month: "2-digit",

    day: "2-digit"

  });

  return formatter.format(date).replace(/\//g, "-");

}

function getTaiwanHour() {

  const formatter = new Intl.DateTimeFormat("zh-TW", {

    timeZone: "Asia/Taipei",

    hour: "numeric",

    hour12: false

  });

  return parseInt(formatter.format(new Date()), 10);

}

function getTaiwanTimeString(date = new Date()) {

  return date.toLocaleString("zh-TW", {

    timeZone: "Asia/Taipei"

  });

}

// =========================

// 打卡 API

// =========================

app.post("/api/clock", async (req, res) => {

  const { lineUserId, name, type, latitude, longitude } = req.body;

  if (!lineUserId || !name || !type) {

    return res.status(400).json({

      success: false,

      message: "缺少打卡資料"

    });

  }

  if (type !== "上班" && type !== "下班") {

    return res.status(400).json({

      success: false,

      message: "打卡類型錯誤"

    });

  }

  try {

    const currentHour = getTaiwanHour();

    if (currentHour < 8) {

      return res.status(403).json({

        success: false,

        message: "打卡時間未開始（08:00後才能打卡）"

      });

    }

    const todayStr = getTaiwanDateString();

    const employeeResult = await pool.query(

      "SELECT * FROM employees WHERE line_user_id = $1 LIMIT 1",

      [lineUserId]

    );

    if (employeeResult.rows.length > 0) {

      const employee = employeeResult.rows[0];

      if (employee.status === "離職") {

        return res.status(403).json({

          success: false,

          message: "離職員工無法打卡"

        });

      }

    }

    const leaveResult = await pool.query(

      `

      SELECT *

      FROM leaves

      WHERE line_user_id = $1

      AND status IN ('核准', '已核准')

      AND $2::date BETWEEN start_date AND end_date

      `,

      [lineUserId, todayStr]

    );

    if (leaveResult.rows.length > 0) {

      const leave = leaveResult.rows[0];

      return res.status(403).json({

        success: false,

        message: `您今日已請假（${leave.leave_type}），無法打卡`

      });

    }

    const recordsResult = await pool.query(

      `

      SELECT *

      FROM attendance

      WHERE line_user_id = $1

      AND (clock_time AT TIME ZONE 'Asia/Taipei')::date = $2::date

      ORDER BY clock_time ASC

      `,

      [lineUserId, todayStr]

    );

    const todayRecords = recordsResult.rows;

    if (todayRecords.some(item => item.type === type)) {

      return res.status(400).json({

        success: false,

        message: `今天已經完成「${type}」打卡，請勿重複打卡`

      });

    }

    if (type === "下班") {

      const hasClockIn = todayRecords.some(item => item.type === "上班");

      if (!hasClockIn) {

        return res.status(400).json({

          success: false,

          message: "尚未上班打卡，不能下班打卡"

        });

      }

    }

    const settingResult = await pool.query("SELECT * FROM settings LIMIT 1");

    const gpsSetting = settingResult.rows[0];

    const userLat = Number(latitude);

    const userLng = Number(longitude);

    let distance = null;

    if (gpsSetting && Number(gpsSetting.gps_enabled) === 1) {

      if (!latitude || !longitude || isNaN(userLat) || isNaN(userLng)) {

        return res.status(400).json({

          success: false,

          message: "無法取得定位，請開啟GPS後再打卡"

        });

      }

      distance = calculateDistance(

        Number(gpsSetting.company_lat),

        Number(gpsSetting.company_lng),

        userLat,

        userLng

      );

      if (distance > Number(gpsSetting.gps_radius)) {

        return res.status(403).json({

          success: false,

          message: `不在公司範圍內，無法打卡。目前距離約 ${Math.round(distance)} 公尺`

        });

      }

    }

    const now = new Date();

    await pool.query(

      `

      INSERT INTO attendance

      (line_user_id, name, type, clock_time, latitude, longitude)

      VALUES ($1, $2, $3, $4, $5, $6)

      `,

      [lineUserId, name, type, now, latitude || null, longitude || null]

    );

    const timeText = getTaiwanTimeString(now);

    await pushLineMessage(
  lineUserId,
`✅ 打卡成功

員工：${name}
類型：${type}
時間：${timeText}

狀態：已完成打卡`
);

await pushLineMessage(
  MANAGER_LINE_USER_ID,
`📍 員工打卡通知

員工：${name}
類型：${type}
時間：${timeText}

距離公司：
${distance === null ? "未啟用GPS限制" : Math.round(distance) + " 公尺"}`
);