const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function createTables() {

await pool.query(`
ALTER TABLE employees
ADD COLUMN IF NOT EXISTS bind_code VARCHAR(50)
`);

await pool.query(`
ALTER TABLE employees
ADD COLUMN IF NOT EXISTS bind_status VARCHAR(20) DEFAULT '未綁定'
`);

await pool.query(`
ALTER TABLE employees
ADD COLUMN IF NOT EXISTS line_display_name VARCHAR(100)
`);

await pool.query(`
ALTER TABLE employees
ADD COLUMN IF NOT EXISTS bound_at TIMESTAMP
`);

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

  await pool.query(`
    
    CREATE TABLE IF NOT EXISTS rules (
    
      id SERIAL PRIMARY KEY,

work_start TEXT DEFAULT '09:00',

work_end TEXT DEFAULT '18:00',

break_hours REAL DEFAULT 1,

overtime_start TEXT DEFAULT '18:30',

late_allowance INTEGER DEFAULT 10,

early_allowance INTEGER DEFAULT 5
    )
  `);
await pool.query(`
CREATE TABLE IF NOT EXISTS salary_history (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER,
  employee_name TEXT,
  salary_month TEXT,
  gross_salary REAL,
  net_salary REAL,
  created_at TIMESTAMP DEFAULT NOW()
)
`);

await pool.query(`
  ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS bind_code VARCHAR(50)
`);

await pool.query(`
  ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS bind_status VARCHAR(20) DEFAULT '未綁定'
`);

await pool.query(`
  ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS line_display_name VARCHAR(100)
`);

await pool.query(`
  ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS bound_at TIMESTAMP
`);

const settingResult = await pool.query(
  "SELECT * FROM settings LIMIT 1"
);

if (settingResult.rows.length === 0) {
  await pool.query(`
    INSERT INTO settings
    (gps_enabled, company_lat, company_lng, gps_radius)
    VALUES (1, 24.7906, 120.9969, 300)
  `);
}

const ruleResult = await pool.query(
  "SELECT * FROM rules LIMIT 1"
);

if (ruleResult.rows.length === 0) {
  await pool.query(`
    INSERT INTO rules
    (work_start, work_end, break_hours, overtime_start)
    VALUES ('09:00', '18:00', 1, '18:30')
  `);
}

await pool.query(`
  ALTER TABLE rules
  ADD COLUMN IF NOT EXISTS late_allowance INTEGER DEFAULT 0
`);

await pool.query(`
  ALTER TABLE rules
  ADD COLUMN IF NOT EXISTS early_allowance INTEGER DEFAULT 0
`);

await pool.query(`
CREATE TABLE IF NOT EXISTS holidays (
  id SERIAL PRIMARY KEY,
  holiday_date DATE NOT NULL UNIQUE,
  holiday_name VARCHAR(100) NOT NULL
)
`);

await pool.query(`
CREATE TABLE IF NOT EXISTS salary_history (
  id SERIAL PRIMARY KEY,
  line_user_id TEXT,
  year INTEGER,
  month INTEGER,
  gross_salary NUMERIC DEFAULT 0,
  net_salary NUMERIC DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
)
`);

await pool.query(`
ALTER TABLE salary_history
ADD COLUMN IF NOT EXISTS is_signed BOOLEAN DEFAULT false
`);

await pool.query(`
ALTER TABLE salary_history
ADD COLUMN IF NOT EXISTS signed_at TIMESTAMP
`);

await pool.query(`
ALTER TABLE attendance
ADD COLUMN IF NOT EXISTS address TEXT
`);

console.log("✅ PostgreSQL Tables Ready");
console.log("✅ Employee Bind Columns Ready");

}

pool.connect()
.then(() => {
  console.log("✅ PostgreSQL Connected");
  return createTables();
})
.catch(err => {
  console.error("❌ PostgreSQL Error:", err);
});
const LINE_CHANNEL_ACCESS_TOKEN =
process.env.LINE_CHANNEL_ACCESS_TOKEN;

const MANAGER_LINE_USER_ID =
process.env.MANAGER_LINE_USER_ID;


app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));



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
// 檢查是否為員工
// =========================

app.get("/api/check-employee/:lineUserId", async (req, res) => {
  try {
    const lineUserId = req.params.lineUserId;

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
        success:true,
        isEmployee:false,
        message:"不是員工"
      });
    }

    const emp = result.rows[0];

    res.json({
      success:true,
      isEmployee:true,
      employee:{
        id:emp.id,
        name:emp.name,
        department:emp.department,
        position:emp.position,
        line_user_id:emp.line_user_id
      }
    });

  } catch(err) {
    console.error("check employee error:", err);

    res.status(500).json({
      success:false,
      isEmployee:false,
      message:"員工身份檢查失敗"
    });
  }
});
// =========================
// 我的工時
// =========================

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
    console.error("my-worktime error:", err);

    res.status(500).json({
      success:false,
      message:"讀取工時失敗"
    });
  }
});
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

const dayOfWeek = taipeiNow.getDay();

