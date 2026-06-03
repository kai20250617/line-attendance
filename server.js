const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");
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
          messages: [{ type: "text", text }]
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
// 打卡
// =========================

app.post("/api/clock", async (req, res) => {
  const { lineUserId, name, type, latitude, longitude } = req.body;

  if (!lineUserId || !name || !type) {
    return res.status(400).json({
      success: false,
      message: "缺少打卡資料"
    });
  }

  try {
    const today = getTaiwanDateString();

    const recordsResult = await pool.query(
      "SELECT * FROM attendance WHERE line_user_id = $1 ORDER BY id DESC",
      [lineUserId]
    );

    const todayRecords = recordsResult.rows.filter(item => {
      const itemDate = new Date(item.clock_time).toLocaleDateString("zh-TW", {
        timeZone: "Asia/Taipei"
      });

      return itemDate === today;
    });

    if (todayRecords.some(item => item.type === type)) {
      return res.status(400).json({
        success: false,
        message: "今天已經完成「" + type + "」打卡，請勿重複打卡"
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

    const settingResult = await pool.query(
      "SELECT * FROM settings LIMIT 1"
    );

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
          message:
            "不在公司範圍內，無法打卡。目前距離約 " +
            Math.round(distance) +
            " 公尺"
        });
      }
    }

    const now = new Date();
    const nowISO = now.toISOString();

    await pool.query(
      `
      INSERT INTO attendance
      (line_user_id, name, type, clock_time, latitude, longitude)
      VALUES ($1,$2,$3,$4,$5,$6)
      `,
      [lineUserId, name, type, nowISO, latitude, longitude]
    );

    const timeText = getTaiwanTimeString(now);

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
${distance === null ? "未啟用GPS限制" : Math.round(distance) + " 公尺"}`
    );

    res.json({
      success: true,
      message: "打卡成功",
      time: nowISO
    });

  } catch (err) {
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
  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: "讀取打卡資料失敗"
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

  const now = new Date().toISOString();

  try {
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
        reason,
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
${reason}

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
      "SELECT * FROM leaves ORDER BY id DESC"
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: "讀取請假資料失敗"
    });
  }
});

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
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
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

  } catch (err) {
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
  } catch (err) {
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

  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: "員工狀態更新失敗"
    });
  }
});

app.post("/api/employees/bind", async (req, res) => {
  const { name, lineUserId } = req.body;

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

  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: "LINE ID 綁定失敗"
    });
  }
});
app.get("/api/my-salary/:lineUserId", async (req, res) => {
  try {

    const lineUserId =
      req.params.lineUserId;

    const result = await pool.query(
      `
      SELECT *
      FROM employees
      WHERE line_user_id = $1
      LIMIT 1
      `,
      [lineUserId]
    );

    if(result.rows.length === 0){
      return res.status(404).json({
        success:false,
        message:"找不到員工資料"
      });
    }

    const emp = result.rows[0];

    const baseSalary =
      Number(emp.base_salary || 27000);

    const fixedAllowance =
      Number(emp.fixed_allowance || 3000);

    const attendanceBonus =
      Number(emp.attendance_bonus || 3000);

    const performanceBonus =
      Number(emp.performance_bonus || 0);

    const overtimePay =
      Number(emp.overtime_pay || 0);

    const leaveDeduction =
      Number(emp.leave_deduction || 0);

    const grossSalary =
      baseSalary +
      fixedAllowance +
      attendanceBonus +
      performanceBonus +
      overtimePay -
      leaveDeduction;

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

    res.json({
      success:true,
      id: emp.id,
      name: emp.name,
      department: emp.department,
      position: emp.position,

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

  } catch(err){

    console.error(err);

    res.status(500).json({
      success:false,
      message:"讀取薪資失敗"
    });

  }
});
// =========================
// GPS 設定
// =========================

app.get("/api/settings", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM settings LIMIT 1"
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
    await pool.query(
      `
      UPDATE settings
      SET
        gps_enabled = $1,
        company_lat = $2,
        company_lng = $3,
        gps_radius = $4
      WHERE id = (
        SELECT id FROM settings ORDER BY id ASC LIMIT 1
      )
      `,
      [
        Number(gps_enabled),
        Number(company_lat),
        Number(company_lng),
        Number(gps_radius)
      ]
    );

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
// 出勤規則
// =========================

app.get("/api/rules", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM rules LIMIT 1"
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: "讀取出勤規則失敗"
    });
  }
});

app.post("/api/rules", async (req, res) => {
  const {
    work_start,
    work_end,
    break_hours,
    overtime_start
  } = req.body;

  try {
    await pool.query(
      `
      UPDATE rules
      SET
        work_start = $1,
        work_end = $2,
        break_hours = $3,
        overtime_start = $4
      WHERE id = (
        SELECT id FROM rules ORDER BY id ASC LIMIT 1
      )
      `,
      [
        work_start,
        work_end,
        Number(break_hours),
        overtime_start
      ]
    );

    res.json({
      success: true,
      message: "出勤規則已儲存"
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: "出勤規則儲存失敗"
    });
  }
});

// =========================
// 月薪 CSV
// =========================

app.get("/api/export-monthly", async (req, res) => {
  try {
    const attendanceResult = await pool.query(
      "SELECT * FROM attendance ORDER BY id ASC"
    );

    const employeesResult = await pool.query(
      "SELECT * FROM employees"
    );

    const attendance = attendanceResult.rows;
    const employees = employeesResult.rows;

    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();

    const dayGroups = {};

    attendance.forEach(item => {
      const d = new Date(item.clock_time);

      if (d.getFullYear() !== year || d.getMonth() !== month) {
        return;
      }

      const date = d.toLocaleDateString("zh-TW", {
        timeZone: "Asia/Taipei"
      });

      const key = item.name + "_" + date;

      if (!dayGroups[key]) {
        dayGroups[key] = {
          name: item.name,
          date,
          start: null,
          end: null
        };
      }

      if (item.type === "上班") {
        if (!dayGroups[key].start || new Date(item.clock_time) < new Date(dayGroups[key].start)) {
          dayGroups[key].start = item.clock_time;
        }
      }

      if (item.type === "下班") {
        if (!dayGroups[key].end || new Date(item.clock_time) > new Date(dayGroups[key].end)) {
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

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=monthly-report.csv");

    res.send(csv);

  } catch (err) {
    console.error(err);

    res.status(500).send("匯出失敗");
  }
});

// =========================
// 薪資總表
// =========================

app.get("/api/salary-report", async (req, res) => {
  try {
    const employeesResult = await pool.query(
      "SELECT * FROM employees WHERE status = '在職' ORDER BY id DESC"
    );

    const attendanceResult = await pool.query(
      "SELECT * FROM attendance ORDER BY id ASC"
    );

    const leavesResult = await pool.query(
      "SELECT * FROM leaves WHERE status = '已核准' OR status = '核准'"
    );

    const attendance = attendanceResult.rows;
    const leaves = leavesResult.rows;

    const result = employeesResult.rows.map(emp => {
      const baseSalary = Number(emp.base_salary || 27000);
      const fixedAllowance = Number(emp.fixed_allowance || 3000);
      const attendanceBonus = Number(emp.attendance_bonus || 3000);
      const performanceBonus = Number(emp.performance_bonus || 0);

      let overtimePay = 0;
      let leaveDeduction = 0;

      const empRecords = attendance.filter(
        a => a.name === emp.name
      );

      const empLeaves = leaves.filter(
        l => l.name === emp.name
      );

      const dailySalary = baseSalary / 30;

      empLeaves.forEach(leave => {
        const start = new Date(leave.start_date);
        const end = new Date(leave.end_date);

        const days =
          Math.floor(
            (end - start) /
            (1000 * 60 * 60 * 24)
          ) + 1;

        switch(leave.leave_type){
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

          default:
            break;
        }
      });

      const dayGroups = {};

      empRecords.forEach(item => {
        const date = new Date(item.clock_time)
          .toLocaleDateString("zh-TW", {
            timeZone: "Asia/Taipei"
          });

        if (!dayGroups[date]) {
          dayGroups[date] = {
            start: null,
            end: null
          };
        }

        if (item.type === "上班") {
          if (
            !dayGroups[date].start ||
            new Date(item.clock_time) < new Date(dayGroups[date].start)
          ) {
            dayGroups[date].start = item.clock_time;
          }
        }

        if (item.type === "下班") {
          if (
            !dayGroups[date].end ||
            new Date(item.clock_time) > new Date(dayGroups[date].end)
          ) {
            dayGroups[date].end = item.clock_time;
          }
        }
      });

      Object.values(dayGroups).forEach(day => {
        if (day.start && day.end) {
          const totalHours =
            (new Date(day.end) - new Date(day.start)) /
            1000 / 60 / 60;

          const normalHours = 8;

          const overtimeHours =
            Math.max(0, totalHours - normalHours);

          const hourlyRate =
            Number(emp.hourly_wage || 200);

          const first2Hours =
            Math.min(overtimeHours, 2);

          const after2Hours =
            Math.max(0, overtimeHours - 2);

          overtimePay +=
            (first2Hours * hourlyRate * 1.34) +
            (after2Hours * hourlyRate * 1.67);
        }
      });

      overtimePay = Math.round(overtimePay);
      leaveDeduction = Math.round(leaveDeduction);

      const grossSalary =
        baseSalary +
        fixedAllowance +
        attendanceBonus +
        performanceBonus +
        overtimePay -
        leaveDeduction;

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
        leaveDeduction,
        grossSalary,
        laborInsurance,
        healthInsurance,
        laborPension,
        netSalary
      };
    });

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
// PDF 薪資單
// =========================
app.get("/api/payslip/:id", async (req, res) => {
  const employeeId = req.params.id;

  try {
    const employeeResult = await pool.query(
      "SELECT * FROM employees WHERE id = $1",
      [employeeId]
    );

    if (employeeResult.rows.length === 0) {
      return res.status(404).send("找不到員工");
    }

    const emp = employeeResult.rows[0];

    const salaryListResult = await pool.query(
      "SELECT * FROM employees WHERE status = '在職' ORDER BY id DESC"
    );

    const attendanceResult = await pool.query(
      "SELECT * FROM attendance ORDER BY id ASC"
    );

    const leavesResult = await pool.query(
      "SELECT * FROM leaves WHERE status = '已核准' OR status = '核准'"
    );

    const attendance = attendanceResult.rows;
    const leaves = leavesResult.rows;

    const baseSalary = Number(emp.base_salary || 27000);
    const fixedAllowance = Number(emp.fixed_allowance || 3000);
    const attendanceBonus = Number(emp.attendance_bonus || 3000);
    const performanceBonus = Number(emp.performance_bonus || 0);

    let overtimePay = 0;
    let leaveDeduction = 0;

    const empRecords = attendance.filter(
      a => a.name === emp.name
    );

    const empLeaves = leaves.filter(
      l => l.name === emp.name
    );

    const dailySalary = baseSalary / 30;

    empLeaves.forEach(leave => {
      const start = new Date(leave.start_date);
      const end = new Date(leave.end_date);

      const days =
        Math.floor(
          (end - start) /
          (1000 * 60 * 60 * 24)
        ) + 1;

      switch(leave.leave_type){
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

        default:
          break;
      }
    });

    const dayGroups = {};

    empRecords.forEach(item => {
      const date = new Date(item.clock_time)
        .toLocaleDateString("zh-TW", {
          timeZone: "Asia/Taipei"
        });

      if (!dayGroups[date]) {
        dayGroups[date] = {
          start: null,
          end: null
        };
      }

      if (item.type === "上班") {
        if (
          !dayGroups[date].start ||
          new Date(item.clock_time) < new Date(dayGroups[date].start)
        ) {
          dayGroups[date].start = item.clock_time;
        }
      }

      if (item.type === "下班") {
        if (
          !dayGroups[date].end ||
          new Date(item.clock_time) > new Date(dayGroups[date].end)
        ) {
          dayGroups[date].end = item.clock_time;
        }
      }
    });

    Object.values(dayGroups).forEach(day => {
      if (day.start && day.end) {
        const totalHours =
          (new Date(day.end) - new Date(day.start)) /
          1000 / 60 / 60;

        const overtimeHours =
          Math.max(0, totalHours - 8);

        const hourlyRate =
          Number(emp.hourly_wage || 200);

        const first2Hours =
          Math.min(overtimeHours, 2);

        const after2Hours =
          Math.max(0, overtimeHours - 2);

        overtimePay +=
          (first2Hours * hourlyRate * 1.34) +
          (after2Hours * hourlyRate * 1.67);
      }
    });

    overtimePay = Math.round(overtimePay);
    leaveDeduction = Math.round(leaveDeduction);

    const grossSalary =
      baseSalary +
      fixedAllowance +
      attendanceBonus +
      performanceBonus +
      overtimePay -
      leaveDeduction;

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

console.log("字型路徑:", fontPath);
console.log("字型存在:", fs.existsSync(fontPath));

if (fs.existsSync(fontPath)) {
  doc.font(fontPath);
} else {
  console.log("找不到字型檔");
}
    const filename =
      `payslip_${emp.name}_${new Date().getFullYear()}_${new Date().getMonth() + 1}.pdf`;

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
    doc.text(`員工姓名：${emp.name}`);
    doc.text(`部門：${emp.department || "-"}`);
    doc.text(`職稱：${emp.position || "-"}`);
    doc.text(`月份：${new Date().getFullYear()} / ${new Date().getMonth() + 1}`);

    doc.moveDown();
    doc.text("----------------------------------------");

    doc.fontSize(14).text("應發項目");
    doc.fontSize(12);
    doc.text(`底薪：NT$ ${baseSalary.toLocaleString("zh-TW")}`);
    doc.text(`固定津貼：NT$ ${fixedAllowance.toLocaleString("zh-TW")}`);
    doc.text(`加班費：NT$ ${overtimePay.toLocaleString("zh-TW")}`);
    doc.text(`全勤獎金：NT$ ${attendanceBonus.toLocaleString("zh-TW")}`);
    doc.text(`績效獎金：NT$ ${performanceBonus.toLocaleString("zh-TW")}`);

    doc.moveDown();

    doc.fontSize(14).text("扣除項目");
    doc.fontSize(12);
    doc.text(`請假扣款：NT$ ${leaveDeduction.toLocaleString("zh-TW")}`);
    doc.text(`勞保：NT$ ${laborInsurance.toLocaleString("zh-TW")}`);
    doc.text(`健保：NT$ ${healthInsurance.toLocaleString("zh-TW")}`);
    doc.text(`勞退提繳：NT$ ${laborPension.toLocaleString("zh-TW")}（公司提繳，不自薪資扣除）`);

    doc.moveDown();
    doc.text("----------------------------------------");

    doc.fontSize(16).text(
      `應發薪資：NT$ ${grossSalary.toLocaleString("zh-TW")}`
    );

    doc.fontSize(18).text(
      `實發薪資：NT$ ${netSalary.toLocaleString("zh-TW")}`,
      { align: "right" }
    );

    doc.moveDown();

    doc.fontSize(10).text(
      "備註：本薪資單為系統自動產生，實際金額仍以公司核定為準。"
    );

    doc.end();

  } 
  catch (err) {
  console.error("PDF ERROR:", err);

  res.status(500).send(
    "薪資單產生失敗：" + err.message
  );
}
});

// =========================
// 測試 LINE
// =========================

app.get("/test-line", async (req, res) => {
  await pushLineMessage(
    MANAGER_LINE_USER_ID,
    "✅ LINE 通知測試成功"
  );

  res.json({
    success: true,
    message: "測試通知已送出"
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