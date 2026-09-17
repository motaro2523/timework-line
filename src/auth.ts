import crypto from 'node:crypto';
import { db } from './db.js';

// ===== รหัสผ่าน =====
// ใช้ scrypt ที่มีอยู่ใน Node อยู่แล้ว แทน bcrypt/argon2 ที่ต้องคอมไพล์ native module
// เพิ่มใน alpine ผลคือไม่ต้องพึ่ง dependency ใหม่เลย และ scrypt เป็น memory-hard
// ตามคำแนะนำของ OWASP เหมือนกัน พารามิเตอร์เก็บไว้ในสตริงเองเพื่อให้ขยับขึ้นได้ภายหลัง
const SCRYPT = { N: 16384, r: 8, p: 1, keyLength: 64 };

export function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(password, salt, SCRYPT.keyLength, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (error, key) => {
      if (error) return reject(error);
      resolve(`scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`);
    });
  });
}

export function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  return new Promise(resolve => {
    if (!stored) return resolve(false);
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return resolve(false);
    const [, n, r, p, salt, expected] = parts;
    const expectedBuffer = Buffer.from(expected, 'base64');
    crypto.scrypt(password, Buffer.from(salt, 'base64'), expectedBuffer.length,
      { N: Number(n), r: Number(r), p: Number(p) }, (error, key) => {
        if (error) return resolve(false);
        resolve(key.length === expectedBuffer.length && crypto.timingSafeEqual(key, expectedBuffer));
      });
  });
}

// ===== โทเคน =====
// เก็บเฉพาะ hash ลงฐานข้อมูล ถ้าฐานข้อมูลหลุดก็ยังสวมสิทธิ์ไม่ได้
export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export const SESSION_COOKIE = 'twsession';

export function parseCookies(header: string | undefined): Record<string, string> {
  const jar: Record<string, string> = {};
  if (!header) return jar;
  for (const piece of header.split(';')) {
    const separator = piece.indexOf('=');
    if (separator < 0) continue;
    const name = piece.slice(0, separator).trim();
    if (name) jar[name] = decodeURIComponent(piece.slice(separator + 1).trim());
  }
  return jar;
}

// Secure ใส่เสมอเพราะระบบเปิดผ่าน https เท่านั้น ส่วน SameSite=Lax กัน CSRF ข้ามเว็บ
export function sessionCookie(token: string, maxAgeSeconds: number) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}
export const clearSessionCookie = () =>
  `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

// ===== บทบาทและสิทธิ์ =====
export type Level = 'none' | 'view' | 'edit' | 'viewTeam' | 'editTeam';
export const ROLES = ['admin', 'hr', 'finance', 'lead'] as const;
export const LEVELS: Level[] = ['none', 'view', 'edit', 'viewTeam', 'editTeam'];
export const ROLE_LABELS: Record<string, string> = {
  admin: 'ผู้ดูแลระบบ', hr: 'ฝ่ายบุคคล', finance: 'การเงิน', lead: 'หัวหน้าแผนก'
};
export const PAGE_KEYS = ['overview','employees','shifts','schedule','leaves','logs','missing','ot',
  'reports','pay','advance','expenses','expensePermission','settings','admins'] as const;
export const PAGE_LABELS: Record<string, string> = {
  overview:'ภาพรวม', employees:'พนักงาน', shifts:'กะการทำงาน', schedule:'ตารางการทำงาน',
  leaves:'การลา', logs:'บันทึกเวลา', missing:'ลืมลงเวลา', ot:'อนุมัติ OT', reports:'รายงาน',
  pay:'เงินค่าตอบแทน', advance:'เงินที่เบิก', expenses:'รายการค่าใช้จ่าย',
  expensePermission:'สิทธิ์ส่งรายการผ่าน LINE', settings:'ตั้งค่า', admins:'ผู้ดูแลระบบ'
};

export const canRead = (level: Level) => level !== 'none';
export const canWrite = (level: Level) => level === 'edit' || level === 'editTeam';
export const isTeamOnly = (level: Level) => level === 'viewTeam' || level === 'editTeam';

export type AdminIdentity = {
  id: string;
  email: string;
  name: string;
  role: string;
  departmentId: string | null;
  permissions: Record<string, Level>;
  viaApiKey: boolean;
};

// ผู้ดูแลระบบเห็นทุกอย่างเสมอ ไม่ต้องพึ่งตารางสิทธิ์ เผื่อกรณีตารางถูกแก้จนล็อกตัวเองออก
export async function loadPermissions(role: string): Promise<Record<string, Level>> {
  const permissions: Record<string, Level> = {};
  if (role === 'admin') {
    for (const key of PAGE_KEYS) permissions[key] = 'edit';
    return permissions;
  }
  const { rows } = await db.query('SELECT page_key, level FROM role_permissions WHERE role = $1', [role]);
  for (const key of PAGE_KEYS) permissions[key] = 'none';
  for (const row of rows) permissions[row.page_key] = row.level as Level;
  return permissions;
}

export async function findSession(token: string): Promise<AdminIdentity | null> {
  const { rows } = await db.query(`
    SELECT a.id, a.email, a.name, a.role, a.department_id, a.status
    FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
    WHERE s.token_hash = $1 AND s.expires_at > NOW()
  `, [hashToken(token)]);
  if (!rows.length) return null;
  const row = rows[0];
  // ปิดบัญชีแล้วต้องใช้ไม่ได้ทันที แม้ session ยังไม่หมดอายุ
  if (row.status !== 'active') return null;
  return {
    id: String(row.id), email: row.email, name: row.name, role: row.role,
    departmentId: row.department_id === null ? null : String(row.department_id),
    permissions: await loadPermissions(row.role),
    viaApiKey: false
  };
}

export async function writeAudit(actor: AdminIdentity | null, action: string, target: string | null, detail: unknown) {
  await db.query(
    'INSERT INTO audit_log (admin_id, admin_email, action, target, detail) VALUES ($1, $2, $3, $4, $5)',
    [actor && !actor.viaApiKey ? actor.id : null, actor?.email ?? null, action, target, detail === undefined ? null : JSON.stringify(detail)]
  ).catch(() => {});
}