if (dayOfWeek === 0) {
  return res.status(403).json({
    success:false,
    message:"星期日禁止打卡"
  });
}

  const currentHour =
  taipeiNow.getHours();

  if (currentHour < 8) {
    return res.status(403).json({
      success:false,
      message:"08:30後才能打卡"
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

// =========================
// 地址解析
// =========================
let address = "-";

if (
  latitude &&
  longitude &&
  !isNaN(userLat) &&
  !isNaN(userLng)
) {
  try {
    const geoRes =
    await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${userLat}&lon=${userLng}`,
      {
        headers:{
          "User-Agent":"line-attendance-system"
        }
      }
    );

    const geoData =
    await geoRes.json();

    address =
    geoData.display_name || "-";

  } catch(geoErr) {
    console.error("地址解析失敗:", geoErr.message);
    address = "-";
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
    longitude,
    address
  )
  VALUES
  ($1,$2,$3,$4,$5,$6,$7)
  `,
  [
    lineUserId,
    name,
    type,
    nowISO,
    latitude,
    longitude,
    address
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

位置：
${address}

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

位置：
${address}

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
  time: nowISO,
  address
});

} catch(err) {

  console.error(err);

  res.status(500).json({
    success: false,
    message: "打卡失敗，請稍後再試"
  });

}
});
// =========================
// 讀取全部打卡資料（每日合併版）
// =========================
app.get("/api/attendance", async (req, res) => {
  try {
    const {
      name,
      startDate,
      endDate
    } = req.query;

    let sql = `
      SELECT *
      FROM attendance
      WHERE 1 = 1
    `;

    const params = [];

    if (name) {
      params.push("%" + name + "%");
      sql += ` AND name ILIKE $${params.length}`;
    }

    if (startDate) {
      params.push(startDate);
      sql += `
        AND DATE(clock_time AT TIME ZONE 'Asia/Taipei')
        >= $${params.length}
      `;
    }

    if (endDate) {
      params.push(endDate);
      sql += `
        AND DATE(clock_time AT TIME ZONE 'Asia/Taipei')
        <= $${params.length}
      `;
    }

    sql += `
      ORDER BY clock_time ASC
    `;

    const result = await pool.query(sql, params);
    const rows = result.rows;

    const groups = {};

    function getTaipeiDate(value) {
      return new Date(value).toLocaleDateString("zh-TW", {
        timeZone:"Asia/Taipei",
        year:"numeric",
        month:"2-digit",
        day:"2-digit"
      });
    }

    function getWeekday(value) {
      const d = new Date(
        new Date(value).toLocaleString("en-US", {
          timeZone:"Asia/Taipei"
        })
      );

      const weekNames = [
        "星期日",
        "星期一",
        "星期二",
        "星期三",
        "星期四",
        "星期五",
        "星期六"
      ];

      return weekNames[d.getDay()];
    }

    rows.forEach(item => {
      const date = getTaipeiDate(item.clock_time);

      const key =
        `${item.line_user_id || item.name}_${date}`;

      if (!groups[key]) {
        groups[key] = {
          name:item.name || "-",
          line_user_id:item.line_user_id || "",
          date,
          weekday:getWeekday(item.clock_time),

          start_time:null,
          end_time:null,

          start_location:null,
          end_location:null,

          start_latitude:null,
          start_longitude:null,
          end_latitude:null,
          end_longitude:null
        };
      }

      const locationText =
        item.address ||
        item.location ||
        item.address_text ||
        item.location_text ||
        "-";

      if (item.type === "上班") {
        if (
          !groups[key].start_time ||
          new Date(item.clock_time) <
          new Date(groups[key].start_time)
        ) {
          groups[key].start_time = item.clock_time;
          groups[key].start_location = locationText;
          groups[key].start_latitude = item.latitude;
          groups[key].start_longitude = item.longitude;
        }
      }

      if (item.type === "下班") {
        if (
          !groups[key].end_time ||
          new Date(item.clock_time) >
          new Date(groups[key].end_time)
        ) {
          groups[key].end_time = item.clock_time;
          groups[key].end_location = locationText;
          groups[key].end_latitude = item.latitude;
          groups[key].end_longitude = item.longitude;
        }
      }
    });

    const finalRows =
      Object.values(groups).map(item => {
        let work_hours = null;

        if (item.start_time && item.end_time) {
          const rawHours =
(
  new Date(item.end_time) -
  new Date(item.start_time)
) / 1000 / 60 / 60;

const breakHours = 1;

const hours =
Math.max(0, rawHours - breakHours);

work_hours =
Number(hours.toFixed(2));
        }

        return {
          ...item,
          work_hours
        };
      });

    finalRows.sort((a,b) => {
      const at = new Date(a.end_time || a.start_time || 0).getTime();
      const bt = new Date(b.end_time || b.start_time || 0).getTime();

      return bt - at;
    });

    res.json(finalRows);

  } catch(err) {
    console.error("讀取打卡資料失敗:", err);

    res.status(500).json({
      success:false,
      message:"讀取打卡資料失敗"
    });
  }
});

// =========================
// 國定假日 API
// =========================

app.get("/api/holidays", async (req, res) => {

  try {

    const result = await pool.query(
      `
      SELECT *
      FROM holidays
      ORDER BY holiday_date ASC
      `
    );

    res.json(result.rows);

  } catch(err) {

    console.error(err);

    res.status(500).json({
      success:false,
      message:"讀取國定假日失敗"
    });

  }

});

// =========================
// 新增國定假日
// =========================

app.post("/api/holidays", async (req, res) => {

  try {

    const {
      holidayDate,
      holidayName
    } = req.body;

    await pool.query(
      `
      INSERT INTO holidays
      (
        holiday_date,
        holiday_name
      )
      VALUES
      ($1,$2)
      `,
      [
        holidayDate,
        holidayName
      ]
    );

    res.json({
      success:true,
      message:"新增成功"
    });

  } catch(err) {

    console.error(err);

    res.status(500).json({
      success:false,
      message:"新增失敗"
    });

  }

});

// =========================
// 刪除國定假日
// =========================

app.delete("/api/holidays/:id", async (req, res) => {

  try {

    const id = req.params.id;

    await pool.query(
      `
      DELETE FROM holidays
      WHERE id = $1
      `,
      [id]
    );

    res.json({
      success:true,
      message:"刪除成功"
    });

  } catch(err) {

    console.error(err);

    res.status(500).json({
      success:false,
      message:"刪除失敗"
    });

  }

});

// =========================
// 新增國定假日測試
// =========================

app.get("/api/add-holidays", async (req, res) => {

  try {

    await pool.query(`
      INSERT INTO holidays
      (holiday_date, holiday_name)
      VALUES
      ('2026-01-01','元旦'),
      ('2026-02-16','春節'),
      ('2026-02-17','春節'),
      ('2026-02-18','春節'),
      ('2026-02-19','春節'),
      ('2026-02-28','和平紀念日'),
      ('2026-04-04','兒童節'),
      ('2026-05-01','勞動節'),
      ('2026-06-19','端午節'),
      ('2026-09-25','中秋節'),
      ('2026-09-28','教師節'),
      ('2026-10-10','國慶日'),
      ('2026-12-25','行憲紀念日')
      ON CONFLICT DO NOTHING
    `);

    res.json({
      success:true,
      message:"國定假日已建立"
    });

  } catch(err) {

    console.error(err);

    res.status(500).json({
      success:false,
      message:"建立失敗"
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

  if (!lineUserId || !name || !leaveType || !startDate || !endDate) {
    return res.status(400).json({
      success: false,
      message: "請假資料不完整"
    });
  }

  try {
    const now = new Date().toISOString();

    await pool.query(
      `
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
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `,
      [
        lineUserId,
        name,
        leaveType,
        startDate,
        endDate,
        reason || "",
        "待審核",
        now
      ]
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
${reason || "-"}

請至後台審核：
https://line-attendance-blt1.onrender.com/leave-admin.html`
    );

    res.json({
      success: true,
      message: "請假申請已送出"
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: "請假送出失敗"
    });
  }
});

app.get("/api/leaves", async (req, res) => {
  try {
    const result = await pool.query(
  `
  SELECT
    l.*,
    COALESCE(e.name, l.name) AS name,
    e.department,
    e.position
  FROM leaves l
  LEFT JOIN employees e
    ON e.line_user_id = l.line_user_id
  ORDER BY l.id DESC
  `
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
// 刪除請假紀錄
// =========================

app.delete("/api/leaves/:id", async (req,res)=>{
  try{
    await pool.query(
      `
      DELETE FROM leaves
      WHERE id = $1
      `,
      [req.params.id]
    );

    res.json({
      success:true,
      message:"請假紀錄已刪除"
    });

  }catch(err){
    console.error(err);

    res.status(500).json({
      success:false,
      message:"刪除失敗"
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

  try {
    const leaveResult = await pool.query(
      "SELECT * FROM leaves WHERE id = $1",
      [id]
    );

    if (leaveResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "找不到請假資料"
      });
    }

    const leave = leaveResult.rows[0];

    await pool.query(
      `
      UPDATE leaves
      SET status = $1
      WHERE id = $2
      `,
      [status, id]
    );

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

  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: "請假狀態更新失敗"
    });
  }
});


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
    transportAllowance,
    performanceBonus
  } = req.body;

  if (!name) {
    return res.status(400).json({
      success:false,
      message:"請輸入員工姓名"
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
        Number(transportAllowance || 3000),
        Number(performanceBonus || 0),
        "在職"
      ]
    );

    res.json({
      success:true,
      message:"員工已新增"
    });

  } catch(err) {
    console.error(err);

    res.status(500).json({
      success:false,
      message:"新增員工失敗"
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
      success:false,
      message:"讀取員工資料失敗"
    });
  }
});

app.post("/api/employees/status", async (req, res) => {
  const {
    id,
    status
  } = req.body;

  try {
    await pool.query(
      `
      UPDATE employees
      SET status = $1
      WHERE id = $2
      `,
      [
        status,
        id
      ]
    );

    res.json({
      success:true,
      message:"員工狀態已更新"
    });

  } catch(err) {
    console.error(err);

    res.status(500).json({
      success:false,
      message:"員工狀態更新失敗"
    });
  }
});

// =========================
// 修改員工資料
// =========================

app.put("/api/employees/:id", async(req,res)=>{
  try{
    const {id} = req.params;

    const {
      name,
      department,
      position,
      base_salary,
      fixed_allowance,
      transport_allowance,
      performance_bonus
    } = req.body;

    await pool.query(
      `
      UPDATE employees
      SET
        name = $1,
        department = $2,
        position = $3,
        base_salary = $4,
        fixed_allowance = $5,
        attendance_bonus = $6,
        performance_bonus = $7
      WHERE id = $8
      `,
      [
        name,
        department,
        position,
        Number(base_salary || 0),
        Number(fixed_allowance || 0),
        Number(transport_allowance || 0),
        Number(performance_bonus || 0),
        id
      ]
    );

    res.json({
      success:true,
      message:"員工資料已修改"
    });

  }catch(err){
    console.error(err);

    res.status(500).json({
      success:false,
      message:"修改員工失敗"
    });
  }
});

// =========================
// 刪除員工
// =========================

app.delete("/api/employees/:id", async(req,res)=>{
  try{
    const {id} = req.params;

    await pool.query(
      "DELETE FROM employees WHERE id = $1",
      [id]
    );

    res.json({
      success:true,
      message:"員工已刪除"
    });

  }catch(err){
    console.error(err);

    res.status(500).json({
      success:false,
      message:"刪除員工失敗"
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

app.get("/api/settings", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM settings ORDER BY id ASC LIMIT 1"
    );

    res.json(result.rows[0]);

  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: "讀取GPS設定失敗"
    });
  }
});

app.post("/api/settings", async (req, res) => {
  const {
    gps_enabled,
    company_lat,
    company_lng,
    gps_radius
  } = req.body;

  try {
    const exists = await pool.query(
      "SELECT * FROM settings ORDER BY id ASC LIMIT 1"
    );

    if (exists.rows.length === 0) {
      await pool.query(
        `
        INSERT INTO settings
        (gps_enabled, company_lat, company_lng, gps_radius)
        VALUES ($1,$2,$3,$4)
        `,
        [
          Number(gps_enabled),
          Number(company_lat),
          Number(company_lng),
          Number(gps_radius)
        ]
      );
    } else {
      await pool.query(
        `
        UPDATE settings
        SET
          gps_enabled = $1,
          company_lat = $2,
          company_lng = $3,
          gps_radius = $4
        WHERE id = $5
        `,
        [
          Number(gps_enabled),
          Number(company_lat),
          Number(company_lng),
          Number(gps_radius),
          exists.rows[0].id
        ]
      );
    }

    res.json({
      success: true,
      message: "GPS設定已儲存"
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: "GPS設定儲存失敗"
    });
  }
});

// =========================
// 匯出月薪總表 CSV
// 自動扣除出勤規則的休息時數
// =========================

app.get("/api/export-monthly", async (req, res) => {
  try {
    const attendanceResult = await pool.query(
      "SELECT * FROM attendance ORDER BY id ASC"
    );

    const employeesResult = await pool.query(
      "SELECT * FROM employees"
    );

    const ruleResult = await pool.query(
      "SELECT * FROM rules ORDER BY id ASC LIMIT 1"
    );

    const attendance = attendanceResult.rows;
    const employees = employeesResult.rows;
    const rule = ruleResult.rows[0] || {};

    const breakHours =
      Number(rule.break_hours || 0);

    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();

    const dayGroups = {};

    attendance.forEach(item => {
      const d = new Date(item.clock_time);

      const taipeiDate = new Date(
        d.toLocaleString("en-US", {
          timeZone: "Asia/Taipei"
        })
      );

      if (
        taipeiDate.getFullYear() !== year ||
        taipeiDate.getMonth() !== month
      ) {
        return;
      }

      const date = d.toLocaleDateString("zh-TW", {
        timeZone: "Asia/Taipei"
      });

      const key =
        item.line_user_id + "_" + date;

      if (!dayGroups[key]) {
        dayGroups[key] = {
          line_user_id: item.line_user_id,
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
          dayGroups[key].start =
            item.clock_time;
        }
      }

      if (item.type === "下班") {
        if (
          !dayGroups[key].end ||
          new Date(item.clock_time) >
          new Date(dayGroups[key].end)
        ) {
          dayGroups[key].end =
            item.clock_time;
        }
      }
    });

    const monthly = {};

    Object.values(dayGroups).forEach(day => {
      const key =
        day.line_user_id || day.name;

      if (!monthly[key]) {
        monthly[key] = {
          name: day.name,
          line_user_id: day.line_user_id,
          hours: 0,
          workDays: 0
        };
      }

      if (day.start && day.end) {
        const totalHours =
          (new Date(day.end) - new Date(day.start)) /
          1000 / 60 / 60;

        const workHours =
          Math.max(
            0,
            totalHours - breakHours
          );

        monthly[key].hours += workHours;
        monthly[key].workDays++;
      }
    });

    let csv =
      "\uFEFF員工,本月出勤天數,休息時數,本月實際工時,時薪,預估薪資\n";

    Object.values(monthly).forEach(item => {
      const emp = employees.find(e =>
        e.line_user_id === item.line_user_id ||
        e.name === item.name
      );

      const wage =
        emp ? Number(emp.hourly_wage || 200) : 200;

      const salary =
        Math.round(item.hours * wage);

      csv +=
        `${item.name},${item.workDays},${breakHours},${item.hours.toFixed(2)},${wage},${salary}\n`;
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

  } catch (err) {
    console.error("匯出月薪總表失敗:", err);

    res.status(500).send("匯出失敗");
  }
});

// =========================
// 薪資總表 API
// =========================

app.get("/api/salary-report", async (req, res) => {
  try {
    const employeesResult = await pool.query(
      "SELECT * FROM employees WHERE status = '在職' ORDER BY id DESC"
    );

    const result = [];

    for (const emp of employeesResult.rows) {
      if (!emp.line_user_id) {
        continue;
      }

      const salaryRes = await fetch(
        `https://line-attendance-blt1.onrender.com/api/my-salary/${emp.line_user_id}`
      );

      const salary = await salaryRes.json();

      if (salary.success) {
        result.push(salary);
      }
    }

    res.json(result);

  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: "讀取薪資總表失敗"
    });
  }
});

// =========================
// 出勤規則設定
// =========================

app.get("/api/rules", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM rules ORDER BY id ASC LIMIT 1"
    );

    if (result.rows.length === 0) {
      const insert = await pool.query(
        `
        INSERT INTO rules
        (
          work_start,
          work_end,
          break_hours,
          overtime_start,
          late_allowance,
          early_allowance
        )
        VALUES
        ($1,$2,$3,$4,$5,$6)
        RETURNING *
        `,
        ["09:00", "18:00", 1, "18:30", 0, 0]
      );

      return res.json({
        success:true,
        rules:insert.rows[0]
      });
    }

    res.json({
      success:true,
      rules:result.rows[0]
    });

  } catch(err) {
    console.error("讀取出勤規則失敗:", err);

    res.status(500).json({
      success:false,
      message:"讀取出勤規則失敗"
    });
  }
});


app.post("/api/rules", async (req, res) => {
  try {
    const body = req.body;

    const work_start =
      body.work_start || body.workStart || "09:00";

    const work_end =
      body.work_end || body.workEnd || "18:00";

    const break_hours =
      Number(body.break_hours ?? body.breakHours ?? 1);

    const overtime_start =
      body.overtime_start || body.overtimeStart || "18:30";

    const late_allowance =
      Number(body.late_allowance ?? body.lateAllowance ?? 0);

    const early_allowance =
      Number(body.early_allowance ?? body.earlyAllowance ?? 0);

    const exists = await pool.query(
      "SELECT * FROM rules ORDER BY id ASC LIMIT 1"
    );

    let saved;

    if (exists.rows.length === 0) {
      const result = await pool.query(
        `
        INSERT INTO rules
        (
          work_start,
          work_end,
          break_hours,
          overtime_start,
          late_allowance,
          early_allowance
        )
        VALUES
        ($1,$2,$3,$4,$5,$6)
        RETURNING *
        `,
        [
          work_start,
          work_end,
          break_hours,
          overtime_start,
          late_allowance,
          early_allowance
        ]
      );

      saved = result.rows[0];

    } else {
      const result = await pool.query(
        `
        UPDATE rules
        SET
          work_start = $1,
          work_end = $2,
          break_hours = $3,
          overtime_start = $4,
          late_allowance = $5,
          early_allowance = $6
        WHERE id = $7
        RETURNING *
        `,
        [
          work_start,
          work_end,
          break_hours,
          overtime_start,
          late_allowance,
          early_allowance,
          exists.rows[0].id
        ]
      );

      saved = result.rows[0];
    }

    res.json({
      success:true,
      message:"出勤規則已儲存",
      rules:saved
    });

  } catch(err) {
    console.error("出勤規則儲存失敗:", err);

    res.status(500).json({
      success:false,
      message:"出勤規則儲存失敗",
      error:err.message
    });
  }
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
    success:true,
    message:"測試通知已送出",
    result:result
  });
});


