import { Pool } from 'pg';

export const db = new Pool({ connectionString: process.env.DATABASE_URL });

export async function initializeDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS employees (
      id BIGSERIAL PRIMARY KEY,
      employee_code VARCHAR(30) UNIQUE NOT NULL,
      name VARCHAR(160) NOT NULL,
      line_user_id VARCHAR(80) UNIQUE,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      national_id VARCHAR(13),
      phone VARCHAR(20),
      address TEXT,
      start_date DATE,
      ethnicity VARCHAR(60),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- คอลัมน์รายละเอียดพนักงานสำหรับฐานข้อมูลที่สร้างไว้ก่อนแล้ว
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS national_id VARCHAR(13);
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS phone VARCHAR(20);
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS address TEXT;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS start_date DATE;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS ethnicity VARCHAR(60);
    CREATE UNIQUE INDEX IF NOT EXISTS employees_national_id_key
      ON employees(national_id) WHERE national_id IS NOT NULL;
    -- แผนกหรือกลุ่มงาน ผู้ดูแลสร้างเองได้จากหน้าตั้งค่า
    CREATE TABLE IF NOT EXISTS departments (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(120) UNIQUE NOT NULL,
      note VARCHAR(160),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS department_id BIGINT REFERENCES departments(id);
    -- ประเภทพนักงานและวิธีจ่ายค่าตอบแทน ผู้ดูแลสร้างเองได้จากหน้าตั้งค่า
    CREATE TABLE IF NOT EXISTS employee_types (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(80) UNIQUE NOT NULL,
      pay_type VARCHAR(10) NOT NULL CHECK (pay_type IN ('daily', 'monthly')),
      pay_rate NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (pay_rate >= 0),
      note VARCHAR(160),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      ot_multiplier NUMERIC(4,2) NOT NULL DEFAULT 1.5 CHECK (ot_multiplier >= 0 AND ot_multiplier <= 10),
      late_deduct_per_minute NUMERIC(8,2) NOT NULL DEFAULT 0 CHECK (late_deduct_per_minute >= 0),
      monthly_days_divisor SMALLINT NOT NULL DEFAULT 30 CHECK (monthly_days_divisor BETWEEN 1 AND 31),
      work_hours_per_day NUMERIC(4,2) NOT NULL DEFAULT 8 CHECK (work_hours_per_day > 0 AND work_hours_per_day <= 24),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- กฎการคำนวณค่าจ้าง แก้ได้ต่อประเภทพนักงาน สำหรับฐานข้อมูลที่สร้างไว้ก่อนแล้ว
    ALTER TABLE employee_types ADD COLUMN IF NOT EXISTS ot_multiplier NUMERIC(4,2) NOT NULL DEFAULT 1.5;
    ALTER TABLE employee_types ADD COLUMN IF NOT EXISTS late_deduct_per_minute NUMERIC(8,2) NOT NULL DEFAULT 0;
    ALTER TABLE employee_types ADD COLUMN IF NOT EXISTS monthly_days_divisor SMALLINT NOT NULL DEFAULT 30;
    ALTER TABLE employee_types ADD COLUMN IF NOT EXISTS work_hours_per_day NUMERIC(4,2) NOT NULL DEFAULT 8;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS employee_type_id BIGINT REFERENCES employee_types(id);
    -- การเบิกเงินล่วงหน้าและการจ่ายเงิน เก็บในตารางเดียวแยกด้วย kind
    CREATE TABLE IF NOT EXISTS payroll_entries (
      id BIGSERIAL PRIMARY KEY,
      employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      entry_date DATE NOT NULL,
      kind VARCHAR(10) NOT NULL CHECK (kind IN ('advance', 'payment')),
      amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
      method VARCHAR(20),
      note VARCHAR(160),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS payroll_entries_lookup_idx ON payroll_entries(employee_id, entry_date);
    CREATE TABLE IF NOT EXISTS shifts (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(80) UNIQUE NOT NULL,
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      grace_minutes SMALLINT NOT NULL DEFAULT 0 CHECK (grace_minutes BETWEEN 0 AND 240),
      break_minutes SMALLINT NOT NULL DEFAULT 60 CHECK (break_minutes BETWEEN 0 AND 480),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- เวลาพักใช้หักออกจากเวลาทำงานในรายงาน ค่าเริ่มต้น 60 นาทีตามพักเที่ยงทั่วไป
    ALTER TABLE shifts ADD COLUMN IF NOT EXISTS break_minutes SMALLINT NOT NULL DEFAULT 60;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS shift_id BIGINT REFERENCES shifts(id);
    CREATE TABLE IF NOT EXISTS time_logs (
      id BIGSERIAL PRIMARY KEY,
      employee_id BIGINT NOT NULL REFERENCES employees(id),
      event_type VARCHAR(10) NOT NULL CHECK (event_type IN ('check_in', 'check_out')),
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      source VARCHAR(30) NOT NULL DEFAULT 'line',
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- ตารางประจำสัปดาห์ เก็บครบ 7 วันต่อพนักงาน shift_id เป็น NULL หมายถึงวันหยุด
    -- weekday ใช้เลขเดียวกับ EXTRACT(DOW) คือ 0 = อาทิตย์ ถึง 6 = เสาร์
    CREATE TABLE IF NOT EXISTS schedule_weekly (
      employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      weekday SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
      shift_id BIGINT REFERENCES shifts(id),
      PRIMARY KEY (employee_id, weekday)
    );
    -- ตารางรายวันที่ ใช้ทับตารางประจำสัปดาห์ เช่น สลับเวร เข้าแทนเพื่อน หรือหยุดชดเชย
    CREATE TABLE IF NOT EXISTS schedule_overrides (
      employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      work_date DATE NOT NULL,
      shift_id BIGINT REFERENCES shifts(id),
      note VARCHAR(160),
      PRIMARY KEY (employee_id, work_date)
    );
    CREATE INDEX IF NOT EXISTS schedule_overrides_date_idx ON schedule_overrides(work_date);
    -- การลา 1 แถวต่อพนักงานต่อวัน วันที่ลาจะไม่คิดสายและไม่นับขาดงานในรายงาน
    CREATE TABLE IF NOT EXISTS leaves (
      employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      work_date DATE NOT NULL,
      leave_type VARCHAR(40) NOT NULL,
      note VARCHAR(160),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (employee_id, work_date)
    );
    CREATE INDEX IF NOT EXISTS leaves_date_idx ON leaves(work_date);
    -- การอนุมัติ OT รายวัน มีแถว = อนุมัติแล้ว ไม่มีแถว = ไม่จ่ายเงิน OT ของวันนั้น
    -- approved_minutes เป็น NULL หมายถึงอนุมัติเท่าที่ระบบคำนวณได้
    CREATE TABLE IF NOT EXISTS ot_approvals (
      employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      work_date DATE NOT NULL,
      approved_minutes INTEGER CHECK (approved_minutes IS NULL OR (approved_minutes >= 0 AND approved_minutes <= 1440)),
      note VARCHAR(160),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (employee_id, work_date)
    );
    CREATE INDEX IF NOT EXISTS ot_approvals_date_idx ON ot_approvals(work_date);
    -- สิทธิ์ส่งรายการค่าใช้จ่าย ผู้ดูแลเปิดให้เป็นรายคน
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS can_submit_expense BOOLEAN NOT NULL DEFAULT FALSE;
    -- รายการค่าใช้จ่ายที่พนักงานส่งเข้ามา ต้องผ่านการอนุมัติเหมือน OT
    CREATE TABLE IF NOT EXISTS expense_claims (
      id BIGSERIAL PRIMARY KEY,
      employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      claim_date DATE NOT NULL,
      category VARCHAR(40) NOT NULL,
      amount NUMERIC(12,2) NOT NULL CHECK (amount > 0 AND amount <= 10000000),
      detail VARCHAR(200),
      status VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      approved_amount NUMERIC(12,2) CHECK (approved_amount IS NULL OR approved_amount >= 0),
      review_note VARCHAR(160),
      reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS expense_claims_lookup_idx ON expense_claims(employee_id, claim_date);
    CREATE INDEX IF NOT EXISTS expense_claims_status_idx ON expense_claims(status);
    -- พิกัดตอนลงเวลา เก็บได้ทั้งจาก LIFF และจากการแชร์ตำแหน่งใน LINE
    ALTER TABLE time_logs ADD COLUMN IF NOT EXISTS latitude NUMERIC(9,6);
    ALTER TABLE time_logs ADD COLUMN IF NOT EXISTS longitude NUMERIC(9,6);
    ALTER TABLE time_logs ADD COLUMN IF NOT EXISTS accuracy_m NUMERIC(7,1);
    ALTER TABLE time_logs ADD COLUMN IF NOT EXISTS location_address VARCHAR(255);
    -- สถานที่ทำงานที่อนุญาต ใช้ตรวจว่าลงเวลาอยู่ในพื้นที่หรือไม่
    CREATE TABLE IF NOT EXISTS work_sites (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(120) UNIQUE NOT NULL,
      latitude NUMERIC(9,6) NOT NULL,
      longitude NUMERIC(9,6) NOT NULL,
      radius_m INTEGER NOT NULL DEFAULT 200 CHECK (radius_m BETWEEN 20 AND 20000),
      note VARCHAR(160),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS time_logs_employee_time_idx
      ON time_logs(employee_id, occurred_at DESC);
  `);

  // ระบบใหม่จะได้กะเริ่มต้นไว้ใช้ทันที ผู้ดูแลแก้ชื่อและเวลาได้จากหน้ากะการทำงาน
  await db.query(`
    INSERT INTO shifts (name, start_time, end_time, grace_minutes)
    SELECT 'กะปกติ', '08:00', '17:00', 15
    WHERE NOT EXISTS (SELECT 1 FROM shifts)
  `);
}