// =========================
// 我的薪資 API
// =========================

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

    const ruleResult = await pool.query(
      "SELECT * FROM rules ORDER BY id ASC LIMIT 1"
    );

    const rule = ruleResult.rows[0] || {};

    const workStart = rule.work_start || "09:00";
    const workEnd = rule.work_end || "18:00";
    const breakHours = Number(rule.break_hours || 1);
    const lateAllowance = Number(rule.late_allowance || 0);
    const earlyAllowance = Number(rule.early_allowance || 0);

    const [workStartHour, workStartMinute] =
      workStart.split(":").map(Number);

    const [workEndHour, workEndMinute] =
      workEnd.split(":").map(Number);

    const ruleStartMinutes =
      workStartHour * 60 + workStartMinute + lateAllowance;

    const ruleEndMinutes =
      workEndHour * 60 + workEndMinute - earlyAllowance;

    const standardHours =
      Math.max(
        0,
        ((workEndHour * 60 + workEndMinute) -
        (workStartHour * 60 + workStartMinute)) / 60 -
        breakHours
      );

    const baseSalary = Number(emp.base_salary || 27000);
    const fixedAllowance = Number(emp.fixed_allowance || 3000);
    const transportAllowance = 3000;
    const performanceBonus = Number(emp.performance_bonus || 0);

    let lateCount = 0;
    let earlyLeaveCount = 0;

    let overtimePay = 0;
let restDayOvertimePay = 0;
let holidayOvertimePay = 0;

let overtimeDetails = [];

    let leaveDeduction = 0;
    let totalWorkHours = 0;
    let attendanceQualified = true;

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
      const date =
      new Date(item.clock_time)
      .toLocaleDateString("zh-TW", {
        timeZone:"Asia/Taipei"
      });

      if (!dayGroups[date]) {
        dayGroups[date] = {
          start:null,
          end:null
        };
      }

      if (item.type === "上班") {
        if (
          !dayGroups[date].start ||
          new Date(item.clock_time) <
          new Date(dayGroups[date].start)
        ) {
          dayGroups[date].start = item.clock_time;
        }
      }

      if (item.type === "下班") {
        if (
          !dayGroups[date].end ||
          new Date(item.clock_time) >
          new Date(dayGroups[date].end)
        ) {
          dayGroups[date].end = item.clock_time;
        }
      }
    });

    for (const day of Object.values(dayGroups)) {

  if (day.start && day.end) {

    const startTime = new Date(day.start);
    const endTime = new Date(day.end);

    const taipeiStart = new Date(
      startTime.toLocaleString("en-US", {
        timeZone:"Asia/Taipei"
      })
    );

    const dayOfWeek =
      taipeiStart.getDay();

    const weekNames = [
      "星期日",
      "星期一",
      "星期二",
      "星期三",
      "星期四",
      "星期五",
      "星期六"
    ];

    const weekDay =
      weekNames[dayOfWeek];

    const fullDate =
      taipeiStart.toLocaleDateString("zh-TW", {
        timeZone:"Asia/Taipei"
      });

    const isRestDay =
      dayOfWeek === 6;

    const isSunday =
      dayOfWeek === 0;

    const holidayDate =
      taipeiStart.getFullYear() + "-" +
      String(taipeiStart.getMonth() + 1).padStart(2, "0") + "-" +
      String(taipeiStart.getDate()).padStart(2, "0");

    const holidayResult =
      await pool.query(
        `
        SELECT *
        FROM holidays
        WHERE holiday_date = $1
        `,
        [holidayDate]
      );

    const isNationalHoliday =
      holidayResult.rows.length > 0;

    if (isSunday) {
      continue;
    }

    const startText =
      startTime.toLocaleTimeString("en-GB", {
        timeZone:"Asia/Taipei",
        hour12:false
      });

    const endText =
      endTime.toLocaleTimeString("en-GB", {
        timeZone:"Asia/Taipei",
        hour12:false
      });

    const [startHour, startMinute] =
      startText.split(":").map(Number);

    const [endHour, endMinute] =
      endText.split(":").map(Number);

    const startMinutes =
      startHour * 60 + startMinute;

    const endMinutes =
      endHour * 60 + endMinute;

    if (startMinutes > ruleStartMinutes) {
      lateCount++;
    }

    if (endMinutes < ruleEndMinutes) {
      earlyLeaveCount++;
    }

    const rawHours =
(end - start) / 1000 / 60 / 60;

const breakHours = 1;

const hours =
Math.max(0, rawHours - breakHours);

    const workHours =
      Math.max(
        0,
        totalHours - breakHours
      );

    if (workHours > 0) {
      totalWorkHours += workHours;
    }

    const monthlyRegularWage =
      baseSalary +
      fixedAllowance +
      transportAllowance;

    const hourlyRate =
      monthlyRegularWage / 30 / 8;

    if (isNationalHoliday) {

      const holidayName =
        holidayResult.rows[0].holiday_name || "國定假日";

      const first8Hours =
        Math.min(workHours, 8);

      const after8Hours =
        Math.max(0, workHours - 8);

      const holidayPay =
        first8Hours * hourlyRate * 2 +
        after8Hours * hourlyRate * 2.67;

      holidayOvertimePay += holidayPay;

      overtimeDetails.push({
        date: fullDate,
        weekday: weekDay,
        type: holidayName + "加班",
        hours: Number(workHours.toFixed(2)),
        pay: Math.round(holidayPay)
      });

    } else if (isRestDay) {

      const first2Hours =
        Math.min(workHours, 2);

      const after2Hours =
        Math.max(0, workHours - 2);

      const restPay =
        first2Hours * hourlyRate * 1.34 +
        after2Hours * hourlyRate * 1.67;

      restDayOvertimePay += restPay;

      overtimeDetails.push({
        date: fullDate,
        weekday: weekDay,
        type: "休息日加班",
        hours: Number(workHours.toFixed(2)),
        pay: Math.round(restPay)
      });

    } else {

      const overtimeHours =
        Math.max(
          0,
          workHours - standardHours
        );

      const first2Hours =
        Math.min(overtimeHours, 2);

      const after2Hours =
        Math.max(0, overtimeHours - 2);

      const normalPay =
        first2Hours * hourlyRate * 1.34 +
        after2Hours * hourlyRate * 1.67;

      overtimePay += normalPay;

      if (overtimeHours > 0) {

        overtimeDetails.push({
          date: fullDate,
          weekday: weekDay,
          type: "平日加班",
          hours: Number(overtimeHours.toFixed(2)),
          pay: Math.round(normalPay)
        });

      }

    }

  }

}

overtimePay =
  Math.round(overtimePay);

restDayOvertimePay =
  Math.round(restDayOvertimePay);

holidayOvertimePay =
  Math.round(holidayOvertimePay);

const leavesResult = await pool.query(
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

const dailySalary =
  baseSalary / 30;

leavesResult.rows.forEach(leave => {

  const start =
    new Date(leave.start_date);

  const end =
    new Date(leave.end_date);

  const days =
    Math.floor(
      (end - start) /
      (1000 * 60 * 60 * 24)
    ) + 1;

  switch (leave.leave_type) {

    case "事假":
      leaveDeduction +=
        dailySalary * days;
      break;

    case "病假":
      leaveDeduction +=
        dailySalary * 0.5 * days;
      break;

    case "曠職":
      leaveDeduction +=
        dailySalary * days;
      break;

    case "特休":
    case "公假":
      break;

  }

});

leaveDeduction =
  Math.round(leaveDeduction);

attendanceQualified =
  lateCount === 0 &&
  earlyLeaveCount === 0 &&
  leaveDeduction === 0;

const grossSalary =
  baseSalary +
  fixedAllowance +
  transportAllowance +
  performanceBonus +
  overtimePay +
  restDayOvertimePay +
  holidayOvertimePay;

const laborInsurance =
  Math.round(grossSalary * 0.02);

const healthInsurance =
  Math.round(grossSalary * 0.015);

const laborPension =
  Math.round(grossSalary * 0.06);

const netSalary =
  grossSalary -
  leaveDeduction -
  laborInsurance -
  healthInsurance;

res.json({
  success:true,

  employeeId:emp.id,

  name:emp.name,
  department:emp.department || "-",
  position:emp.position || "-",
  salaryMonth:new Date().toISOString().slice(0,7),

  workStart,
  workEnd,
  breakHours,
  lateAllowance,
  earlyAllowance,

  totalWorkHours:Number(totalWorkHours.toFixed(2)),

  baseSalary,
  fixedAllowance,
  transportAllowance,
  attendanceBonus:transportAllowance,
  performanceBonus,

  overtimePay,
  restDayOvertimePay,
  holidayOvertimePay,
  leaveDeduction,

  lateCount,
  earlyLeaveCount,
  attendanceQualified,

  grossSalary,
  laborInsurance,
  healthInsurance,
  laborPension,
  netSalary,

  overtimeDetails
});

  } catch(err) {
    console.error(err);

    res.status(500).json({
      success:false,
      message:"讀取薪資失敗"
    });
  }
});
// =========================

// PDF 產生 API - 企業版薪資單

// =========================

app.get("/api/payslip/:id", async (req, res) => {

  try {

    const employeeId = req.params.id;

    const empResult = await pool.query(

      `

      SELECT *

      FROM employees

      WHERE id = $1

      LIMIT 1

      `,

      [employeeId]

    );

    if (empResult.rows.length === 0) {

      return res.status(404).send("找不到員工");

    }

    const emp = empResult.rows[0];

    if (!emp.line_user_id) {

      return res.status(400).send("此員工尚未綁定 LINE，無法產生薪資單");

    }

    const baseUrl =

      process.env.BASE_URL ||

      "https://line-attendance-blt1.onrender.com";

    const salaryRes = await fetch(

      `${baseUrl}/api/my-salary/${emp.line_user_id}`

    );

    const salary = await salaryRes.json();

    if (!salary.success) {

      return res.status(500).send("薪資資料讀取失敗");

    }

    const fontPath = path.join(

      __dirname,

      "public",

      "fonts",

      "NotoSansTC-Regular.ttf"

    );

    if (!fs.existsSync(fontPath)) {

      return res.status(500).send("缺少中文字型");

    }

    const logoPath = path.join(

      __dirname,

      "public",

      "images",

      "logo.jpg"

    );

    const doc = new PDFDocument({

      size: "A4",

      margin: 45

    });

    doc.font(fontPath);

    const filename =

      `payslip_${salary.name || emp.name}.pdf`;

    res.setHeader("Content-Type", "application/pdf");

    res.setHeader(

      "Content-Disposition",

      `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`

    );

    doc.pipe(res);

    const money = value =>

      "NT$ " + Number(value || 0).toLocaleString("zh-TW");

    const line = y => {

      doc.moveTo(45, y)

        .lineTo(550, y)

        .strokeColor("#999")

        .lineWidth(1)

        .stroke();

    };

    const row = (label, value, x, y) => {

      doc.fontSize(11)

        .fillColor("#111")

        .text(label, x, y);

      doc.fontSize(11)

        .fillColor("#111")

        .text(money(value), x + 155, y, {

          width: 90,

          align: "right"

        });

    };

// =========================
// 薪資單簽收
// =========================
app.post("/api/sign-salary/:id", async (req, res) => {
  try {

    const salaryId = req.params.id;

    await pool.query(
      `
      UPDATE salary_history
      SET
        is_signed = true,
        signed_at = NOW()
      WHERE id = $1
      `,
      [salaryId]
    );

    res.json({
      success:true,
      message:"薪資單已簽收"
    });

  } catch(err) {

    console.error(err);

    res.status(500).json({
      success:false,
      message:"簽收失敗"
    });

  }
});

    // =========================

    // 第一頁：頁首

    // =========================

    try {

      if (fs.existsSync(logoPath)) {

        doc.image(logoPath, 50, 40, {

          fit: [180, 90]

        });

      }

    } catch (logoErr) {

      console.error("LOGO ERROR:", logoErr.message);

    }

    doc.fontSize(28)

      .fillColor("#111")

      .text("薪 資 單", 300, 55, {

        align: "center"

      });

    doc.fontSize(13)

      .fillColor("#333")

      .text("AURUM HOUSE", 300, 95, {

        align: "center"

      });

    doc.moveDown(1);

    // =========================

    // 員工資料

    // =========================

    let y = 140;

    doc.fontSize(12).fillColor("#111");

    doc.text(`員工姓名：${salary.name || "-"}`, 45, y);

    doc.text(`部門：${salary.department || "-"}`, 45, y + 22);

    doc.text(`職稱：${salary.position || "-"}`, 45, y + 44);

    doc.text(`月份：${new Date().getFullYear()} / ${new Date().getMonth() + 1}`, 45, y + 66);

    line(235);

    // =========================

    // 雙欄薪資明細

    // =========================

    y = 260;

    doc.fontSize(16)

      .fillColor("#111")

      .text("應發項目", 45, y);

    doc.fontSize(16)

      .fillColor("#111")

      .text("扣除項目", 315, y);

    y += 35;

    row("底薪", salary.baseSalary, 45, y);

    row("請假扣款", salary.leaveDeduction, 315, y);

    y += 25;

    row("固定津貼", salary.fixedAllowance, 45, y);

    row("勞保", salary.laborInsurance, 315, y);

    y += 25;

    row("交通津貼", salary.transportAllowance, 45, y);

    row("健保", salary.healthInsurance, 315, y);

    y += 25;

    row("平日加班費", salary.overtimePay, 45, y);

    row("勞退提繳", salary.laborPension, 315, y);

    y += 25;

    row("休息日加班費", salary.restDayOvertimePay, 45, y);

    y += 25;

    row("假日加班費", salary.holidayOvertimePay, 45, y);

    y += 25;

    row("績效獎金", salary.performanceBonus, 45, y);

    line(485);

    // =========================

    // 薪資合計

    // =========================

    doc.fontSize(18)

      .fillColor("#111")

      .text(

        `應發薪資：${money(salary.grossSalary)}`,

        45,

        515

      );

    doc.fontSize(22)

      .fillColor("#0d47a1")

      .text(

        `實發薪資：${money(salary.netSalary)}`,

        300,

        560,

        {

          align: "right"

        }

      );

    doc.fontSize(9)

      .fillColor("#333")

      .text(

        "備註：勞退提繳為公司提繳，不自薪資扣除。本薪資單為系統自動產生，實際金額仍以公司核定為準。",

        45,

        650

      );

    // =========================

    // 第二頁：加班明細表格

    // =========================

    if (

      salary.overtimeDetails &&

      salary.overtimeDetails.length > 0

    ) {

      doc.addPage();

doc.y = 80;

      doc.fontSize(22)

        .fillColor("#111")

        .text("加班明細", {

          align: "center"

        });

      let tableY = 130;

      const headers = ["日期", "星期", "類型", "時數", "加班費"];

      const widths = [100, 70, 160, 70, 100];

      const xs = [45, 145, 215, 375, 445];

      doc.rect(45, tableY, 500, 30)

        .fill("#f1f1f1");

      doc.fillColor("#111").fontSize(11);

      headers.forEach((h, i) => {

        doc.text(h, xs[i], tableY + 8, {

          width: widths[i],

          align: "center"

        });

      });

      tableY += 30;

      salary.overtimeDetails.forEach(item => {

        doc.rect(45, tableY, 500, 32)

          .strokeColor("#ccc")

          .stroke();

        doc.fillColor("#111").fontSize(10);

        doc.text(item.date, xs[0], tableY + 9, {

          width: widths[0],

          align: "center"

        });

        doc.text(item.weekday, xs[1], tableY + 9, {

          width: widths[1],

          align: "center"

        });

        doc.text(item.type, xs[2], tableY + 9, {

          width: widths[2],

          align: "center"

        });

        doc.text(`${item.hours} 小時`, xs[3], tableY + 9, {

          width: widths[3],

          align: "center"

        });

        doc.text(

          Number(item.pay || 0).toLocaleString("zh-TW"),

          xs[4],

          tableY + 9,

          {

            width: widths[4],

            align: "center"

          }

        );

        tableY += 32;

      });

      doc.fontSize(9)

        .fillColor("#333")

        .text(

          "備註：本頁為加班費計算明細，實際給付仍以公司核定為準。",

          45,

          tableY + 30

        );

    }

    doc.end();

  } catch (err) {

    console.error("PDF ERROR:", err);

    if (!res.headersSent) {

      res.status(500).send("薪資單產生失敗：" + err.message);

    }

  }

});
// =========================
// 月結薪資
// =========================

app.post("/api/salary-close", async (req, res) => {
  try {
    const employees = await pool.query(
      "SELECT * FROM employees WHERE status='在職'"
    );

    const salaryMonth =
      req.body.salaryMonth || new Date().toISOString().slice(0, 7);

    for (const emp of employees.rows) {
      if (!emp.line_user_id) {
        continue;
      }

      const salaryRes = await fetch(
        `https://line-attendance-blt1.onrender.com/api/my-salary/${emp.line_user_id}`
      );

      const salary = await salaryRes.json();

      if (!salary.success) {
        continue;
      }

      const exists = await pool.query(
        `
        SELECT *
        FROM salary_history
        WHERE employee_id = $1
        AND salary_month = $2
        `,
        [
          emp.id,
          salaryMonth
        ]
      );

      if (exists.rows.length > 0) {
        await pool.query(
          `
          UPDATE salary_history
          SET
            employee_name = $1,
            gross_salary = $2,
            net_salary = $3,
            created_at = NOW()
          WHERE employee_id = $4
          AND salary_month = $5
          `,
          [
            emp.name,
            salary.grossSalary,
            salary.netSalary,
            emp.id,
            salaryMonth
          ]
        );
      } else {
        await pool.query(
          `
          INSERT INTO salary_history
          (
            employee_id,
            employee_name,
            salary_month,
            gross_salary,
            net_salary
          )
          VALUES
          ($1,$2,$3,$4,$5)
          `,
          [
            emp.id,
            emp.name,
            salaryMonth,
            salary.grossSalary,
            salary.netSalary
          ]
        );
      }

      await pushLineMessage(
        emp.line_user_id,
`💰 薪資結算通知

員工：${emp.name}
月份：${salaryMonth}

應發薪資：
NT$${Number(salary.grossSalary || 0).toLocaleString("zh-TW")}

實發薪資：
NT$${Number(salary.netSalary || 0).toLocaleString("zh-TW")}

請至系統查看薪資單`
      );
    }

    res.json({
      success:true,
      message:"薪資結算完成，已更新薪資歷史"
    });

  } catch(err) {
    console.error(err);

    res.status(500).json({
      success:false,
      message:"薪資結算失敗"
    });
  }
});


// =========================
// 薪資歷史
// =========================

app.get("/api/salary-history", async (req, res) => {
  try {
    const { month, name } = req.query;

    let sql = `
      SELECT *
      FROM salary_history
      WHERE 1 = 1
    `;

    const params = [];

    if (month) {
      params.push(month);
      sql += ` AND salary_month = $${params.length}`;
    }

    if (name) {
      params.push("%" + name + "%");
      sql += ` AND employee_name ILIKE $${params.length}`;
    }

    sql += " ORDER BY id DESC";

    const result = await pool.query(sql, params);

    res.json(result.rows);

  } catch(err) {
    console.error(err);

    res.status(500).json({
      success:false,
      message:"讀取薪資歷史失敗"
    });
  }
});
// =========================
// 員工薪資歷史查詢
// =========================
app.get("/api/my-salary-history/:lineUserId", async (req, res) => {
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

    const result = await pool.query(
      `
      SELECT *
      FROM salary_history
      WHERE employee_id = $1
      ORDER BY salary_month DESC
      `,
      [emp.id]
    );

    const rows = result.rows.map(item => {
      let year = item.year;
      let month = item.month;

      if ((!year || !month) && item.salary_month) {
        const parts = String(item.salary_month).split("-");
        year = Number(parts[0]);
        month = Number(parts[1]);
      }

      return {
        ...item,
        year,
        month
      };
    });

    res.json({
      success:true,
      employee:emp.name,
      employeeId:emp.id,
      data:rows,
      rows:rows
    });

  } catch(err) {
    console.error(err);

    res.status(500).json({
      success:false,
      message:"讀取我的薪資歷史失敗"
    });
  }
});
// =========================
// 函式工具
// =========================
function taiwanLocalToUTC(value) {
  if (!value) return null;

  if (value.includes("+08:00")) {
    return new Date(value).toISOString();
  }

  if (value.endsWith("Z")) {
    return value;
  }

  return new Date(value + ":00+08:00").toISOString();
}
// =========================
// 補打卡申請
// =========================

app.post("/api/clock-request", async (req, res) => {
  try {
    const {
      lineUserId,
      name,
      clockType,
      clockTime,
      reason
    } = req.body;

    if (!lineUserId || !name || !clockType || !clockTime || !reason) {
      return res.status(400).json({
        success:false,
        message:"資料不完整"
      });
    }

    const fixedClockTime = taiwanLocalToUTC(clockTime);

    await pool.query(
      `
      INSERT INTO clock_requests
      (
        line_user_id,
        name,
        clock_type,
        clock_time,
        reason,
        status,
        created_at
      )
      VALUES
      ($1,$2,$3,$4,$5,$6,$7)
      `,
      [
        lineUserId,
        name,
        clockType,
        fixedClockTime,
        reason,
        "待審核",
        new Date().toISOString()
      ]
    );

    await pushLineMessage(
      MANAGER_LINE_USER_ID,
`🕒 新補打卡申請

員工：${name}
類型：${clockType}
時間：${clockTime}

原因：
${reason}

請至後台審核：
https://line-attendance-blt1.onrender.com/clock-request-admin.html`
    );

    res.json({
      success:true,
      message:"補打卡申請已送出"
    });

  } catch(err) {
    console.error(err);

    res.status(500).json({
      success:false,
      message:"補打卡申請失敗"
    });
  }
});

// =========================
// 讀取補打卡申請
// =========================

app.get("/api/clock-requests", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT *
      FROM clock_requests
      ORDER BY id DESC
      `
    );

    res.json(result.rows);

  } catch(err) {
    console.error(err);

    res.status(500).json({
      success:false,
      message:"讀取補打卡申請失敗"
    });
  }
});


// =========================
// 補打卡審核
// =========================
app.post("/api/clock-request/status", async (req, res) => {
  try {
    const { id, status } = req.body;

    if (!id || !status) {
      return res.status(400).json({
        success:false,
        message:"缺少補打卡ID或狀態"
      });
    }

    const requestResult = await pool.query(
      `
      SELECT *
      FROM clock_requests
      WHERE id = $1
      LIMIT 1
      `,
      [id]
    );

    if (requestResult.rows.length === 0) {
      return res.status(404).json({
        success:false,
        message:"找不到補打卡申請"
      });
    }

    const request = requestResult.rows[0];

    const clockType = String(request.clock_type || "").trim();

    if (clockType !== "上班" && clockType !== "下班") {
      return res.status(400).json({
        success:false,
        message:"補打卡類型錯誤：" + clockType
      });
    }

    await pool.query(
      `
      UPDATE clock_requests
      SET status = $1
      WHERE id = $2
      `,
      [status, id]
    );

    if (status === "已核准" || status === "核准") {
  const fixedClockTime = request.clock_time;

  const duplicate = await pool.query(
    `
    SELECT *
    FROM attendance
    WHERE line_user_id = $1
    AND type = $2
    AND clock_time = $3
    LIMIT 1
    `,
    [
      request.line_user_id,
      clockType,
      fixedClockTime
    ]
  );

      if (duplicate.rows.length === 0) {
        await pool.query(
          `
          INSERT INTO attendance
(
  line_user_id,
  name,
  type,
  clock_time,
  latitude,
  longitude,
  address
)
VALUES
($1,$2,$3,$4,$5,$6,$7)
          `,
          [
            request.line_user_id,
            request.name,
            clockType,
            fixedClockTime,
            null,
            null,
            null
          ]
        );
      }
    }

    await pushLineMessage(
      request.line_user_id,
`📢 補打卡審核結果

員工：${request.name}
類型：${clockType}
時間：${request.clock_time}

狀態：${status}`
    );

    res.json({
      success:true,
      message:"補打卡狀態已更新"
    });

  } catch(err) {
    console.error(err);

    res.status(500).json({
      success:false,
      message:"補打卡審核失敗"
    });
  }
});

app.delete("/api/attendance-admin/:id", async (req, res) => {
  try {
    await pool.query(
      `
      DELETE FROM attendance
      WHERE id = $1
      `,
      [req.params.id]
    );

    res.json({
      success:true,
      message:"出勤資料已刪除"
    });

  } catch(err) {
    console.error(err);

    res.status(500).json({
      success:false,
      message:"刪除出勤失敗"
    });
  }
});

// =========================
// 刪除補打卡申請
// =========================

app.delete("/api/clock-request/:id", async (req, res) => {
  try {

    await pool.query(
      `
      DELETE FROM clock_requests
      WHERE id = $1
      `,
      [req.params.id]
    );

    res.json({
      success:true,
      message:"補打卡申請已刪除"
    });

  } catch(err) {

    console.error(err);

    res.status(500).json({
      success:false,
      message:"刪除補打卡失敗"
    });

  }
});

// =========================
// 出勤管理
// =========================

app.get("/api/attendance-admin", async (req, res) => {
  try {
    const {
      name,
      type,
      startDate,
      endDate
    } = req.query;

    let sql = `
      SELECT *
      FROM attendance
      WHERE 1 = 1
    `;

    const params = [];

    if (name) {
      params.push("%" + name + "%");
      sql += ` AND name ILIKE $${params.length}`;
    }

    if (type) {
      params.push(type);
      sql += ` AND type = $${params.length}`;
    }

    if (startDate) {
      params.push(startDate);
      sql += `
        AND DATE(clock_time AT TIME ZONE 'Asia/Taipei')
        >= $${params.length}
      `;
    }

    if (endDate) {
      params.push(endDate);
      sql += `
        AND DATE(clock_time AT TIME ZONE 'Asia/Taipei')
        <= $${params.length}
      `;
    }

    sql += ` ORDER BY clock_time ASC`;

    const result = await pool.query(sql, params);

    const rows = result.rows;

    const groups = {};

    const getTaipeiDate = value => {
      return new Date(value).toLocaleDateString("zh-TW", {
        timeZone:"Asia/Taipei",
        year:"numeric",
        month:"2-digit",
        day:"2-digit"
      });
    };

    const getWeekday = value => {
      const d = new Date(
        new Date(value).toLocaleString("en-US", {
          timeZone:"Asia/Taipei"
        })
      );

      const weekNames = [
        "星期日",
        "星期一",
        "星期二",
        "星期三",
        "星期四",
        "星期五",
        "星期六"
      ];

      return weekNames[d.getDay()];
    };

    rows.forEach(item => {
      const date =
        getTaipeiDate(item.clock_time);

      const key =
        `${item.line_user_id || item.name}_${date}`;

      if (!groups[key]) {
        groups[key] = {
          name:item.name || "-",
          line_user_id:item.line_user_id || "",
          date,
          weekday:getWeekday(item.clock_time),
          start_id:null,
          end_id:null,
          start_time:null,
          end_time:null,
          start_raw:null,
          end_raw:null
        };
      }

      if (item.type === "上班") {
        if (
          !groups[key].start_raw ||
          new Date(item.clock_time) <
          new Date(groups[key].start_raw)
        ) {
          groups[key].start_id = item.id;
          groups[key].start_time = item.clock_time;
          groups[key].start_raw = item.clock_time;
        }
      }

      if (item.type === "下班") {
        if (
          !groups[key].end_raw ||
          new Date(item.clock_time) >
          new Date(groups[key].end_raw)
        ) {
          groups[key].end_id = item.id;
          groups[key].end_time = item.clock_time;
          groups[key].end_raw = item.clock_time;
        }
      }
    });

    const mergedRows =
      Object.values(groups).map(item => {
        let work_hours = null;

        if (item.start_raw && item.end_raw) {
          const start =
            new Date(item.start_raw);

          const end =
            new Date(item.end_raw);

          const rawHours =
  (end - start) / 1000 / 60 / 60;

const breakHours = 1;

const hours =
  Math.max(0, rawHours - breakHours);

work_hours =
  Number(hours.toFixed(2));
        }

        return {
          id:
            item.end_id ||
            item.start_id,

          name:item.name,
          line_user_id:item.line_user_id,

          date:item.date,
          weekday:item.weekday,

          start_id:item.start_id,
          end_id:item.end_id,

          start_time:item.start_time,
          end_time:item.end_time,

          work_hours
        };
      });

    mergedRows.sort((a,b)=>b.id - a.id);

    res.json(mergedRows);

  } catch(err) {
    console.error(err);

    res.status(500).json({
      success:false,
      message:"讀取出勤失敗"
    });
  }
});

// =========================
// 出勤管理 - 修改單筆出勤
// =========================
app.put("/api/attendance-admin/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const { type, clock_time } = req.body;

    if (!id) {
      return res.status(400).json({
        success:false,
        message:"缺少出勤ID"
      });
    }

    if (!type || !clock_time) {
      return res.status(400).json({
        success:false,
        message:"缺少出勤類型或時間"
      });
    }

    if (type !== "上班" && type !== "下班") {
      return res.status(400).json({
        success:false,
        message:"出勤類型只能是上班或下班"
      });
    }

    const parsedTime = new Date(clock_time);

    if (isNaN(parsedTime.getTime())) {
      return res.status(400).json({
        success:false,
        message:"時間格式錯誤：" + clock_time
      });
    }

    await pool.query(
      `
      UPDATE attendance
      SET type = $1,
          clock_time = $2
      WHERE id = $3
      `,
      [
        type,
        parsedTime.toISOString(),
        id
      ]
    );

    res.json({
      success:true,
      message:"出勤資料已修改"
    });

  } catch(err) {
    console.error("修改出勤失敗:", err);

    res.status(500).json({
      success:false,
      message:"修改出勤失敗：" + err.message
    });
  }
});

// =========================

// 出勤統計報表

// =========================

function getTaipeiMinutes(value) {

  const d = new Date(value);

  const parts = new Intl.DateTimeFormat("zh-TW", {

    timeZone: "Asia/Taipei",

    hour: "2-digit",

    minute: "2-digit",

    hour12: false

  }).formatToParts(d);

  const hour = Number(parts.find(p => p.type === "hour").value);

  const minute = Number(parts.find(p => p.type === "minute").value);

  return hour * 60 + minute;

}

function getTaipeiDate(value) {

  const d = new Date(value);

  return new Intl.DateTimeFormat("zh-TW", {

    timeZone: "Asia/Taipei",

    year: "numeric",

    month: "2-digit",

    day: "2-digit"

  }).format(d);

}

app.get("/api/attendance-report", async (req, res) => {

  try {

    const {

      name,

      department,

      startDate,

      endDate

    } = req.query;

    const rulesResult = await pool.query(

      "SELECT * FROM rules ORDER BY id ASC LIMIT 1"

    );

    const rules = rulesResult.rows[0] || {};

    const workStart = rules.work_start || "09:00";

    const workEnd = rules.work_end || "18:00";

    const breakHours = Number(rules.break_hours || 0);

    const lateAllowance = Number(rules.late_allowance || 0);

    const earlyAllowance = Number(rules.early_allowance || 0);

    const [startHour, startMinute] = workStart.split(":").map(Number);

    const [endHour, endMinute] = workEnd.split(":").map(Number);

    const ruleStartMinutes =

      startHour * 60 + startMinute + lateAllowance;

    const ruleEndMinutes =

      endHour * 60 + endMinute - earlyAllowance;

    let empSql = `

      SELECT *

      FROM employees

      WHERE status = '在職'

    `;

    const empParams = [];

    if (name) {

      empParams.push("%" + name + "%");

      empSql += ` AND name ILIKE $${empParams.length}`;

    }

    if (department) {

      empParams.push("%" + department + "%");

      empSql += ` AND department ILIKE $${empParams.length}`;

    }

    empSql += ` ORDER BY name`;

    const employees = await pool.query(empSql, empParams);

    // 去除重複員工

    const uniqueEmployees = [];

    const seen = new Set();

    for (const emp of employees.rows) {

      const key = emp.line_user_id || emp.name;

      if (!seen.has(key)) {

        seen.add(key);

        uniqueEmployees.push(emp);

      }

    }

    let attSql = `

      SELECT *

      FROM attendance

      WHERE 1 = 1

    `;

    const attParams = [];

    if (startDate) {

      attParams.push(startDate);

      attSql += `

        AND DATE(clock_time AT TIME ZONE 'Asia/Taipei')

        >= $${attParams.length}

      `;

    }

    if (endDate) {

      attParams.push(endDate);

      attSql += `

        AND DATE(clock_time AT TIME ZONE 'Asia/Taipei')

        <= $${attParams.length}

      `;

    }

    attSql += ` ORDER BY clock_time ASC`;

    const attendance = await pool.query(attSql, attParams);

    const result = [];

    for (const emp of uniqueEmployees) {

      let totalHours = 0;

      let lateCount = 0;

      let earlyLeaveCount = 0;

      let workDays = 0;

      const dayGroups = {};

      attendance.rows

        .filter(item =>
  item.line_user_id === emp.line_user_id ||
  item.name === emp.name
)

        .forEach(item => {

          const date = getTaipeiDate(item.clock_time);

          if (!dayGroups[date]) {

            dayGroups[date] = {

              start:null,

              end:null

            };

          }

          if (item.type === "上班") {

            if (

              !dayGroups[date].start ||

              new Date(item.clock_time) <

              new Date(dayGroups[date].start)

            ) {

              dayGroups[date].start = item.clock_time;

            }

          }

          if (item.type === "下班") {

            if (

              !dayGroups[date].end ||

              new Date(item.clock_time) >

              new Date(dayGroups[date].end)

            ) {

              dayGroups[date].end = item.clock_time;

            }

          }

        });

      Object.values(dayGroups).forEach(day => {

        if (day.start && day.end) {

          const rawHours =

            (new Date(day.end) - new Date(day.start)) /

            1000 / 60 / 60;

          const workHours =

            Math.max(0, rawHours - breakHours);

          if (workHours > 0) {

            workDays++;

            totalHours += workHours;

          }

          const startMinutes = getTaipeiMinutes(day.start);

          const endMinutes = getTaipeiMinutes(day.end);

          if (startMinutes > ruleStartMinutes) {

            lateCount++;

          }

          if (endMinutes < ruleEndMinutes) {

            earlyLeaveCount++;

          }

        }

      });

      const averageHours =

        workDays > 0

        ? Number((totalHours / workDays).toFixed(2))

        : 0;

      let normalDays =

        workDays - lateCount - earlyLeaveCount;

      if (normalDays < 0) {

        normalDays = 0;

      }

      result.push({
  name: emp.name,
  department: emp.department || "-",
  position: emp.position || "-",

  workDays,

  breakHours,

  totalHours: totalHours.toFixed(2),

  averageHours:
    workDays > 0
      ? (totalHours / workDays).toFixed(2)
      : "0.00",

  lateCount,
  earlyLeaveCount
});

    }

    res.json(result);

  } catch(err) {

    console.error("讀取出勤報表失敗:", err);

    res.status(500).json({

      success:false,

      message:"讀取出勤報表失敗"

    });

  }

});
// =========================
// 產生員工綁定碼
// =========================

app.post("/api/generate-bind-code/:id", async (req, res) => {
  try {
    const employeeId = req.params.id;

    const code =
      "EMP" +
      Math.floor(100000 + Math.random() * 900000);

    await pool.query(
      `
      UPDATE employees
      SET
        bind_code = $1,
        bind_status = '未綁定'
      WHERE id = $2
      `,
      [code, employeeId]
    );

    res.json({
      success:true,
      bindCode:code,
      message:"綁定碼已產生"
    });

  } catch(err) {
    console.error("產生綁定碼錯誤:", err);

    res.status(500).json({
      success:false,
      message:"產生綁定碼失敗"
    });
  }
});


// =========================
// LINE 綁定員工
// =========================

app.post("/api/bind-line", async (req, res) => {
  try {
    const {
      bindCode,
      lineUserId,
      displayName
    } = req.body;

    if (!bindCode || !lineUserId) {
      return res.status(400).json({
        success:false,
        message:"缺少綁定碼或LINE資料"
      });
    }

    const cleanCode =
      String(bindCode).trim();

    const result = await pool.query(
      `
      SELECT *
      FROM employees
      WHERE bind_code = $1
      AND status = '在職'
      LIMIT 1
      `,
      [cleanCode]
    );

    if (result.rows.length === 0) {
      return res.json({
        success:false,
        message:"綁定碼錯誤、已失效或員工不存在"
      });
    }

    const emp = result.rows[0];

    if (
      emp.line_user_id &&
      emp.line_user_id !== lineUserId
    ) {
      return res.json({
        success:false,
        message:"此員工已被其他LINE帳號綁定"
      });
    }

    await pool.query(
      `
      UPDATE employees
      SET
        line_user_id = $1,
        bind_status = '已綁定',
        line_display_name = $2,
        bound_at = NOW(),
        bind_code = NULL
      WHERE id = $3
      `,
      [
        lineUserId,
        displayName || "",
        emp.id
      ]
    );

    res.json({
      success:true,
      message:"LINE綁定成功",
      employeeName:emp.name
    });

  } catch(err) {
    console.error("LINE綁定錯誤:", err);

    res.status(500).json({
      success:false,
      message:"LINE綁定失敗"
    });
  }
});

// =========================
// 啟動伺服器
// =========================
const PORT = process.env.PORT || 3000;

createTables()
.then(() => {
  app.listen(PORT, () => {
    console.log("Server Running");
    console.log(`Port: ${PORT}`);
  });
})
.catch(err => {
  console.error(err);
});