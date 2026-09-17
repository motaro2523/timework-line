import crypto from 'node:crypto';
import path from 'node:path';
import Fastify, { type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { db, initializeDatabase } from './db.js';
import { removeExpensePhoto, saveExpensePhoto, sendPhoto } from './photos.js';
import {
  type AdminIdentity, type Level, LEVELS, PAGE_KEYS, PAGE_LABELS, ROLES, ROLE_LABELS,
  SESSION_COOKIE, canRead, canWrite, clearSessionCookie, findSession, hashPassword, hashToken,
  isTeamOnly, loadPermissions, newToken, parseCookies, sessionCookie, verifyPassword, writeAudit
} from './auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
    admin?: AdminIdentity;
    teamDepartmentId?: string;
  }
}

const app = Fastify({ logger: true });
const port = Number(process.env.PORT ?? 3000);

app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
  const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
  request.rawBody = rawBody;
  // POST ที่ไม่มีเนื้อความ เช่น ออกจากระบบ ถือว่าเป็นอ็อบเจกต์ว่าง ไม่ใช่ JSON เสีย
  if (!rawBody.length) return done(null, {});
  try {
    done(null, JSON.parse(rawBody.toString('utf8')));
  } catch {
    // ต้องใส่ statusCode เอง ไม่อย่างนั้น Fastify ตอบ 500 ทั้งที่เป็นความผิดของฝั่งที่ส่งมา
    const error = new Error('รูปแบบ JSON ไม่ถูกต้อง') as Error & { statusCode?: number };
    error.statusCode = 400;
    done(error);
  }
});

const adminKey = process.env.ADMIN_API_KEY ?? '';

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function presentedAdminKey(request: FastifyRequest) {
  const header = request.headers['x-admin-key'];
  if (typeof header === 'string' && header) return header;
  const authorization = request.headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Basic ')) {
    const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator >= 0) return decoded.slice(separator + 1);
  }
  return null;
}

// ผู้ใช้จริงเข้าด้วยบัญชีและรหัสผ่าน ส่วน x-admin-key เก็บไว้ให้สคริปต์และการตรวจสอบระบบ
// โดยถือเป็นสิทธิ์ระดับผู้ดูแลระบบเต็ม ตามที่เอกสารออกแบบกำหนด
const API_KEY_IDENTITY = (): AdminIdentity => ({
  id: '0', email: 'x-admin-key', name: 'เครื่องมืออัตโนมัติ', role: 'admin',
  departmentId: null,
  permissions: Object.fromEntries(PAGE_KEYS.map(key => [key, 'edit' as Level])),
  viaApiKey: true
});

// /liff ยืนยันตัวตนด้วย access token ของ LINE แทนบัญชีผู้ดูแล จึงไม่ผ่าน hook นี้
const PUBLIC_PATHS = new Set(['/health', '/webhooks/line', '/liff', '/liff.html',
  '/liff/pay', '/liff/advance', '/liff/expense',
  '/api/liff/config', '/api/liff/status',
  '/api/liff/check-in', '/api/liff/summary', '/api/liff/expenses', '/api/liff/expenses/cancel',
  '/api/liff/expenses/photo',
  '/login', '/login.html', '/reset',
  '/auth/login', '/auth/logout', '/auth/register', '/auth/forgot', '/auth/reset', '/auth/reset/check']);

// Registered before the static plugin so the dashboard HTML is protected too.
app.addHook('onRequest', async (request, reply) => {
  const pathname = request.url.split('?')[0];
  if (PUBLIC_PATHS.has(pathname)) return;

  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  if (token) {
    const identity = await findSession(token);
    if (identity) { request.admin = identity; return; }
  }
  const provided = presentedAdminKey(request);
  if (adminKey && provided && safeEqual(provided, adminKey)) {
    request.admin = API_KEY_IDENTITY();
    return;
  }
  // เรียกจากเบราว์เซอร์ให้พาไปหน้าเข้าสู่ระบบ ส่วนที่เรียก API ให้ตอบ 401 ไปตรงๆ
  if (!pathname.startsWith('/api') && request.headers.accept?.includes('text/html')) {
    return reply.redirect('/login');
  }
  return reply.code(401).send({ error: 'กรุณาเข้าสู่ระบบ' });
});

// ===== บังคับสิทธิ์รายเส้นทาง =====
// จับคู่เส้นทางกับหน้าในตารางสิทธิ์ เรียงจากเฉพาะเจาะจงไปกว้าง ตัวแรกที่ตรงคือตัวที่ใช้
// ซ่อนเมนูฝั่งหน้าเว็บไม่ใช่การป้องกัน การตรวจจริงอยู่ตรงนี้
const ROUTE_PERMISSIONS: [RegExp, string][] = [
  [/^\/api\/me$/,                          ''],
  [/^\/api\/admins/,                       'admins'],
  [/^\/api\/role-permissions/,             'admins'],
  [/^\/api\/permissions\/expense/,         'expensePermission'],
  [/^\/api\/reports\/today/,               'overview'],
  [/^\/api\/reports\//,                    'reports'],
  [/^\/api\/employees/,                    'employees'],
  [/^\/api\/shifts/,                       'shifts'],
  [/^\/api\/schedules\//,                  'schedule'],
  [/^\/api\/leaves/,                       'leaves'],
  [/^\/api\/time-logs\/(missing|manual)/,  'missing'],
  [/^\/api\/time-logs/,                    'logs'],
  [/^\/api\/ot/,                           'ot'],
  [/^\/api\/payroll\/entries/,             'advance'],
  [/^\/api\/payroll/,                      'pay'],
  [/^\/api\/expenses/,                     'expenses'],
  [/^\/api\/(departments|employee-types|work-sites)/, 'settings']
];
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

app.addHook('preHandler', async (request, reply) => {
  const pathname = request.url.split('?')[0];
  if (!pathname.startsWith('/api') || pathname.startsWith('/api/liff/')) return;
  const identity = request.admin;
  if (!identity) return reply.code(401).send({ error: 'กรุณาเข้าสู่ระบบ' });

  const match = ROUTE_PERMISSIONS.find(([pattern]) => pattern.test(pathname));
  // เส้นทางที่ไม่ได้อยู่ในตารางถือว่าเป็นของผู้ดูแลระบบเท่านั้น ปลอดภัยกว่าปล่อยผ่าน
  let pageKey = match ? match[1] : 'admins';
  if (pageKey === '') return;

  // แก้เฉพาะสิทธิ์ส่งค่าใช้จ่ายของพนักงาน ใช้สิทธิ์ของหน้าค่าใช้จ่ายแทนหน้าพนักงาน
  // เพราะฝ่ายการเงินแก้ข้อมูลพนักงานไม่ได้ แต่เปิดปิดสิทธิ์นี้ได้
  if (pageKey === 'employees' && request.method === 'PATCH') {
    const body = request.body as Record<string, unknown> | undefined;
    if (body && Object.keys(body).length === 1 && 'canSubmitExpense' in body) pageKey = 'expensePermission';
  }

  const level = identity.permissions[pageKey] ?? 'none';
  if (READ_METHODS.has(request.method)) {
    if (!canRead(level)) return reply.code(403).send({ error: 'บัญชีของคุณไม่มีสิทธิ์ดูข้อมูลส่วนนี้' });
  } else if (!canWrite(level)) {
    return reply.code(403).send({ error: 'บัญชีของคุณดูได้อย่างเดียว แก้ไขข้อมูลส่วนนี้ไม่ได้' });
  }

  // หัวหน้าแผนกเห็นได้เฉพาะแผนกตัวเอง บังคับค่าทับของที่ client ส่งมาเสมอ
  // ไม่อย่างนั้นยิง ?departmentId= ข้ามแผนกได้
  if (isTeamOnly(level)) {
    if (!identity.departmentId) {
      return reply.code(403).send({ error: 'บัญชีนี้ยังไม่ได้กำหนดแผนกที่ดูแล กรุณาแจ้งผู้ดูแลระบบ' });
    }
    const query = request.query as Record<string, unknown>;
    if (query) query.departmentId = identity.departmentId;
    request.teamDepartmentId = identity.departmentId;
  }
});

await app.register(fastifyStatic, { root: path.join(process.cwd(), 'public') });

app.get('/health', async () => ({ status: 'ok' }));

// ===== เข้าสู่ระบบ สมัคร และลืมรหัสผ่าน =====
const BASE_URL = (process.env.PUBLIC_BASE_URL ?? 'https://timework.scriptbin.dev').replace(/\/$/, '');
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const SESSION_HOURS = 12;
const REMEMBER_DAYS = 30;
const RESET_MINUTES = 30;

app.get('/login', async (request, reply) => reply.sendFile('login.html'));
app.get('/reset', async (request, reply) => reply.sendFile('login.html'));

// จำกัดจำนวนครั้งต่อ IP กันการเดารหัสและการยิงสมัครรัว ๆ เก็บในหน่วยความจำก็พอ
// เพราะระบบรันอินสแตนซ์เดียวและรีสตาร์ตไม่บ่อย
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
function rateLimited(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    if (rateBuckets.size > 5000) for (const [k, v] of rateBuckets) if (v.resetAt < now) rateBuckets.delete(k);
    return false;
  }
  bucket.count += 1;
  return bucket.count > limit;
}

// ระบบนี้ไม่มีช่องทางอีเมล จึงแจ้งผ่าน LINE ของบัญชีนั้นแทน
async function pushLine(userId: string | null | undefined, text: string) {
  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!userId || !accessToken) return false;
  try {
    const response = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ to: userId, messages: [{ type: 'text', text }] })
    });
    if (!response.ok) app.log.warn({ status: response.status }, 'LINE push failed');
    return response.ok;
  } catch (error) {
    app.log.warn({ error }, 'LINE push failed');
    return false;
  }
}

const normalizeEmail = (value: unknown) => String(value ?? '').trim().toLowerCase();
const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) && value.length <= 160;

async function issueReset(adminId: string) {
  const token = newToken();
  await db.query('DELETE FROM password_resets WHERE admin_id = $1 AND used_at IS NULL', [adminId]);
  await db.query(
    `INSERT INTO password_resets (token_hash, admin_id, expires_at)
     VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval)`,
    [hashToken(token), adminId, String(RESET_MINUTES)]
  );
  return `${BASE_URL}/reset?token=${token}`;
}

app.post<{ Body: { email?: string; password?: string; remember?: boolean } }>('/auth/login', async (request, reply) => {
  const ip = request.ip;
  if (rateLimited(`login:${ip}`, 20, 5 * 60_000)) {
    return reply.code(429).send({ error: 'พยายามเข้าสู่ระบบบ่อยเกินไป กรุณารอสักครู่' });
  }
  const email = normalizeEmail(request.body?.email);
  const password = String(request.body?.password ?? '');
  if (!email || !password) return reply.code(400).send({ error: 'กรุณากรอกอีเมลและรหัสผ่านให้ครบ' });
  if (!isEmail(email)) return reply.code(400).send({ error: 'รูปแบบอีเมลไม่ถูกต้อง' });

  const { rows } = await db.query(
    `SELECT id, name, email, password_hash, status, failed_attempts,
            locked_until, (locked_until > NOW()) AS locked,
            CEIL(EXTRACT(EPOCH FROM (locked_until - NOW())) / 60)::int AS lock_minutes
     FROM admins WHERE email = $1`, [email]);
  const admin = rows[0];
  // ข้อความเดียวกันทั้งกรณีไม่มีอีเมลและรหัสผิด เพื่อไม่ให้เดาได้ว่าอีเมลไหนมีอยู่จริง
  const wrong = { error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' };
  if (!admin) return reply.code(401).send(wrong);
  if (admin.locked) {
    return reply.code(423).send({ error: `บัญชีถูกล็อกชั่วคราว กรุณาลองใหม่ในอีก ${admin.lock_minutes} นาที` });
  }
  if (!(await verifyPassword(password, admin.password_hash))) {
    const failed = Number(admin.failed_attempts) + 1;
    const shouldLock = failed >= MAX_FAILED;
    await db.query(
      `UPDATE admins SET failed_attempts = $2,
              locked_until = CASE WHEN $3 THEN NOW() + ($4 || ' minutes')::interval ELSE locked_until END
       WHERE id = $1`, [admin.id, shouldLock ? 0 : failed, shouldLock, String(LOCK_MINUTES)]);
    if (shouldLock) {
      return reply.code(423).send({ error: `บัญชีถูกล็อกชั่วคราว กรุณาลองใหม่ในอีก ${LOCK_MINUTES} นาที` });
    }
    return reply.code(401).send({ error: `อีเมลหรือรหัสผ่านไม่ถูกต้อง เหลือโอกาสอีก ${MAX_FAILED - failed} ครั้งก่อนบัญชีถูกล็อก ${LOCK_MINUTES} นาที` });
  }
  // ตรวจสถานะหลังตรวจรหัสผ่าน จะได้ไม่บอกคนนอกว่าอีเมลนี้มีบัญชีอยู่
  if (admin.status === 'pending') return reply.code(403).send({ error: 'บัญชีนี้รอผู้ดูแลระบบอนุมัติ' });
  if (admin.status !== 'active') return reply.code(403).send({ error: 'บัญชีนี้ถูกปิดการใช้งาน กรุณาติดต่อผู้ดูแลระบบ' });

  const remember = Boolean(request.body?.remember);
  const maxAge = remember ? REMEMBER_DAYS * 86400 : SESSION_HOURS * 3600;
  const token = newToken();
  await db.query(
    `INSERT INTO admin_sessions (token_hash, admin_id, expires_at, user_agent)
     VALUES ($1, $2, NOW() + ($3 || ' seconds')::interval, $4)`,
    [hashToken(token), admin.id, String(maxAge), String(request.headers['user-agent'] ?? '').slice(0, 200)]);
  await db.query('UPDATE admins SET failed_attempts = 0, locked_until = NULL, last_login_at = NOW() WHERE id = $1', [admin.id]);
  await db.query('DELETE FROM admin_sessions WHERE expires_at < NOW()');
  return reply.header('Set-Cookie', sessionCookie(token, maxAge)).send({ ok: true });
});

app.post('/auth/logout', async (request, reply) => {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  if (token) await db.query('DELETE FROM admin_sessions WHERE token_hash = $1', [hashToken(token)]);
  return reply.header('Set-Cookie', clearSessionCookie()).send({ ok: true });
});

app.post<{ Body: { name?: string; phone?: string; email?: string; password?: string; role?: string; note?: string } }>('/auth/register', async (request, reply) => {
  if (rateLimited(`register:${request.ip}`, 5, 60 * 60_000)) {
    return reply.code(429).send({ error: 'ส่งคำขอบ่อยเกินไป กรุณาลองใหม่ภายหลัง' });
  }
  const name = String(request.body?.name ?? '').trim().slice(0, 160);
  const email = normalizeEmail(request.body?.email);
  const password = String(request.body?.password ?? '');
  if (!name || !email || !password) return reply.code(400).send({ error: 'กรุณากรอกชื่อ อีเมล และรหัสผ่าน' });
  if (!isEmail(email)) return reply.code(400).send({ error: 'รูปแบบอีเมลไม่ถูกต้อง' });
  if (password.length < 8) return reply.code(400).send({ error: 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร' });
  const requestedRole = ROLES.includes(String(request.body?.role ?? '') as typeof ROLES[number])
    ? String(request.body?.role) : 'hr';
  const phone = String(request.body?.phone ?? '').trim().slice(0, 20) || null;
  const note = String(request.body?.note ?? '').trim().slice(0, 160) || null;

  const existing = await db.query('SELECT id FROM admins WHERE email = $1', [email]);
  // อีเมลซ้ำก็ตอบเหมือนสำเร็จ แต่ไม่สร้างแถวใหม่ กันการไล่เดาว่าใครมีบัญชีอยู่แล้ว
  if (!existing.rowCount) {
    // สมัครเองได้แค่สถานะรออนุมัติ บทบาทจริงมาจากคนที่กดอนุมัติเท่านั้น
    await db.query(
      `INSERT INTO admins (email, name, phone, password_hash, role, requested_role, request_note, status)
       VALUES ($1, $2, $3, $4, 'hr', $5, $6, 'pending')`,
      [email, name, phone, await hashPassword(password), requestedRole, note]);
    const approvers = await db.query("SELECT line_user_id FROM admins WHERE role = 'admin' AND status = 'active'");
    for (const row of approvers.rows) {
      await pushLine(row.line_user_id, `TimeWork: มีคำขอใช้งานใหม่\n${name} (${email})\nขอสิทธิ์ ${ROLE_LABELS[requestedRole]}\nเข้าไปอนุมัติที่ ${BASE_URL}/#admins`);
    }
  }
  return reply.code(201).send({ ok: true });
});

app.post<{ Body: { email?: string } }>('/auth/forgot', async (request, reply) => {
  if (rateLimited(`forgot:${request.ip}`, 5, 60 * 60_000)) {
    return reply.code(429).send({ error: 'ขอลิงก์บ่อยเกินไป กรุณาลองใหม่ภายหลัง' });
  }
  const email = normalizeEmail(request.body?.email);
  if (!email) return reply.code(400).send({ error: 'กรุณากรอกอีเมลที่ใช้เข้าระบบ' });
  const { rows } = await db.query(
    "SELECT id, name, line_user_id FROM admins WHERE email = $1 AND status IN ('active','pending')", [email]);
  if (rows.length) {
    const link = await issueReset(String(rows[0].id));
    const sent = await pushLine(rows[0].line_user_id,
      `TimeWork: ลิงก์ตั้งรหัสผ่านใหม่ ใช้ได้ ${RESET_MINUTES} นาที และใช้ได้ครั้งเดียว\n${link}`);
    // ไม่ได้ผูก LINE ก็ยังต้องมีทางไปต่อ ผู้ดูแลระบบหยิบลิงก์จาก log ให้ได้
    if (!sent) app.log.warn({ email, link }, 'password reset link could not be pushed to LINE');
  }
  // ตอบสำเร็จเสมอ ไม่ว่าอีเมลนั้นจะมีอยู่หรือไม่
  return reply.send({ ok: true });
});

app.post<{ Body: { token?: string } }>('/auth/reset/check', async (request, reply) => {
  const token = String(request.body?.token ?? '');
  if (!token) return reply.code(400).send({ error: 'ลิงก์ไม่ถูกต้อง' });
  const { rows } = await db.query(
    `SELECT a.email FROM password_resets r JOIN admins a ON a.id = r.admin_id
     WHERE r.token_hash = $1 AND r.used_at IS NULL AND r.expires_at > NOW()`, [hashToken(token)]);
  if (!rows.length) return reply.code(400).send({ error: 'ลิงก์หมดอายุหรือถูกใช้ไปแล้ว กรุณาขอลิงก์ใหม่' });
  return { email: rows[0].email };
});

app.post<{ Body: { token?: string; password?: string } }>('/auth/reset', async (request, reply) => {
  const token = String(request.body?.token ?? '');
  const password = String(request.body?.password ?? '');
  if (!token) return reply.code(400).send({ error: 'ลิงก์ไม่ถูกต้อง' });
  if (password.length < 8) return reply.code(400).send({ error: 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร' });
  const { rows } = await db.query(
    `SELECT admin_id FROM password_resets
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()`, [hashToken(token)]);
  if (!rows.length) return reply.code(400).send({ error: 'ลิงก์หมดอายุหรือถูกใช้ไปแล้ว กรุณาขอลิงก์ใหม่' });
  const adminId = rows[0].admin_id;
  await db.query('UPDATE admins SET password_hash = $2, failed_attempts = 0, locked_until = NULL WHERE id = $1',
    [adminId, await hashPassword(password)]);
  await db.query('UPDATE password_resets SET used_at = NOW() WHERE token_hash = $1', [hashToken(token)]);
  // ตั้งรหัสใหม่แล้วต้องเตะทุกอุปกรณ์ที่ค้างอยู่ออก
  await db.query('DELETE FROM admin_sessions WHERE admin_id = $1', [adminId]);
  return { ok: true };
});


const EMPLOYEE_FIELDS = `id, employee_code, name, line_user_id, active, national_id, phone,
  address, ethnicity, shift_id, employee_type_id, department_id, can_submit_expense,
  to_char(start_date, 'YYYY-MM-DD') AS start_date`;

const EMPLOYEE_TYPE_FIELDS = `id, name, pay_type, pay_rate::float8 AS pay_rate, note, active,
  ot_multiplier::float8 AS ot_multiplier, late_deduct_per_minute::float8 AS late_deduct_per_minute,
  monthly_days_divisor, work_hours_per_day::float8 AS work_hours_per_day`;

const SHIFT_FIELDS = `id, name, to_char(start_time, 'HH24:MI') AS start_time,
  to_char(end_time, 'HH24:MI') AS end_time, grace_minutes, break_minutes, active`;

// นาทีที่สาย = เวลาเข้าจริงตามเวลาไทย ลบเวลาเข้ากะ แล้วหักเวลาอนุโลมออก
// ระยะทางวงกลมใหญ่เป็นเมตร ใช้ตรวจว่าพิกัดที่ลงเวลาอยู่ในรัศมีของสถานที่ทำงานหรือไม่
const nearestSiteJoin = (latExpression: string, lngExpression: string) => `
  LEFT JOIN LATERAL (
    SELECT ws.name AS site_name, ws.radius_m,
           ROUND(measured.distance)::int AS distance_m,
           (measured.distance <= ws.radius_m) AS inside_site
    FROM work_sites ws
    CROSS JOIN LATERAL (
      SELECT 2 * 6371000 * asin(sqrt(
        power(sin(radians(${latExpression} - ws.latitude) / 2), 2) +
        cos(radians(ws.latitude)) * cos(radians(${latExpression})) *
        power(sin(radians(${lngExpression} - ws.longitude) / 2), 2)
      )) AS distance
    ) measured
    WHERE ws.active
    ORDER BY measured.distance
    LIMIT 1
  ) site ON ${latExpression} IS NOT NULL AND ${lngExpression} IS NOT NULL`;

const lateMinutesSql = (timestampExpression: string) => `GREATEST(0, FLOOR(EXTRACT(EPOCH FROM
  ((${timestampExpression} AT TIME ZONE 'Asia/Bangkok')::time - s.start_time)) / 60)::int - s.grace_minutes)`;

type EmployeeDetails = {
  departmentId?: string | number | null;
  employeeTypeId?: string | number | null;
  nationalId?: string | null;
  phone?: string | null;
  address?: string | null;
  startDate?: string | null;
  ethnicity?: string | null;
  shiftId?: string | number | null;
};

type ParsedValue = { value?: string; error?: string };

// เลขบัตรประชาชนไทยมี check digit ตัวที่ 13 คำนวณจาก 12 ตัวแรก จึงดักเลขที่พิมพ์ผิดได้
function parseNationalId(value: string): ParsedValue {
  const digits = value.replace(/\D/g, '');
  if (digits.length !== 13) return { error: 'เลขที่บัตรประชาชนต้องมี 13 หลัก' };
  let sum = 0;
  for (let index = 0; index < 12; index += 1) sum += Number(digits[index]) * (13 - index);
  if ((11 - (sum % 11)) % 10 !== Number(digits[12])) {
    return { error: 'เลขที่บัตรประชาชนไม่ถูกต้อง กรุณาตรวจสอบตัวเลขอีกครั้ง' };
  }
  return { value: digits };
}

function parsePhone(value: string): ParsedValue {
  const cleaned = value.replace(/[\s\-().]/g, '');
  if (!/^\+?\d{9,15}$/.test(cleaned)) return { error: 'เบอร์โทรต้องเป็นตัวเลข 9 ถึง 15 หลัก' };
  return { value: cleaned };
}

function parseReference(value: string): ParsedValue {
  if (!/^\d+$/.test(value)) return { error: 'รหัสอ้างอิงไม่ถูกต้อง' };
  return { value };
}

function parseStartDate(value: string): ParsedValue {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    return { error: 'วันที่เริ่มงานต้องอยู่ในรูปแบบ ปปปป-ดด-วว' };
  }
  return { value };
}

// ชื่อคอลัมน์มาจากรายการคงที่ในฟังก์ชันนี้เท่านั้น ไม่ได้มาจาก key ที่ผู้ใช้ส่งมา
// ค่าว่างหมายถึงล้างข้อมูลออก (NULL) ส่วน undefined หมายถึงไม่แก้ไขคอลัมน์นั้น
function parseEmployeeDetails(body: EmployeeDetails) {
  const details: Record<string, string | null> = {};
  const validated: [keyof EmployeeDetails, string, (value: string) => ParsedValue][] = [
    ['nationalId', 'national_id', parseNationalId],
    ['phone', 'phone', parsePhone],
    ['startDate', 'start_date', parseStartDate],
    ['shiftId', 'shift_id', parseReference],
    ['employeeTypeId', 'employee_type_id', parseReference],
    ['departmentId', 'department_id', parseReference]
  ];
  for (const [key, column, parse] of validated) {
    if (body[key] === undefined) continue;
    const trimmed = String(body[key] ?? '').trim();
    if (!trimmed) { details[column] = null; continue; }
    const parsed = parse(trimmed);
    if (parsed.error) return { error: parsed.error };
    details[column] = parsed.value ?? null;
  }
  for (const [key, column] of [['address', 'address'], ['ethnicity', 'ethnicity']] as const) {
    if (body[key] === undefined) continue;
    details[column] = String(body[key] ?? '').trim() || null;
  }
  return { details };
}

// คืน HTTP status ที่เหมาะกับสาเหตุ ค่าอ้างอิงผิดเป็น 400 ส่วนข้อมูลซ้ำเป็น 409
function constraintMessage(error: unknown) {
  const { code, constraint } = error as { code?: string; constraint?: string };
  if (code === '23503' && constraint === 'employees_shift_id_fkey') return { status: 400, error: 'ไม่พบกะที่เลือก' };
  if (code === '23503' && constraint === 'employees_employee_type_id_fkey') return { status: 400, error: 'ไม่พบประเภทพนักงานที่เลือก' };
  if (code === '23503' && constraint === 'employees_department_id_fkey') return { status: 400, error: 'ไม่พบแผนกที่เลือก' };
  if (code === '23505' && constraint === 'departments_name_key') return { status: 409, error: 'ชื่อแผนกนี้มีอยู่ในระบบแล้ว' };
  if (code === '23505' && constraint === 'employee_types_name_key') return { status: 409, error: 'ชื่อประเภทพนักงานนี้มีอยู่ในระบบแล้ว' };
  if (code !== '23505') return null;
  if (constraint === 'employees_national_id_key') return { status: 409, error: 'เลขที่บัตรประชาชนนี้มีพนักงานคนอื่นใช้อยู่แล้ว' };
  if (constraint === 'employees_line_user_id_key') return { status: 409, error: 'LINE User ID นี้ถูกผูกกับพนักงานคนอื่นแล้ว' };
  if (constraint === 'shifts_name_key') return { status: 409, error: 'ชื่อกะนี้มีอยู่ในระบบแล้ว' };
  return { status: 409, error: 'รหัสพนักงานนี้มีอยู่ในระบบแล้ว' };
}

type ShiftInput = { name?: string; startTime?: string; endTime?: string; graceMinutes?: number | string; breakMinutes?: number | string; active?: boolean };

function parseTimeOfDay(value: string): ParsedValue {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return { error: 'เวลาต้องอยู่ในรูปแบบ ชช:นน เช่น 08:00' };
  return { value };
}

// ตอนสร้างกะต้องกรอกครบ ตอนแก้ไขจะอัปเดตเฉพาะฟิลด์ที่ส่งมา
function parseShift(body: ShiftInput, creating: boolean) {
  const updates: Record<string, string | number | boolean> = {};
  if (creating || body.name !== undefined) {
    const name = String(body.name ?? '').trim();
    if (!name) return { error: 'ต้องระบุชื่อกะ' };
    updates.name = name;
  }
  for (const [key, column] of [['startTime', 'start_time'], ['endTime', 'end_time']] as const) {
    if (!creating && body[key] === undefined) continue;
    const parsed = parseTimeOfDay(String(body[key] ?? '').trim());
    if (parsed.error) return { error: parsed.error };
    updates[column] = parsed.value ?? '';
  }
  if (creating || body.graceMinutes !== undefined) {
    const grace = Number(body.graceMinutes ?? 0);
    if (!Number.isInteger(grace) || grace < 0 || grace > 240) {
      return { error: 'เวลาอนุโลมสายต้องเป็นจำนวนเต็ม 0 ถึง 240 นาที' };
    }
    updates.grace_minutes = grace;
  }
  if (creating || body.breakMinutes !== undefined) {
    const breakMinutes = Number(body.breakMinutes ?? 60);
    if (!Number.isInteger(breakMinutes) || breakMinutes < 0 || breakMinutes > 480) {
      return { error: 'เวลาพักต้องเป็นจำนวนเต็ม 0 ถึง 480 นาที' };
    }
    updates.break_minutes = breakMinutes;
  }
  if (body.active !== undefined) updates.active = Boolean(body.active);
  return { updates };
}

app.get('/api/employees', async request => {
  // หัวหน้าแผนกเห็นเฉพาะคนในแผนกตัวเอง แผนกมาจาก session ไม่ใช่จาก client
  const team = request.teamDepartmentId ?? '';
  const { rows } = await db.query(`
    SELECT e.id, e.employee_code, e.name, e.line_user_id, e.active, e.national_id, e.phone,
           e.address, e.ethnicity, e.shift_id, e.employee_type_id, e.department_id,
           e.can_submit_expense, d.name AS department_name,
           to_char(e.start_date, 'YYYY-MM-DD') AS start_date,
           s.name AS shift_name, to_char(s.start_time, 'HH24:MI') AS shift_start_time,
           to_char(s.end_time, 'HH24:MI') AS shift_end_time,
           t.name AS employee_type_name, t.pay_type, t.pay_rate::float8 AS pay_rate
    FROM employees e
    LEFT JOIN shifts s ON s.id = e.shift_id
    LEFT JOIN employee_types t ON t.id = e.employee_type_id
    LEFT JOIN departments d ON d.id = e.department_id
    WHERE ($1 = '' OR e.department_id = NULLIF($1, '')::bigint)
    ORDER BY e.employee_code
  `, [team]);
  return rows;
});

app.post<{ Body: { employeeCode: string; name: string; lineUserId?: string } & EmployeeDetails }>('/api/employees', async (request, reply) => {
  const { employeeCode, name, lineUserId } = request.body;
  if (!employeeCode?.trim() || !name?.trim()) return reply.code(400).send({ error: 'ต้องระบุรหัสพนักงานและชื่อ' });
  const parsed = parseEmployeeDetails(request.body);
  if (parsed.error) return reply.code(400).send({ error: parsed.error });
  const details = parsed.details ?? {};
  try {
    const { rows } = await db.query(
      `INSERT INTO employees (employee_code, name, line_user_id, national_id, phone, address,
                              start_date, ethnicity, shift_id, employee_type_id, department_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${EMPLOYEE_FIELDS}`,
      [employeeCode.trim(), name.trim(), lineUserId?.trim() || null, details.national_id ?? null,
       details.phone ?? null, details.address ?? null, details.start_date ?? null, details.ethnicity ?? null,
       details.shift_id ?? null, details.employee_type_id ?? null, details.department_id ?? null]
    );
    return reply.code(201).send(rows[0]);
  } catch (error) {
    const constraint = constraintMessage(error);
    if (constraint) return reply.code(constraint.status).send({ error: constraint.error });
    throw error;
  }
});

app.patch<{ Params: { id: string }; Body: { name?: string; active?: boolean; canSubmitExpense?: boolean } & EmployeeDetails }>('/api/employees/:id', async (request, reply) => {
  if (!/^\d+$/.test(request.params.id)) return reply.code(400).send({ error: 'รหัสอ้างอิงพนักงานไม่ถูกต้อง' });
  const parsed = parseEmployeeDetails(request.body);
  if (parsed.error) return reply.code(400).send({ error: parsed.error });
  const updates: Record<string, string | boolean | null> = { ...(parsed.details ?? {}) };
  if (request.body.name !== undefined) {
    const name = String(request.body.name).trim();
    if (!name) return reply.code(400).send({ error: 'ต้องระบุชื่อพนักงาน' });
    updates.name = name;
  }
  if (request.body.active !== undefined) updates.active = Boolean(request.body.active);
  if (request.body.canSubmitExpense !== undefined) updates.can_submit_expense = Boolean(request.body.canSubmitExpense);
  const columns = Object.keys(updates);
  if (!columns.length) return reply.code(400).send({ error: 'ไม่มีข้อมูลที่ต้องแก้ไข' });
  const assignments = columns.map((column, index) => `${column} = $${index + 2}`).join(', ');
  try {
    const { rows } = await db.query(
      `UPDATE employees SET ${assignments} WHERE id = $1 RETURNING ${EMPLOYEE_FIELDS}`,
      [request.params.id, ...columns.map(column => updates[column])]
    );
    if (!rows.length) return reply.code(404).send({ error: 'ไม่พบพนักงาน' });
    return rows[0];
  } catch (error) {
    const constraint = constraintMessage(error);
    if (constraint) return reply.code(constraint.status).send({ error: constraint.error });
    throw error;
  }
});

// ===== บัญชีผู้ดูแลระบบ =====
// ทุกเส้นทางในหมวดนี้ต้องเป็นสิทธิ์ผู้ดูแลระบบ ตรวจซ้ำในตัว handler ไม่พึ่งการซ่อนเมนู
function requireAdminsPage(request: FastifyRequest, level: 'read' | 'write') {
  const permission = request.admin?.permissions.admins ?? 'none';
  if (level === 'read' ? !canRead(permission) : !canWrite(permission)) return 'ไม่มีสิทธิ์จัดการผู้ดูแลระบบ';
  return null;
}

const ADMIN_FIELDS = `id, email, name, phone, role, requested_role, department_id, line_user_id, status,
  request_note,
  to_char(created_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI') AS created_at,
  to_char(last_login_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI') AS last_login_at`;

app.get('/api/me', async request => {
  const me = request.admin!;
  return {
    id: me.id, email: me.email, name: me.name, role: me.role, role_label: ROLE_LABELS[me.role] ?? me.role,
    department_id: me.departmentId, via_api_key: me.viaApiKey, permissions: me.permissions
  };
});

app.get('/api/admins', async (request, reply) => {
  const denied = requireAdminsPage(request, 'read');
  if (denied) return reply.code(403).send({ error: denied });
  const { rows } = await db.query(
    `SELECT ${ADMIN_FIELDS} FROM admins WHERE status IN ('active','disabled') ORDER BY name`);
  return rows;
});

app.get('/api/admins/requests', async (request, reply) => {
  const denied = requireAdminsPage(request, 'read');
  if (denied) return reply.code(403).send({ error: denied });
  const { rows } = await db.query(
    `SELECT ${ADMIN_FIELDS} FROM admins WHERE status = 'pending' ORDER BY created_at`);
  return rows;
});

app.patch<{ Params: { id: string }; Body: { status?: string; role?: string; departmentId?: string | null; lineUserId?: string | null } }>(
  '/api/admins/:id', async (request, reply) => {
  const denied = requireAdminsPage(request, 'write');
  if (denied) return reply.code(403).send({ error: denied });
  if (!/^\d+$/.test(request.params.id)) return reply.code(400).send({ error: 'รหัสอ้างอิงไม่ถูกต้อง' });

  const current = await db.query('SELECT id, email, name, role, status, line_user_id FROM admins WHERE id = $1', [request.params.id]);
  if (!current.rowCount) return reply.code(404).send({ error: 'ไม่พบบัญชีผู้ดูแล' });
  const before = current.rows[0];

  const updates: Record<string, string | null> = {};
  if (request.body?.role !== undefined) {
    const role = String(request.body.role);
    if (!ROLES.includes(role as typeof ROLES[number])) return reply.code(400).send({ error: 'บทบาทไม่ถูกต้อง' });
    updates.role = role;
  }
  if (request.body?.status !== undefined) {
    const status = String(request.body.status);
    if (!['active', 'disabled', 'rejected'].includes(status)) return reply.code(400).send({ error: 'สถานะไม่ถูกต้อง' });
    updates.status = status;
  }
  if (request.body?.departmentId !== undefined) {
    const value = String(request.body.departmentId ?? '').trim();
    if (value && !/^\d+$/.test(value)) return reply.code(400).send({ error: 'รหัสแผนกไม่ถูกต้อง' });
    updates.department_id = value || null;
  }
  if (request.body?.lineUserId !== undefined) {
    const value = String(request.body.lineUserId ?? '').trim();
    updates.line_user_id = value || null;
  }
  if (!Object.keys(updates).length) return reply.code(400).send({ error: 'ไม่มีข้อมูลที่ต้องแก้ไข' });

  const nextRole = updates.role ?? before.role;
  const nextStatus = updates.status ?? before.status;
  // หัวหน้าแผนกต้องมีแผนกเสมอ ไม่งั้นตัวกรองของ server จะไม่มีค่าให้บังคับ
  if (nextRole === 'lead' && nextStatus === 'active') {
    const department = updates.department_id !== undefined
      ? updates.department_id
      : (await db.query('SELECT department_id FROM admins WHERE id = $1', [request.params.id])).rows[0].department_id;
    if (!department) return reply.code(400).send({ error: 'บทบาทหัวหน้าแผนกต้องเลือกแผนกที่ดูแลด้วย' });
  }
  // ต้องเหลือผู้ดูแลระบบที่เปิดใช้งานอย่างน้อยหนึ่งบัญชีเสมอ
  const losesAdmin = before.role === 'admin' && before.status === 'active'
    && (nextRole !== 'admin' || nextStatus !== 'active');
  if (losesAdmin) {
    const remaining = await db.query(
      "SELECT count(*)::int AS total FROM admins WHERE role = 'admin' AND status = 'active' AND id <> $1",
      [request.params.id]);
    if (remaining.rows[0].total === 0) {
      return reply.code(400).send({ error: 'ต้องมีผู้ดูแลระบบที่เปิดใช้งานอย่างน้อย 1 บัญชี' });
    }
  }

  const columns = Object.keys(updates);
  const assignments = columns.map((column, index) => `${column} = $${index + 2}`).join(', ');
  const approving = updates.status === 'active' && before.status === 'pending';
  const { rows } = await db.query(
    `UPDATE admins SET ${assignments}
       ${approving ? ', approved_by = NULLIF($1, $1), approved_at = NOW()' : ''}
     WHERE id = $1 RETURNING ${ADMIN_FIELDS}`,
    [request.params.id, ...columns.map(column => updates[column])]);
  if (approving && request.admin && !request.admin.viaApiKey) {
    await db.query('UPDATE admins SET approved_by = $2 WHERE id = $1', [request.params.id, request.admin.id]);
  }
  // ปิดบัญชีหรือเปลี่ยนบทบาทแล้ว session ที่ค้างอยู่ต้องถูกตัดทันที
  if (updates.status && updates.status !== 'active') {
    await db.query('DELETE FROM admin_sessions WHERE admin_id = $1', [request.params.id]);
  }
  if (updates.role && updates.role !== before.role) {
    await db.query('DELETE FROM admin_sessions WHERE admin_id = $1', [request.params.id]);
  }
  await writeAudit(request.admin ?? null, 'admin.update', before.email,
    { before: { role: before.role, status: before.status }, after: { role: nextRole, status: nextStatus } });

  const lineTarget = updates.line_user_id ?? before.line_user_id;
  if (approving) {
    await pushLine(lineTarget, `TimeWork: บัญชีของคุณได้รับอนุมัติแล้ว\nสิทธิ์ ${ROLE_LABELS[nextRole]}\nเข้าใช้งานที่ ${BASE_URL}/login`);
  } else if (updates.status === 'rejected') {
    await pushLine(lineTarget, 'TimeWork: คำขอใช้งานของคุณไม่ได้รับอนุมัติ กรุณาติดต่อผู้ดูแลระบบ');
  }
  return rows[0];
});

// ===== ตารางสิทธิ์ตามบทบาท =====
app.get('/api/role-permissions', async (request, reply) => {
  const denied = requireAdminsPage(request, 'read');
  if (denied) return reply.code(403).send({ error: denied });
  const { rows } = await db.query('SELECT role, page_key, level FROM role_permissions');
  const matrix: Record<string, Record<string, string>> = {};
  for (const role of ROLES) matrix[role] = Object.fromEntries(PAGE_KEYS.map(key => [key, 'none']));
  for (const row of rows) if (matrix[row.role]) matrix[row.role][row.page_key] = row.level;
  return {
    roles: ROLES.map(role => ({ key: role, label: ROLE_LABELS[role] })),
    pages: PAGE_KEYS.map(key => ({ key, label: PAGE_LABELS[key] })),
    levels: LEVELS,
    matrix
  };
});

app.patch<{ Body: { role?: string; pageKey?: string; level?: string } }>('/api/role-permissions', async (request, reply) => {
  const denied = requireAdminsPage(request, 'write');
  if (denied) return reply.code(403).send({ error: denied });
  const role = String(request.body?.role ?? '');
  const pageKey = String(request.body?.pageKey ?? '');
  const level = String(request.body?.level ?? '');
  if (!ROLES.includes(role as typeof ROLES[number])) return reply.code(400).send({ error: 'บทบาทไม่ถูกต้อง' });
  if (!PAGE_KEYS.includes(pageKey as typeof PAGE_KEYS[number])) return reply.code(400).send({ error: 'เมนูไม่ถูกต้อง' });
  if (!LEVELS.includes(level as Level)) return reply.code(400).send({ error: 'ระดับสิทธิ์ไม่ถูกต้อง' });
  // ผู้ดูแลระบบต้องเข้าถึงได้ทุกอย่างเสมอ ไม่งั้นแก้ตารางพลาดครั้งเดียวคือล็อกตัวเองออกถาวร
  if (role === 'admin') return reply.code(400).send({ error: 'สิทธิ์ของผู้ดูแลระบบถูกล็อกไว้ แก้ไม่ได้' });
  await db.query(
    `INSERT INTO role_permissions (role, page_key, level) VALUES ($1, $2, $3)
     ON CONFLICT (role, page_key) DO UPDATE SET level = EXCLUDED.level`, [role, pageKey, level]);
  await writeAudit(request.admin ?? null, 'permission.update', `${role}/${pageKey}`, { level });
  return { ok: true };
});

// ===== สิทธิ์การใช้งาน =====
// ผู้ดูแลเลือกได้จากหน้าเดียวว่าใครส่งรายการค่าใช้จ่ายผ่าน LINE ได้บ้าง
// รับมาเป็นรายการที่ให้สิทธิ์และรายการที่ถอนสิทธิ์ ไม่ใช่รายชื่อทั้งหมด
// เพราะหน้าจอกรองตามแผนกได้ ถ้าส่งมาทั้งชุดคนนอกตัวกรองจะโดนถอนสิทธิ์ไปด้วย
app.post<{ Body: { grant?: unknown; revoke?: unknown } }>('/api/permissions/expense', async (request, reply) => {
  const toIds = (value: unknown): number[] | null => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) return null;
    const ids: number[] = [];
    for (const item of value) {
      const id = Number(item);
      if (!Number.isSafeInteger(id) || id <= 0) return null;
      ids.push(id);
    }
    return [...new Set(ids)];
  };
  const grant = toIds(request.body?.grant);
  const revoke = toIds(request.body?.revoke);
  if (!grant || !revoke) return reply.code(400).send({ error: 'รายการพนักงานไม่ถูกต้อง' });
  const overlap = grant.filter(id => revoke.includes(id));
  if (overlap.length) return reply.code(400).send({ error: 'มีพนักงานที่ทั้งให้สิทธิ์และถอนสิทธิ์ในคำสั่งเดียวกัน' });
  if (!grant.length && !revoke.length) return reply.code(400).send({ error: 'ไม่มีสิทธิ์ที่ต้องเปลี่ยน' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const changed = await client.query(
      `UPDATE employees SET can_submit_expense = (id = ANY($1::bigint[]))
        WHERE id = ANY($2::bigint[])
          AND can_submit_expense IS DISTINCT FROM (id = ANY($1::bigint[]))
        RETURNING id, employee_code, can_submit_expense`,
      [grant, [...grant, ...revoke]]
    );
    await client.query('COMMIT');
    return {
      granted: changed.rows.filter(row => row.can_submit_expense).length,
      revoked: changed.rows.filter(row => !row.can_submit_expense).length
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

// ลำดับความสำคัญของตาราง: ตารางรายวันที่ > ตารางประจำสัปดาห์ > กะประจำในข้อมูลพนักงาน
// has_weekly ใช้แยกว่า "ไม่มีแถวของวันนั้น" คือวันหยุดตามตาราง หรือยังไม่เคยตั้งตารางเลย
const scheduleSourceSql = (dateExpression: string) => `
  SELECT e.id AS employee_id, e.employee_code, e.name, e.active,
         e.shift_id AS default_shift_id,
         (hw.employee_id IS NOT NULL) AS has_weekly,
         (o.employee_id IS NOT NULL) AS has_override,
         o.note AS override_note,
         CASE WHEN hw.employee_id IS NOT NULL THEN w.shift_id ELSE e.shift_id END AS base_shift_id,
         CASE WHEN o.employee_id IS NOT NULL THEN o.shift_id
              WHEN hw.employee_id IS NOT NULL THEN w.shift_id
              ELSE e.shift_id END AS effective_shift_id
  FROM employees e
  LEFT JOIN schedule_weekly w
    ON w.employee_id = e.id AND w.weekday = EXTRACT(DOW FROM ${dateExpression})::int
  LEFT JOIN (SELECT DISTINCT employee_id FROM schedule_weekly) hw ON hw.employee_id = e.id
  LEFT JOIN schedule_overrides o ON o.employee_id = e.id AND o.work_date = ${dateExpression}
`;

const scheduleSourceLabel = `CASE WHEN src.has_override THEN 'override'
       WHEN src.has_weekly THEN 'weekly'
       WHEN src.default_shift_id IS NOT NULL THEN 'default'
       ELSE 'none' END AS schedule_source`;

// คืนค่าที่ใช้เป็นพารามิเตอร์ SQL ได้เลย สตริงว่างหมายถึงไม่กรอง
function parseFilterId(value: string | undefined) {
  const trimmed = (value ?? '').trim();
  if (trimmed && !/^\d+$/.test(trimmed)) return { error: 'รหัสอ้างอิงไม่ถูกต้อง' };
  return { value: trimmed };
}

function parseIsoDate(value: string): ParsedValue {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    return { error: 'วันที่ต้องอยู่ในรูปแบบ ปปปป-ดด-วว' };
  }
  return { value };
}

// ตารางที่ใช้จริงของพนักงานทุกคนในวันที่ระบุ ใช้ทั้งหน้าตารางรายวันและการตรวจสอบ
app.get<{ Querystring: { date?: string } }>('/api/schedules/day', async (request, reply) => {
  const date = (request.query.date ?? '').trim() || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
  const parsed = parseIsoDate(date);
  if (parsed.error) return reply.code(400).send({ error: parsed.error });
  const { rows } = await db.query(`
    SELECT src.employee_id, src.employee_code, src.name, src.active,
           src.has_override, src.override_note,
           src.base_shift_id, base.name AS base_shift_name,
           src.effective_shift_id, eff.name AS effective_shift_name,
           to_char(eff.start_time, 'HH24:MI') AS effective_start_time,
           to_char(eff.end_time, 'HH24:MI') AS effective_end_time,
           ${scheduleSourceLabel}
    FROM (${scheduleSourceSql('$1::date')}) src
    LEFT JOIN shifts base ON base.id = src.base_shift_id
    LEFT JOIN shifts eff ON eff.id = src.effective_shift_id
    ORDER BY src.employee_code
  `, [parsed.value]);
  return { date: parsed.value, employees: rows };
});

// ตารางที่ใช้จริงของพนักงานทุกคนเป็นช่วงวันที่ ใช้แสดงมุมมองรายสัปดาห์ว่าใครอยู่กะไหน
app.get<{ Querystring: { from?: string; to?: string } }>('/api/schedules/range', async (request, reply) => {
  const from = parseIsoDate((request.query.from ?? '').trim());
  const to = parseIsoDate((request.query.to ?? '').trim());
  if (from.error || to.error) return reply.code(400).send({ error: from.error ?? to.error });
  if (from.value! > to.value!) return reply.code(400).send({ error: 'วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด' });
  const spanDays = Math.round((Date.parse(to.value!) - Date.parse(from.value!)) / 86400000) + 1;
  if (spanDays > 62) return reply.code(400).send({ error: 'ดูได้ครั้งละไม่เกิน 62 วัน' });
  const { rows } = await db.query(`
    WITH days AS (
      SELECT generate_series($1::date, $2::date, INTERVAL '1 day')::date AS work_date
    ),
    resolved AS (
      SELECT e.id AS employee_id, e.employee_code, e.name, e.active, day.work_date,
             (o.employee_id IS NOT NULL) AS has_override,
             o.note AS override_note,
             CASE WHEN o.employee_id IS NOT NULL THEN o.shift_id
                  WHEN hw.employee_id IS NOT NULL THEN w.shift_id
                  ELSE e.shift_id END AS shift_id,
             CASE WHEN o.employee_id IS NOT NULL THEN 'override'
                  WHEN hw.employee_id IS NOT NULL THEN 'weekly'
                  WHEN e.shift_id IS NOT NULL THEN 'default'
                  ELSE 'none' END AS schedule_source
      FROM employees e
      CROSS JOIN days day
      LEFT JOIN schedule_weekly w
        ON w.employee_id = e.id AND w.weekday = EXTRACT(DOW FROM day.work_date)::int
      LEFT JOIN (SELECT DISTINCT employee_id FROM schedule_weekly) hw ON hw.employee_id = e.id
      LEFT JOIN schedule_overrides o ON o.employee_id = e.id AND o.work_date = day.work_date
    )
    SELECT r.employee_id, r.employee_code, r.name, r.active,
           to_char(r.work_date, 'YYYY-MM-DD') AS work_date,
           r.has_override, r.override_note, r.schedule_source,
           r.shift_id, s.name AS shift_name,
           to_char(s.start_time, 'HH24:MI') AS start_time,
           to_char(s.end_time, 'HH24:MI') AS end_time,
           lv.leave_type, lv.note AS leave_note
    FROM resolved r
    LEFT JOIN shifts s ON s.id = r.shift_id
    LEFT JOIN leaves lv ON lv.employee_id = r.employee_id AND lv.work_date = r.work_date
    ORDER BY r.employee_code, r.work_date
  `, [from.value, to.value]);
  return { from: from.value, to: to.value, cells: rows };
});

const LEAVE_TYPES = ['ลาป่วย', 'ลากิจ', 'ลาพักผ่อน', 'ลาคลอด', 'ลาสลับวันหยุด', 'ลาไม่รับค่าจ้าง'];

app.get('/api/leaves/types', async () => LEAVE_TYPES);

app.get<{ Querystring: { from?: string; to?: string } }>('/api/leaves', async (request, reply) => {
  const from = parseIsoDate((request.query.from ?? '').trim());
  const to = parseIsoDate((request.query.to ?? '').trim());
  if (from.error || to.error) return reply.code(400).send({ error: from.error ?? to.error });
  const { rows } = await db.query(`
    SELECT l.employee_id, e.employee_code, e.name,
           to_char(l.work_date, 'YYYY-MM-DD') AS work_date, l.leave_type, l.note
    FROM leaves l JOIN employees e ON e.id = l.employee_id
    WHERE l.work_date BETWEEN $1::date AND $2::date
    ORDER BY l.work_date DESC, e.employee_code
  `, [from.value, to.value]);
  return rows;
});

// บันทึกการลาเป็นช่วงวันที่ ใช้คำสั่งเดียวจึงเป็น all or nothing
app.post<{ Body: { employeeIds?: (string | number)[]; from?: string; to?: string; weekdays?: (string | number)[]; leaveType?: string; note?: string } }>('/api/leaves', async (request, reply) => {
  const employeeIds = (request.body.employeeIds ?? []).map(value => String(value).trim());
  if (!employeeIds.length) return reply.code(400).send({ error: 'ต้องเลือกพนักงานอย่างน้อย 1 คน' });
  if (!employeeIds.every(id => /^\d+$/.test(id))) return reply.code(400).send({ error: 'รหัสอ้างอิงพนักงานไม่ถูกต้อง' });
  const from = parseIsoDate(String(request.body.from ?? '').trim());
  const to = parseIsoDate(String(request.body.to ?? '').trim());
  if (from.error || to.error) return reply.code(400).send({ error: from.error ?? to.error });
  if (from.value! > to.value!) return reply.code(400).send({ error: 'วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด' });
  const spanDays = Math.round((Date.parse(to.value!) - Date.parse(from.value!)) / 86400000) + 1;
  if (spanDays > 186) return reply.code(400).send({ error: 'บันทึกได้ครั้งละไม่เกิน 186 วัน' });
  const leaveType = String(request.body.leaveType ?? '').trim();
  if (!LEAVE_TYPES.includes(leaveType)) return reply.code(400).send({ error: `ประเภทการลาต้องเป็นหนึ่งใน ${LEAVE_TYPES.join(' ')}` });
  const weekdaysInput = request.body.weekdays ?? [0, 1, 2, 3, 4, 5, 6];
  const weekdays = weekdaysInput.map(value => Number(value));
  if (!weekdays.length) return reply.code(400).send({ error: 'ต้องเลือกวันในสัปดาห์อย่างน้อย 1 วัน' });
  if (!weekdays.every(day => Number.isInteger(day) && day >= 0 && day <= 6)) {
    return reply.code(400).send({ error: 'วันในสัปดาห์ต้องเป็นเลข 0 ถึง 6' });
  }
  const note = String(request.body.note ?? '').trim() || null;
  const existing = await db.query('SELECT COUNT(*)::int AS found FROM employees WHERE id = ANY($1::bigint[])', [employeeIds]);
  if (existing.rows[0].found !== new Set(employeeIds).size) return reply.code(400).send({ error: 'มีพนักงานที่ไม่พบในระบบ' });
  const { rowCount } = await db.query(`
    INSERT INTO leaves (employee_id, work_date, leave_type, note)
    SELECT employee.id, day.work_date, $4, $5
    FROM UNNEST($1::bigint[]) AS employee(id)
    CROSS JOIN (SELECT generate_series($2::date, $3::date, INTERVAL '1 day')::date AS work_date) AS day
    WHERE EXTRACT(DOW FROM day.work_date)::int = ANY($6::int[])
    ON CONFLICT (employee_id, work_date) DO UPDATE SET leave_type = EXCLUDED.leave_type, note = EXCLUDED.note
  `, [employeeIds, from.value, to.value, leaveType, note, weekdays]);
  return { saved: rowCount ?? 0 };
});

app.delete<{ Params: { employeeId: string; workDate: string } }>('/api/leaves/:employeeId/:workDate', async (request, reply) => {
  if (!/^\d+$/.test(request.params.employeeId)) return reply.code(400).send({ error: 'รหัสอ้างอิงพนักงานไม่ถูกต้อง' });
  const workDate = parseIsoDate(request.params.workDate);
  if (workDate.error) return reply.code(400).send({ error: workDate.error });
  await db.query('DELETE FROM leaves WHERE employee_id = $1 AND work_date = $2::date', [request.params.employeeId, workDate.value]);
  return reply.code(204).send();
});

// ===== ลงเวลาผ่าน LIFF พร้อมพิกัด GPS =====
// ยืนยันตัวตนด้วย access token ของ LINE แล้วเทียบ client_id กับ channel ของเรา
// ถ้าไม่ตั้ง LINE_LOGIN_CHANNEL_ID ระบบจะปฏิเสธทั้งหมด ไม่ปล่อยผ่าน
async function verifyLiffUser(accessToken: string) {
  const channelId = (process.env.LINE_LOGIN_CHANNEL_ID ?? '').trim();
  if (!channelId) return { status: 503, error: 'ระบบยังไม่ได้ตั้งค่า LINE_LOGIN_CHANNEL_ID กรุณาแจ้งผู้ดูแล' };
  if (!accessToken) return { status: 401, error: 'ไม่พบ access token จาก LINE' };
  const verified = await fetch(`https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(accessToken)}`);
  if (!verified.ok) return { status: 401, error: 'access token ไม่ถูกต้องหรือหมดอายุ กรุณาเปิดหน้านี้ใหม่' };
  const info = await verified.json() as { client_id?: string };
  if (info.client_id !== channelId) {
    // มักเกิดจากใส่ Channel ID ของ Messaging API channel แทนของ LINE Login channel
    return { status: 401, error: 'ตั้งค่า LINE_LOGIN_CHANNEL_ID ไม่ตรงกับ channel ของหน้านี้ กรุณาแจ้งผู้ดูแลให้ตรวจ Channel ID ของ LINE Login channel' };
  }
  const profile = await fetch('https://api.line.me/v2/profile', { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!profile.ok) return { status: 401, error: 'อ่านโปรไฟล์ LINE ไม่สำเร็จ' };
  const { userId, displayName } = await profile.json() as { userId?: string; displayName?: string };
  if (!userId) return { status: 401, error: 'ไม่พบ LINE User ID' };
  return { userId, displayName: displayName ?? '' };
}

const BANGKOK_TODAY = "(NOW() AT TIME ZONE 'Asia/Bangkok')::date";

async function liffEmployee(userId: string) {
  const { rows } = await db.query(
    'SELECT id, employee_code, name, can_submit_expense FROM employees WHERE line_user_id = $1 AND active = TRUE',
    [userId]
  );
  return rows[0] ?? null;
}

// สถานะของวันนี้ ใช้ให้หน้า LIFF รู้ว่าต้องแสดงปุ่มอะไรและลงเวลาไปแล้วหรือยัง
async function liffTodayStatus(employeeId: string) {
  const { rows } = await db.query(`
    SELECT s.name AS shift_name,
           to_char(s.start_time, 'HH24:MI') AS shift_start,
           to_char(s.end_time, 'HH24:MI') AS shift_end,
           (s.id IS NULL AND (src.has_override OR src.has_weekly)) AS off_schedule,
           lv.leave_type,
           (SELECT to_char(MIN(t.occurred_at) AT TIME ZONE 'Asia/Bangkok', 'HH24:MI') FROM time_logs t
             WHERE t.employee_id = src.employee_id AND t.event_type = 'check_in'
               AND (t.occurred_at AT TIME ZONE 'Asia/Bangkok')::date = ${BANGKOK_TODAY}) AS first_in,
           (SELECT to_char(MAX(t.occurred_at) AT TIME ZONE 'Asia/Bangkok', 'HH24:MI') FROM time_logs t
             WHERE t.employee_id = src.employee_id AND t.event_type = 'check_out'
               AND (t.occurred_at AT TIME ZONE 'Asia/Bangkok')::date = ${BANGKOK_TODAY}) AS last_out
    FROM (${scheduleSourceSql(BANGKOK_TODAY)}) src
    LEFT JOIN shifts s ON s.id = src.effective_shift_id
    LEFT JOIN leaves lv ON lv.employee_id = src.employee_id AND lv.work_date = ${BANGKOK_TODAY}
    WHERE src.employee_id = $1
  `, [employeeId]);
  return rows[0] ?? null;
}

// หน้า LIFF ต้องรู้ LIFF ID ของตัวเอง เก็บไว้ที่ .env เป็นแหล่งเดียว
app.get('/api/liff/config', async () => ({ liffId: (process.env.LIFF_ID ?? '').trim() }));

app.post<{ Body: { accessToken?: string } }>('/api/liff/status', async (request, reply) => {
  const identity = await verifyLiffUser(String(request.body?.accessToken ?? '').trim());
  if (identity.error) return reply.code(identity.status).send({ error: identity.error });
  const employee = await liffEmployee(identity.userId!);
  if (!employee) {
    return reply.code(404).send({
      error: 'บัญชี LINE นี้ยังไม่ได้ผูกกับพนักงาน',
      hint: 'กลับไปที่แชทแล้วพิมพ์ ลงทะเบียน ตามด้วยรหัสพนักงาน เช่น ลงทะเบียน E001',
      displayName: identity.displayName
    });
  }
  const today = await liffTodayStatus(employee.id);
  const sites = await db.query('SELECT COUNT(*)::int AS total FROM work_sites WHERE active');
  return {
    employee_code: employee.employee_code,
    name: employee.name,
    // ส่งสิทธิ์มาตั้งแต่ตอนโหลดแรก หน้าเว็บจะได้แสดงแท็บค่าใช้จ่ายทันทีโดยไม่ต้องรอโหลดข้อมูลเงิน
    can_submit_expense: employee.can_submit_expense,
    date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date()),
    site_check_enabled: sites.rows[0].total > 0,
    ...today
  };
});

app.post<{ Body: { accessToken?: string; eventType?: string; latitude?: number; longitude?: number; accuracy?: number; address?: string } }>('/api/liff/check-in', async (request, reply) => {
  const identity = await verifyLiffUser(String(request.body?.accessToken ?? '').trim());
  if (identity.error) return reply.code(identity.status).send({ error: identity.error });
  const employee = await liffEmployee(identity.userId!);
  if (!employee) return reply.code(404).send({ error: 'บัญชี LINE นี้ยังไม่ได้ผูกกับพนักงาน' });

  const eventType = String(request.body?.eventType ?? '').trim();
  if (eventType !== 'check_in' && eventType !== 'check_out') {
    return reply.code(400).send({ error: 'ประเภทต้องเป็น check_in หรือ check_out' });
  }
  const latitude = Number(request.body?.latitude);
  const longitude = Number(request.body?.longitude);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return reply.code(400).send({ error: 'ไม่ได้รับพิกัดที่ถูกต้อง กรุณาอนุญาตให้เข้าถึงตำแหน่งแล้วลองใหม่' });
  }
  const accuracyInput = Number(request.body?.accuracy);
  const accuracy = Number.isFinite(accuracyInput) && accuracyInput >= 0 ? Math.round(accuracyInput * 10) / 10 : null;
  const address = String(request.body?.address ?? '').trim().slice(0, 255) || null;

  const existing = await db.query(
    `SELECT 1 FROM time_logs WHERE employee_id = $1 AND event_type = $2
       AND (occurred_at AT TIME ZONE 'Asia/Bangkok')::date = ${BANGKOK_TODAY} LIMIT 1`,
    [employee.id, eventType]
  );
  if (existing.rowCount) {
    return reply.code(409).send({ error: eventType === 'check_in' ? 'วันนี้ลงเวลาเข้าไปแล้ว' : 'วันนี้ลงเวลาออกไปแล้ว' });
  }
  if (eventType === 'check_out') {
    const checkedIn = await db.query(
      `SELECT 1 FROM time_logs WHERE employee_id = $1 AND event_type = 'check_in'
         AND (occurred_at AT TIME ZONE 'Asia/Bangkok')::date = ${BANGKOK_TODAY} LIMIT 1`,
      [employee.id]
    );
    if (!checkedIn.rowCount) return reply.code(409).send({ error: 'ยังไม่พบเวลาเข้างานของวันนี้' });
  }

  const inserted = await db.query(`
    INSERT INTO time_logs (employee_id, event_type, source, latitude, longitude, accuracy_m, location_address)
    VALUES ($1, $2, 'liff', $3, $4, $5, $6)
    RETURNING id, occurred_at, to_char(occurred_at AT TIME ZONE 'Asia/Bangkok', 'HH24:MI') AS time_of_day
  `, [employee.id, eventType, latitude, longitude, accuracy, address]);
  const record = inserted.rows[0];

  const detail = await db.query(`
    SELECT s.name AS shift_name, to_char(s.start_time, 'HH24:MI') AS shift_start,
           CASE WHEN s.id IS NOT NULL THEN ${lateMinutesSql('$1::timestamptz')} END AS late_minutes,
           (s.id IS NULL AND (src.has_override OR src.has_weekly)) AS off_schedule,
           site.site_name, site.distance_m, site.inside_site
    FROM (${scheduleSourceSql(BANGKOK_TODAY)}) src
    LEFT JOIN shifts s ON s.id = src.effective_shift_id
    ${nearestSiteJoin('$3::numeric', '$4::numeric')}
    WHERE src.employee_id = $2
  `, [record.occurred_at, employee.id, latitude, longitude]);
  const info = detail.rows[0] ?? {};

  return reply.code(201).send({
    employee_code: employee.employee_code,
    name: employee.name,
    event_type: eventType,
    time_of_day: record.time_of_day,
    accuracy_m: accuracy,
    shift_name: info.shift_name ?? null,
    shift_start: info.shift_start ?? null,
    late_minutes: eventType === 'check_in' ? info.late_minutes ?? null : null,
    off_schedule: Boolean(info.off_schedule),
    site_name: info.site_name ?? null,
    distance_m: info.distance_m ?? null,
    inside_site: info.site_name ? Boolean(info.inside_site) : null
  });
});

// ===== หน้าพนักงาน: ค่าตอบแทน เงินที่เบิก และรายการค่าใช้จ่ายของตัวเอง =====
function monthRangeOf(month: string) {
  const [year, index] = month.split('-').map(Number);
  const first = new Date(Date.UTC(year, index - 1, 1));
  const last = new Date(Date.UTC(year, index, 0));
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  return { from: iso(first), to: iso(last) };
}

app.post<{ Body: { accessToken?: string; month?: string } }>('/api/liff/summary', async (request, reply) => {
  const identity = await verifyLiffUser(String(request.body?.accessToken ?? '').trim());
  if (identity.error) return reply.code(identity.status).send({ error: identity.error });
  const employee = await db.query(
    'SELECT id, employee_code, name, can_submit_expense FROM employees WHERE line_user_id = $1 AND active = TRUE',
    [identity.userId]
  );
  if (!employee.rowCount) return reply.code(404).send({ error: 'บัญชี LINE นี้ยังไม่ได้ผูกกับพนักงาน' });
  const me = employee.rows[0];

  const requested = String(request.body?.month ?? '').trim();
  const currentMonth = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit' })
    .format(new Date()).slice(0, 7);
  const month = /^\d{4}-\d{2}$/.test(requested) ? requested : currentMonth;
  const { from, to } = monthRangeOf(month);

  const payroll = await computePayroll(from, to, String(me.id), '');
  const entries = await db.query(`
    SELECT to_char(entry_date, 'YYYY-MM-DD') AS entry_date, kind, amount::float8 AS amount, method, note
    FROM payroll_entries
    WHERE employee_id = $1 AND entry_date BETWEEN $2::date AND $3::date
    ORDER BY entry_date DESC, id DESC
  `, [me.id, from, to]);
  const expenses = await db.query(`
    SELECT id, to_char(claim_date, 'YYYY-MM-DD') AS claim_date, category, amount::float8 AS amount,
           detail, status, approved_amount::float8 AS approved_amount, review_note,
           (photo_file IS NOT NULL) AS has_photo
    FROM expense_claims
    WHERE employee_id = $1 AND claim_date BETWEEN $2::date AND $3::date
    ORDER BY claim_date DESC, id DESC
  `, [me.id, from, to]);

  return {
    employee_code: me.employee_code,
    name: me.name,
    can_submit_expense: me.can_submit_expense,
    month, from, to,
    pay: payroll[0] ?? null,
    entries: entries.rows,
    expenses: expenses.rows,
    categories: EXPENSE_CATEGORIES
  };
});

// bodyLimit สูงกว่าเส้นทางอื่นเพราะรูปถูกส่งมาเป็น base64 ซึ่งใหญ่กว่าไฟล์จริงราวหนึ่งในสาม
app.post<{ Body: { accessToken?: string; claimDate?: string; category?: string; amount?: number | string; detail?: string; photo?: string } }>('/api/liff/expenses', { bodyLimit: 6 * 1024 * 1024 }, async (request, reply) => {
  const identity = await verifyLiffUser(String(request.body?.accessToken ?? '').trim());
  if (identity.error) return reply.code(identity.status).send({ error: identity.error });
  const employee = await db.query(
    'SELECT id, can_submit_expense FROM employees WHERE line_user_id = $1 AND active = TRUE',
    [identity.userId]
  );
  if (!employee.rowCount) return reply.code(404).send({ error: 'บัญชี LINE นี้ยังไม่ได้ผูกกับพนักงาน' });
  if (!employee.rows[0].can_submit_expense) {
    return reply.code(403).send({ error: 'บัญชีของคุณยังไม่ได้รับสิทธิ์ส่งรายการค่าใช้จ่าย กรุณาแจ้งผู้ดูแล' });
  }
  const claimDate = parseIsoDate(String(request.body?.claimDate ?? '').trim());
  if (claimDate.error) return reply.code(400).send({ error: claimDate.error });
  const category = String(request.body?.category ?? '').trim();
  if (!EXPENSE_CATEGORIES.includes(category)) {
    return reply.code(400).send({ error: `ประเภทค่าใช้จ่ายต้องเป็นหนึ่งใน ${EXPENSE_CATEGORIES.join(' ')}` });
  }
  const amount = Number(request.body?.amount ?? 0);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000) {
    return reply.code(400).send({ error: 'จำนวนเงินต้องมากกว่า 0 และไม่เกิน 10,000,000' });
  }
  const detail = String(request.body?.detail ?? '').trim().slice(0, 200) || null;
  const photo = await saveExpensePhoto(request.body?.photo);
  if (photo && 'error' in photo) return reply.code(400).send({ error: photo.error });
  try {
    const { rows } = await db.query(`
      INSERT INTO expense_claims (employee_id, claim_date, category, amount, detail, photo_file, photo_mime, photo_bytes)
      VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8)
      RETURNING id, to_char(claim_date, 'YYYY-MM-DD') AS claim_date, category, amount::float8 AS amount, detail, status,
                (photo_file IS NOT NULL) AS has_photo
    `, [employee.rows[0].id, claimDate.value, category, Math.round(amount * 100) / 100, detail,
        photo?.file ?? null, photo?.mime ?? null, photo?.bytes ?? null]);
    return reply.code(201).send(rows[0]);
  } catch (error) {
    // บันทึกไม่สำเร็จก็ต้องไม่ทิ้งไฟล์ค้างไว้ในดิสก์
    await removeExpensePhoto(photo?.file);
    throw error;
  }
});

// พนักงานดูได้เฉพาะรูปของรายการตัวเอง ใช้ POST เพราะต้องส่ง access token ของ LINE มาด้วย
app.post<{ Body: { accessToken?: string; id?: string | number } }>('/api/liff/expenses/photo', async (request, reply) => {
  const identity = await verifyLiffUser(String(request.body?.accessToken ?? '').trim());
  if (identity.error) return reply.code(identity.status).send({ error: identity.error });
  const employee = await db.query('SELECT id FROM employees WHERE line_user_id = $1 AND active = TRUE', [identity.userId]);
  if (!employee.rowCount) return reply.code(404).send({ error: 'บัญชี LINE นี้ยังไม่ได้ผูกกับพนักงาน' });
  const id = String(request.body?.id ?? '').trim();
  if (!/^\d+$/.test(id)) return reply.code(400).send({ error: 'รหัสอ้างอิงรายการไม่ถูกต้อง' });
  const { rows } = await db.query(
    'SELECT photo_file, photo_mime FROM expense_claims WHERE id = $1 AND employee_id = $2',
    [id, employee.rows[0].id]
  );
  if (!rows.length || !rows[0].photo_file) return reply.code(404).send({ error: 'ไม่พบรูปใบเสร็จ' });
  return sendPhoto(reply, rows[0].photo_file, rows[0].photo_mime ?? 'image/jpeg');
});

// ลบได้เฉพาะรายการของตัวเองที่ยังไม่ถูกตรวจ
app.post<{ Body: { accessToken?: string; id?: string | number } }>('/api/liff/expenses/cancel', async (request, reply) => {
  const identity = await verifyLiffUser(String(request.body?.accessToken ?? '').trim());
  if (identity.error) return reply.code(identity.status).send({ error: identity.error });
  const employee = await db.query('SELECT id FROM employees WHERE line_user_id = $1 AND active = TRUE', [identity.userId]);
  if (!employee.rowCount) return reply.code(404).send({ error: 'บัญชี LINE นี้ยังไม่ได้ผูกกับพนักงาน' });
  const id = String(request.body?.id ?? '').trim();
  if (!/^\d+$/.test(id)) return reply.code(400).send({ error: 'รหัสอ้างอิงรายการไม่ถูกต้อง' });
  const { rows } = await db.query(
    "DELETE FROM expense_claims WHERE id = $1 AND employee_id = $2 AND status = 'pending' RETURNING photo_file",
    [id, employee.rows[0].id]
  );
  if (!rows.length) return reply.code(400).send({ error: 'ลบได้เฉพาะรายการของตัวเองที่ยังรอตรวจอยู่' });
  await removeExpensePhoto(rows[0].photo_file);
  return reply.code(204).send();
});

// แต่ละหน้าของพนักงานมี URL ของตัวเอง ริชเมนูชี้มาหน้าไหนก็เห็นเฉพาะหน้านั้น
for (const path of ['/liff', '/liff/pay', '/liff/advance', '/liff/expense']) {
  app.get(path, async (request, reply) => reply.sendFile('liff.html'));
}

// ===== วันที่พนักงานลืมลงเวลา =====
// ดูเฉพาะวันที่ผ่านมาแล้ว วันนี้ยังไม่นับว่าลืมเพราะอาจยังไม่เลิกงาน
app.get<{ Querystring: { from?: string; to?: string; employeeId?: string; departmentId?: string } }>('/api/time-logs/missing', async (request, reply) => {
  const from = parseIsoDate((request.query.from ?? '').trim());
  const to = parseIsoDate((request.query.to ?? '').trim());
  if (from.error || to.error) return reply.code(400).send({ error: from.error ?? to.error });
  if (from.value! > to.value!) return reply.code(400).send({ error: 'วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด' });
  const spanDays = Math.round((Date.parse(to.value!) - Date.parse(from.value!)) / 86400000) + 1;
  if (spanDays > 186) return reply.code(400).send({ error: 'ดูได้ครั้งละไม่เกิน 186 วัน' });
  const employeeId = (request.query.employeeId ?? '').trim();
  if (employeeId && !/^\d+$/.test(employeeId)) return reply.code(400).send({ error: 'รหัสอ้างอิงพนักงานไม่ถูกต้อง' });
  const departmentFilter = parseFilterId(request.query.departmentId);
  if (departmentFilter.error) return reply.code(400).send({ error: 'รหัสอ้างอิงแผนกไม่ถูกต้อง' });
  const { rows } = await db.query(`
    WITH days AS (
      SELECT generate_series($1::date, $2::date, INTERVAL '1 day')::date AS work_date
    ),
    base AS (
      SELECT e.id AS employee_id, e.employee_code, e.name, dept.name AS department_name, day.work_date,
             CASE WHEN o.employee_id IS NOT NULL THEN o.shift_id
                  WHEN hw.employee_id IS NOT NULL THEN w.shift_id
                  ELSE e.shift_id END AS shift_id
      FROM employees e
      CROSS JOIN days day
      LEFT JOIN schedule_weekly w
        ON w.employee_id = e.id AND w.weekday = EXTRACT(DOW FROM day.work_date)::int
      LEFT JOIN (SELECT DISTINCT employee_id FROM schedule_weekly) hw ON hw.employee_id = e.id
      LEFT JOIN schedule_overrides o ON o.employee_id = e.id AND o.work_date = day.work_date
      LEFT JOIN departments dept ON dept.id = e.department_id
      WHERE e.active
        AND day.work_date < (NOW() AT TIME ZONE 'Asia/Bangkok')::date
        AND ($3 = '' OR e.id = NULLIF($3, '')::bigint)
        AND ($4 = '' OR e.department_id = NULLIF($4, '')::bigint)
    ),
    scans AS (
      SELECT t.employee_id, (t.occurred_at AT TIME ZONE 'Asia/Bangkok')::date AS work_date,
             MIN(CASE WHEN t.event_type = 'check_in' THEN t.occurred_at AT TIME ZONE 'Asia/Bangkok' END) AS first_in,
             MAX(CASE WHEN t.event_type = 'check_out' THEN t.occurred_at AT TIME ZONE 'Asia/Bangkok' END) AS last_out
      FROM time_logs t
      WHERE (t.occurred_at AT TIME ZONE 'Asia/Bangkok')::date BETWEEN $1::date AND $2::date
      GROUP BY 1, 2
    )
    SELECT b.employee_id, b.employee_code, b.name, b.department_name,
           to_char(b.work_date, 'YYYY-MM-DD') AS work_date,
           s.name AS shift_name,
           to_char(s.start_time, 'HH24:MI') AS shift_start,
           to_char(s.end_time, 'HH24:MI') AS shift_end,
           to_char(sc.first_in, 'HH24:MI') AS first_in,
           to_char(sc.last_out, 'HH24:MI') AS last_out,
           CASE WHEN sc.first_in IS NULL AND sc.last_out IS NULL THEN 'absent'
                WHEN sc.last_out IS NULL THEN 'missing_out'
                ELSE 'missing_in' END AS issue
    FROM base b
    JOIN shifts s ON s.id = b.shift_id
    LEFT JOIN scans sc ON sc.employee_id = b.employee_id AND sc.work_date = b.work_date
    LEFT JOIN leaves lv ON lv.employee_id = b.employee_id AND lv.work_date = b.work_date
    WHERE lv.employee_id IS NULL AND (sc.first_in IS NULL OR sc.last_out IS NULL)
    ORDER BY b.work_date DESC, b.employee_code
  `, [from.value, to.value, employeeId, departmentFilter.value]);
  return rows;
});

// รายการที่ผู้ดูแลบันทึกย้อนหลัง แยกจากการสแกนผ่าน LINE ด้วยคอลัมน์ source
app.get<{ Querystring: { from?: string; to?: string; employeeId?: string } }>('/api/time-logs/manual', async (request, reply) => {
  const from = parseIsoDate((request.query.from ?? '').trim());
  const to = parseIsoDate((request.query.to ?? '').trim());
  if (from.error || to.error) return reply.code(400).send({ error: from.error ?? to.error });
  const employeeId = (request.query.employeeId ?? '').trim();
  if (employeeId && !/^\d+$/.test(employeeId)) return reply.code(400).send({ error: 'รหัสอ้างอิงพนักงานไม่ถูกต้อง' });
  const { rows } = await db.query(`
    SELECT t.id, t.employee_id, e.employee_code, e.name, t.event_type, t.note,
           to_char(t.occurred_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD') AS work_date,
           to_char(t.occurred_at AT TIME ZONE 'Asia/Bangkok', 'HH24:MI') AS time_of_day,
           to_char(t.created_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI') AS created_at
    FROM time_logs t JOIN employees e ON e.id = t.employee_id
    WHERE t.source = 'manual'
      AND (t.occurred_at AT TIME ZONE 'Asia/Bangkok')::date BETWEEN $1::date AND $2::date
      AND ($3 = '' OR t.employee_id = NULLIF($3, '')::bigint)
    ORDER BY t.occurred_at DESC, t.id DESC
  `, [from.value, to.value, employeeId]);
  return rows;
});

app.post<{ Body: { employeeId?: string | number; workDate?: string; eventType?: string; time?: string; note?: string } }>('/api/time-logs/manual', async (request, reply) => {
  const employeeId = String(request.body.employeeId ?? '').trim();
  if (!/^\d+$/.test(employeeId)) return reply.code(400).send({ error: 'ต้องเลือกพนักงาน' });
  const workDate = parseIsoDate(String(request.body.workDate ?? '').trim());
  if (workDate.error) return reply.code(400).send({ error: workDate.error });
  const eventType = String(request.body.eventType ?? '').trim();
  if (eventType !== 'check_in' && eventType !== 'check_out') {
    return reply.code(400).send({ error: 'ประเภทต้องเป็น check_in หรือ check_out' });
  }
  const time = parseTimeOfDay(String(request.body.time ?? '').trim());
  if (time.error) return reply.code(400).send({ error: time.error });
  const note = String(request.body.note ?? '').trim() || 'บันทึกย้อนหลังโดยผู้ดูแล';

  const employee = await db.query('SELECT 1 FROM employees WHERE id = $1', [employeeId]);
  if (!employee.rowCount) return reply.code(404).send({ error: 'ไม่พบพนักงาน' });
  const existing = await db.query(
    `SELECT 1 FROM time_logs
     WHERE employee_id = $1 AND event_type = $2
       AND (occurred_at AT TIME ZONE 'Asia/Bangkok')::date = $3::date LIMIT 1`,
    [employeeId, eventType, workDate.value]
  );
  if (existing.rowCount) {
    return reply.code(409).send({ error: eventType === 'check_in' ? 'วันนี้มีเวลาเข้างานอยู่แล้ว' : 'วันนี้มีเวลาออกงานอยู่แล้ว' });
  }
  const { rows } = await db.query(`
    INSERT INTO time_logs (employee_id, event_type, occurred_at, source, note)
    VALUES ($1, $2, ($3::date + $4::time) AT TIME ZONE 'Asia/Bangkok', 'manual', $5)
    RETURNING id, event_type,
              to_char(occurred_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD') AS work_date,
              to_char(occurred_at AT TIME ZONE 'Asia/Bangkok', 'HH24:MI') AS time_of_day
  `, [employeeId, eventType, workDate.value, time.value, note]);
  return reply.code(201).send(rows[0]);
});

// ลบได้เฉพาะรายการที่บันทึกย้อนหลัง เพื่อไม่ให้ลบหลักฐานการสแกนจริงจาก LINE
app.delete<{ Params: { id: string } }>('/api/time-logs/manual/:id', async (request, reply) => {
  if (!/^\d+$/.test(request.params.id)) return reply.code(400).send({ error: 'รหัสอ้างอิงรายการไม่ถูกต้อง' });
  const { rowCount } = await db.query("DELETE FROM time_logs WHERE id = $1 AND source = 'manual'", [request.params.id]);
  if (!rowCount) return reply.code(400).send({ error: 'ลบได้เฉพาะรายการที่บันทึกย้อนหลัง ไม่สามารถลบการสแกนจาก LINE ได้' });
  return reply.code(204).send();
});

// ===== รายการค่าใช้จ่ายที่พนักงานส่งเข้ามา =====
const EXPENSE_CATEGORIES = ['ค่าเดินทาง', 'ค่าน้ำมัน', 'ค่าอาหาร', 'ค่าที่พัก', 'ค่าวัสดุอุปกรณ์', 'ค่าโทรศัพท์/อินเทอร์เน็ต', 'อื่นๆ'];
const EXPENSE_STATUSES = ['pending', 'approved', 'rejected'];

app.get('/api/expenses/categories', async () => EXPENSE_CATEGORIES);

app.get<{ Querystring: { from?: string; to?: string; status?: string; employeeId?: string; departmentId?: string } }>('/api/expenses', async (request, reply) => {
  const from = parseIsoDate((request.query.from ?? '').trim());
  const to = parseIsoDate((request.query.to ?? '').trim());
  if (from.error || to.error) return reply.code(400).send({ error: from.error ?? to.error });
  const status = (request.query.status ?? '').trim();
  if (status && !EXPENSE_STATUSES.includes(status)) return reply.code(400).send({ error: 'สถานะต้องเป็น pending approved หรือ rejected' });
  const employeeFilter = parseFilterId(request.query.employeeId);
  const departmentFilter = parseFilterId(request.query.departmentId);
  if (employeeFilter.error || departmentFilter.error) return reply.code(400).send({ error: 'รหัสอ้างอิงไม่ถูกต้อง' });
  const { rows } = await db.query(`
    SELECT c.id, c.employee_id, e.employee_code, e.name, d.name AS department_name,
           to_char(c.claim_date, 'YYYY-MM-DD') AS claim_date,
           c.category, c.amount::float8 AS amount, c.detail, c.status,
           c.approved_amount::float8 AS approved_amount, c.review_note,
           to_char(c.created_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI') AS created_at,
           to_char(c.reviewed_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI') AS reviewed_at,
           (c.photo_file IS NOT NULL) AS has_photo
    FROM expense_claims c
    JOIN employees e ON e.id = c.employee_id
    LEFT JOIN departments d ON d.id = e.department_id
    WHERE c.claim_date BETWEEN $1::date AND $2::date
      AND ($3 = '' OR c.status = $3)
      AND ($4 = '' OR c.employee_id = NULLIF($4, '')::bigint)
      AND ($5 = '' OR e.department_id = NULLIF($5, '')::bigint)
    ORDER BY c.claim_date DESC, c.id DESC
  `, [from.value, to.value, status, employeeFilter.value, departmentFilter.value]);
  return rows;
});

app.get<{ Params: { id: string } }>('/api/expenses/:id/photo', async (request, reply) => {
  if (!/^\d+$/.test(request.params.id)) return reply.code(400).send({ error: 'รหัสอ้างอิงรายการไม่ถูกต้อง' });
  const { rows } = await db.query('SELECT photo_file, photo_mime FROM expense_claims WHERE id = $1', [request.params.id]);
  if (!rows.length || !rows[0].photo_file) return reply.code(404).send({ error: 'ไม่พบรูปใบเสร็จ' });
  return sendPhoto(reply, rows[0].photo_file, rows[0].photo_mime ?? 'image/jpeg');
});

app.patch<{ Params: { id: string }; Body: { status?: string; approvedAmount?: number | string | null; reviewNote?: string } }>('/api/expenses/:id', async (request, reply) => {
  if (!/^\d+$/.test(request.params.id)) return reply.code(400).send({ error: 'รหัสอ้างอิงรายการไม่ถูกต้อง' });
  const status = String(request.body?.status ?? '').trim();
  if (!EXPENSE_STATUSES.includes(status)) return reply.code(400).send({ error: 'สถานะต้องเป็น pending approved หรือ rejected' });
  const existing = await db.query('SELECT amount::float8 AS amount FROM expense_claims WHERE id = $1', [request.params.id]);
  if (!existing.rowCount) return reply.code(404).send({ error: 'ไม่พบรายการค่าใช้จ่าย' });

  let approvedAmount: number | null = null;
  if (status === 'approved') {
    const raw = request.body?.approvedAmount;
    const amount = raw === null || raw === undefined || String(raw).trim() === '' ? existing.rows[0].amount : Number(raw);
    if (!Number.isFinite(amount) || amount < 0 || amount > 10000000) {
      return reply.code(400).send({ error: 'ยอดที่อนุมัติต้องเป็นตัวเลข 0 ถึง 10,000,000' });
    }
    approvedAmount = Math.round(amount * 100) / 100;
  }
  const reviewNote = String(request.body?.reviewNote ?? '').trim() || null;
  const { rows } = await db.query(`
    UPDATE expense_claims
    SET status = $2::varchar, approved_amount = $3, review_note = $4,
        reviewed_at = CASE WHEN $2::varchar = 'pending' THEN NULL ELSE NOW() END
    WHERE id = $1
    RETURNING id, status, approved_amount::float8 AS approved_amount, review_note
  `, [request.params.id, status, approvedAmount, reviewNote]);
  return rows[0];
});

// ===== อนุมัติ OT รายวัน =====
// OT ที่ระบบคำนวณได้จะไม่จ่ายเงินจนกว่าจะมีแถวใน ot_approvals ของวันนั้น
const otDailySql = () => `
  WITH days AS (
    SELECT generate_series($1::date, $2::date, INTERVAL '1 day')::date AS work_date
  ),
  base AS (
    SELECT e.id AS employee_id, e.employee_code, e.name, dept.name AS department_name, day.work_date,
           CASE WHEN o.employee_id IS NOT NULL THEN o.shift_id
                WHEN hw.employee_id IS NOT NULL THEN w.shift_id
                ELSE e.shift_id END AS shift_id
    FROM employees e
    CROSS JOIN days day
    LEFT JOIN schedule_weekly w
      ON w.employee_id = e.id AND w.weekday = EXTRACT(DOW FROM day.work_date)::int
    LEFT JOIN (SELECT DISTINCT employee_id FROM schedule_weekly) hw ON hw.employee_id = e.id
    LEFT JOIN schedule_overrides o ON o.employee_id = e.id AND o.work_date = day.work_date
    LEFT JOIN departments dept ON dept.id = e.department_id
    WHERE ($3 = '' OR e.id = NULLIF($3, '')::bigint)
      AND ($4 = '' OR e.department_id = NULLIF($4, '')::bigint)
  ),
  scans AS (
    SELECT t.employee_id, (t.occurred_at AT TIME ZONE 'Asia/Bangkok')::date AS work_date,
           MIN(CASE WHEN t.event_type = 'check_in' THEN t.occurred_at AT TIME ZONE 'Asia/Bangkok' END) AS first_in,
           MAX(CASE WHEN t.event_type = 'check_out' THEN t.occurred_at AT TIME ZONE 'Asia/Bangkok' END) AS last_out
    FROM time_logs t
    WHERE (t.occurred_at AT TIME ZONE 'Asia/Bangkok')::date BETWEEN $1::date AND $2::date
    GROUP BY 1, 2
  ),
  daily AS (
    SELECT b.employee_id, b.employee_code, b.name, b.department_name, b.work_date,
           s.name AS shift_name,
           to_char(s.start_time, 'HH24:MI') AS shift_start,
           to_char(s.end_time, 'HH24:MI') AS shift_end,
           to_char(sc.first_in, 'HH24:MI') AS first_in,
           to_char(sc.last_out, 'HH24:MI') AS last_out,
           CASE WHEN s.id IS NOT NULL AND sc.last_out IS NOT NULL
                THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (sc.last_out::time - s.end_time)) / 60)::int)
                ELSE 0 END AS ot_minutes
    FROM base b
    LEFT JOIN shifts s ON s.id = b.shift_id
    LEFT JOIN scans sc ON sc.employee_id = b.employee_id AND sc.work_date = b.work_date
  )`;

app.get<{ Querystring: { from?: string; to?: string; employeeId?: string; departmentId?: string } }>('/api/ot', async (request, reply) => {
  const from = parseIsoDate((request.query.from ?? '').trim());
  const to = parseIsoDate((request.query.to ?? '').trim());
  if (from.error || to.error) return reply.code(400).send({ error: from.error ?? to.error });
  if (from.value! > to.value!) return reply.code(400).send({ error: 'วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด' });
  const spanDays = Math.round((Date.parse(to.value!) - Date.parse(from.value!)) / 86400000) + 1;
  if (spanDays > 186) return reply.code(400).send({ error: 'ดูได้ครั้งละไม่เกิน 186 วัน' });
  const employeeFilter = parseFilterId(request.query.employeeId);
  const departmentFilter = parseFilterId(request.query.departmentId);
  if (employeeFilter.error || departmentFilter.error) return reply.code(400).send({ error: 'รหัสอ้างอิงไม่ถูกต้อง' });

  const { rows } = await db.query(`
    ${otDailySql()}
    SELECT d.employee_id, d.employee_code, d.name, d.department_name,
           to_char(d.work_date, 'YYYY-MM-DD') AS work_date,
           d.shift_name, d.shift_start, d.shift_end, d.first_in, d.last_out, d.ot_minutes,
           (a.employee_id IS NOT NULL) AS approved,
           a.approved_minutes,
           a.note AS approval_note,
           CASE WHEN a.employee_id IS NULL THEN 0
                ELSE COALESCE(a.approved_minutes, d.ot_minutes) END AS paid_minutes
    FROM daily d
    LEFT JOIN ot_approvals a ON a.employee_id = d.employee_id AND a.work_date = d.work_date
    WHERE d.ot_minutes > 0 OR a.employee_id IS NOT NULL
    ORDER BY d.work_date DESC, d.employee_code
  `, [from.value, to.value, employeeFilter.value, departmentFilter.value]);
  return rows;
});

app.put<{ Body: { employeeId?: string | number; workDate?: string; approvedMinutes?: number | string | null; note?: string } }>('/api/ot/approve', async (request, reply) => {
  const employeeId = String(request.body?.employeeId ?? '').trim();
  if (!/^\d+$/.test(employeeId)) return reply.code(400).send({ error: 'ต้องเลือกพนักงาน' });
  const workDate = parseIsoDate(String(request.body?.workDate ?? '').trim());
  if (workDate.error) return reply.code(400).send({ error: workDate.error });
  const raw = request.body?.approvedMinutes;
  let approvedMinutes: number | null = null;
  if (raw !== null && raw !== undefined && String(raw).trim() !== '') {
    const minutes = Number(raw);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
      return reply.code(400).send({ error: 'นาที OT ที่อนุมัติต้องเป็นจำนวนเต็ม 0 ถึง 1440' });
    }
    approvedMinutes = minutes;
  }
  const note = String(request.body?.note ?? '').trim() || null;
  try {
    const { rows } = await db.query(`
      INSERT INTO ot_approvals (employee_id, work_date, approved_minutes, note)
      VALUES ($1, $2::date, $3, $4)
      ON CONFLICT (employee_id, work_date)
        DO UPDATE SET approved_minutes = EXCLUDED.approved_minutes, note = EXCLUDED.note
      RETURNING employee_id, to_char(work_date, 'YYYY-MM-DD') AS work_date, approved_minutes, note
    `, [employeeId, workDate.value, approvedMinutes, note]);
    return rows[0];
  } catch (error) {
    const { code } = error as { code?: string };
    if (code === '23503') return reply.code(400).send({ error: 'ไม่พบพนักงาน' });
    throw error;
  }
});

app.delete<{ Params: { employeeId: string; workDate: string } }>('/api/ot/approve/:employeeId/:workDate', async (request, reply) => {
  if (!/^\d+$/.test(request.params.employeeId)) return reply.code(400).send({ error: 'รหัสอ้างอิงพนักงานไม่ถูกต้อง' });
  const workDate = parseIsoDate(request.params.workDate);
  if (workDate.error) return reply.code(400).send({ error: workDate.error });
  await db.query('DELETE FROM ot_approvals WHERE employee_id = $1 AND work_date = $2::date',
    [request.params.employeeId, workDate.value]);
  return reply.code(204).send();
});

// อนุมัติทุกวันที่มี OT ในช่วงที่เลือกด้วยคำสั่งเดียว ใช้กับปุ่ม อนุมัติทั้งหมด
app.post<{ Body: { from?: string; to?: string; employeeId?: string; departmentId?: string; note?: string } }>('/api/ot/approve/bulk', async (request, reply) => {
  const from = parseIsoDate(String(request.body?.from ?? '').trim());
  const to = parseIsoDate(String(request.body?.to ?? '').trim());
  if (from.error || to.error) return reply.code(400).send({ error: from.error ?? to.error });
  if (from.value! > to.value!) return reply.code(400).send({ error: 'วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด' });
  const spanDays = Math.round((Date.parse(to.value!) - Date.parse(from.value!)) / 86400000) + 1;
  if (spanDays > 186) return reply.code(400).send({ error: 'อนุมัติได้ครั้งละไม่เกิน 186 วัน' });
  const employeeFilter = parseFilterId(request.body?.employeeId);
  const departmentFilter = parseFilterId(request.body?.departmentId);
  if (employeeFilter.error || departmentFilter.error) return reply.code(400).send({ error: 'รหัสอ้างอิงไม่ถูกต้อง' });
  const note = String(request.body?.note ?? '').trim() || null;
  const { rowCount } = await db.query(`
    ${otDailySql()}
    INSERT INTO ot_approvals (employee_id, work_date, note)
    SELECT d.employee_id, d.work_date, $5
    FROM daily d
    WHERE d.ot_minutes > 0
    ON CONFLICT (employee_id, work_date) DO NOTHING
  `, [from.value, to.value, employeeFilter.value, departmentFilter.value, note]);
  return { approved: rowCount ?? 0 };
});

// ===== การเบิกเงินและการจ่ายเงิน =====
const PAYROLL_KINDS = ['advance', 'payment'];

app.get<{ Querystring: { from?: string; to?: string; kind?: string } }>('/api/payroll/entries', async (request, reply) => {
  const from = parseIsoDate((request.query.from ?? '').trim());
  const to = parseIsoDate((request.query.to ?? '').trim());
  if (from.error || to.error) return reply.code(400).send({ error: from.error ?? to.error });
  const kind = (request.query.kind ?? '').trim();
  if (kind && !PAYROLL_KINDS.includes(kind)) return reply.code(400).send({ error: 'ประเภทรายการต้องเป็น advance หรือ payment' });
  const { rows } = await db.query(`
    SELECT p.id, p.employee_id, e.employee_code, e.name,
           to_char(p.entry_date, 'YYYY-MM-DD') AS entry_date,
           p.kind, p.amount::float8 AS amount, p.method, p.note
    FROM payroll_entries p JOIN employees e ON e.id = p.employee_id
    WHERE p.entry_date BETWEEN $1::date AND $2::date AND ($3 = '' OR p.kind = $3)
    ORDER BY p.entry_date DESC, p.id DESC
  `, [from.value, to.value, kind]);
  return rows;
});

app.post<{ Body: { employeeId?: string | number; entryDate?: string; kind?: string; amount?: number | string; method?: string; note?: string } }>('/api/payroll/entries', async (request, reply) => {
  const employeeId = String(request.body.employeeId ?? '').trim();
  if (!/^\d+$/.test(employeeId)) return reply.code(400).send({ error: 'ต้องเลือกพนักงาน' });
  const entryDate = parseIsoDate(String(request.body.entryDate ?? '').trim());
  if (entryDate.error) return reply.code(400).send({ error: entryDate.error });
  const kind = String(request.body.kind ?? '').trim();
  if (!PAYROLL_KINDS.includes(kind)) return reply.code(400).send({ error: 'ประเภทรายการต้องเป็น advance หรือ payment' });
  const amount = Number(request.body.amount ?? 0);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000) {
    return reply.code(400).send({ error: 'จำนวนเงินต้องมากกว่า 0 และไม่เกิน 10,000,000' });
  }
  const method = String(request.body.method ?? '').trim().slice(0, 20) || null;
  const note = String(request.body.note ?? '').trim() || null;
  try {
    const { rows } = await db.query(`
      INSERT INTO payroll_entries (employee_id, entry_date, kind, amount, method, note)
      VALUES ($1, $2::date, $3, $4, $5, $6)
      RETURNING id, employee_id, to_char(entry_date, 'YYYY-MM-DD') AS entry_date, kind, amount::float8 AS amount, method, note
    `, [employeeId, entryDate.value, kind, Math.round(amount * 100) / 100, method, note]);
    return reply.code(201).send(rows[0]);
  } catch (error) {
    const { code } = error as { code?: string };
    if (code === '23503') return reply.code(400).send({ error: 'ไม่พบพนักงาน' });
    throw error;
  }
});

app.delete<{ Params: { id: string } }>('/api/payroll/entries/:id', async (request, reply) => {
  if (!/^\d+$/.test(request.params.id)) return reply.code(400).send({ error: 'รหัสอ้างอิงรายการไม่ถูกต้อง' });
  await db.query('DELETE FROM payroll_entries WHERE id = $1', [request.params.id]);
  return reply.code(204).send();
});

// ===== คำนวณค่าจ้างตามช่วงวันที่ =====
// รวมสถิติการทำงานใน SQL แล้วคิดเงินใน TypeScript เพื่อให้อ่านสูตรได้ชัดและคืนที่มาของทุกยอด
// ใช้ร่วมกันระหว่างหน้าแอดมินกับหน้า LIFF ของพนักงาน จะได้ตัวเลขชุดเดียวกันเสมอ
async function computePayroll(from: string, to: string, employeeId: string, departmentId: string) {
  const { rows } = await db.query(`
    WITH days AS (
      SELECT generate_series($1::date, $2::date, INTERVAL '1 day')::date AS work_date
    ),
    base AS (
      SELECT e.id AS employee_id, e.employee_code, e.name, day.work_date,
             CASE WHEN o.employee_id IS NOT NULL THEN o.shift_id
                  WHEN hw.employee_id IS NOT NULL THEN w.shift_id
                  ELSE e.shift_id END AS shift_id
      FROM employees e
      CROSS JOIN days day
      LEFT JOIN schedule_weekly w
        ON w.employee_id = e.id AND w.weekday = EXTRACT(DOW FROM day.work_date)::int
      LEFT JOIN (SELECT DISTINCT employee_id FROM schedule_weekly) hw ON hw.employee_id = e.id
      LEFT JOIN schedule_overrides o ON o.employee_id = e.id AND o.work_date = day.work_date
      LEFT JOIN departments dept ON dept.id = e.department_id
      WHERE ($3 = '' OR e.id = NULLIF($3, '')::bigint)
        AND ($4 = '' OR e.department_id = NULLIF($4, '')::bigint)
    ),
    scans AS (
      SELECT t.employee_id, (t.occurred_at AT TIME ZONE 'Asia/Bangkok')::date AS work_date,
             MIN(CASE WHEN t.event_type = 'check_in' THEN t.occurred_at AT TIME ZONE 'Asia/Bangkok' END) AS first_in,
             MAX(CASE WHEN t.event_type = 'check_out' THEN t.occurred_at AT TIME ZONE 'Asia/Bangkok' END) AS last_out
      FROM time_logs t
      WHERE (t.occurred_at AT TIME ZONE 'Asia/Bangkok')::date BETWEEN $1::date AND $2::date
      GROUP BY 1, 2
    ),
    daily AS (
      SELECT b.employee_id, b.employee_code, b.name,
             (s.id IS NOT NULL) AS is_workday,
             (lv.employee_id IS NOT NULL) AS on_leave,
             sc.first_in, sc.last_out,
             CASE WHEN s.id IS NOT NULL AND sc.first_in IS NOT NULL AND lv.employee_id IS NULL
                  THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (sc.first_in::time - s.start_time)) / 60)::int - s.grace_minutes)
                  ELSE 0 END AS late_minutes,
             CASE WHEN s.id IS NOT NULL AND sc.last_out IS NOT NULL
                  THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (sc.last_out::time - s.end_time)) / 60)::int)
                  ELSE 0 END AS ot_minutes,
             -- จ่าย OT เฉพาะวันที่ผู้ดูแลอนุมัติ ไม่มีแถวอนุมัติ = ไม่จ่าย
             CASE WHEN ota.employee_id IS NOT NULL THEN 0
                  WHEN s.id IS NOT NULL AND sc.last_out IS NOT NULL
                  THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (sc.last_out::time - s.end_time)) / 60)::int)
                  ELSE 0 END AS ot_pending_minutes,
             CASE WHEN ota.employee_id IS NULL THEN 0
                  ELSE COALESCE(ota.approved_minutes,
                       CASE WHEN s.id IS NOT NULL AND sc.last_out IS NOT NULL
                            THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (sc.last_out::time - s.end_time)) / 60)::int)
                            ELSE 0 END)
             END AS ot_paid_minutes,
             CASE WHEN sc.first_in IS NOT NULL AND sc.last_out IS NOT NULL AND sc.last_out > sc.first_in
                  THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (sc.last_out - sc.first_in)) / 60)::int - COALESCE(s.break_minutes, 0))
                  ELSE 0 END AS worked_minutes
      FROM base b
      LEFT JOIN shifts s ON s.id = b.shift_id
      LEFT JOIN scans sc ON sc.employee_id = b.employee_id AND sc.work_date = b.work_date
      LEFT JOIN leaves lv ON lv.employee_id = b.employee_id AND lv.work_date = b.work_date
      LEFT JOIN ot_approvals ota ON ota.employee_id = b.employee_id AND ota.work_date = b.work_date
    )
    SELECT d.employee_id, d.employee_code, d.name, dept.name AS department_name,
           COUNT(*) FILTER (WHERE d.is_workday) AS scheduled_days,
           COUNT(*) FILTER (WHERE d.is_workday AND NOT d.on_leave AND d.first_in IS NOT NULL) AS worked_days,
           COUNT(*) FILTER (WHERE d.is_workday AND NOT d.on_leave AND d.first_in IS NULL AND d.last_out IS NULL) AS absent_days,
           COUNT(*) FILTER (WHERE d.on_leave) AS leave_days,
           COALESCE(SUM(d.late_minutes), 0)::int AS late_minutes,
           COALESCE(SUM(d.ot_minutes), 0)::int AS ot_minutes,
           COALESCE(SUM(d.ot_paid_minutes), 0)::int AS ot_paid_minutes,
           COALESCE(SUM(d.ot_pending_minutes), 0)::int AS ot_pending_minutes,
           COALESCE(SUM(d.worked_minutes), 0)::int AS worked_minutes,
           t.id AS employee_type_id, t.name AS employee_type_name, t.pay_type,
           t.pay_rate::float8 AS pay_rate, t.ot_multiplier::float8 AS ot_multiplier,
           t.late_deduct_per_minute::float8 AS late_deduct_per_minute,
           t.monthly_days_divisor, t.work_hours_per_day::float8 AS work_hours_per_day,
           COALESCE(adv.total, 0)::float8 AS advance_total,
           COALESCE(paid.total, 0)::float8 AS payment_total,
           COALESCE(exp.total, 0)::float8 AS approved_expense
    FROM daily d
    JOIN employees e ON e.id = d.employee_id
    LEFT JOIN departments dept ON dept.id = e.department_id
    LEFT JOIN employee_types t ON t.id = e.employee_type_id
    LEFT JOIN (SELECT employee_id, SUM(amount) AS total FROM payroll_entries
               WHERE kind = 'advance' AND entry_date BETWEEN $1::date AND $2::date GROUP BY 1) adv
      ON adv.employee_id = d.employee_id
    LEFT JOIN (SELECT employee_id, SUM(amount) AS total FROM payroll_entries
               WHERE kind = 'payment' AND entry_date BETWEEN $1::date AND $2::date GROUP BY 1) paid
      ON paid.employee_id = d.employee_id
    -- ค่าใช้จ่ายที่อนุมัติแล้วเป็นเงินที่พนักงานสำรองจ่ายไป จึงบวกคืนในยอดสุทธิ
    -- ตอนคืนเงินจริงจะถูกบันทึกเป็น payroll_entries kind payment แล้วหักกลบกันเองในยอดคงเหลือ
    LEFT JOIN (SELECT employee_id, SUM(COALESCE(approved_amount, 0)) AS total FROM expense_claims
               WHERE status = 'approved' AND claim_date BETWEEN $1::date AND $2::date GROUP BY 1) exp
      ON exp.employee_id = d.employee_id
    GROUP BY d.employee_id, d.employee_code, d.name, dept.name, t.id, t.name, t.pay_type, t.pay_rate,
             t.ot_multiplier, t.late_deduct_per_minute, t.monthly_days_divisor, t.work_hours_per_day,
             adv.total, paid.total, exp.total
    ORDER BY d.employee_code
  `, [from, to, employeeId, departmentId]);

  const round2 = (value: number) => Math.round(value * 100) / 100;
  const payroll = rows.map(row => {
    const rate = row.pay_rate ?? 0;
    const divisor = row.monthly_days_divisor ?? 30;
    const hoursPerDay = row.work_hours_per_day ?? 8;
    const monthly = row.pay_type === 'monthly';
    const dailyRate = monthly ? rate / divisor : rate;
    const hourlyRate = dailyRate / hoursPerDay;
    // รายวันจ่ายตามวันที่มาทำงาน รายเดือนจ่ายเต็มแล้วหักวันขาดงาน
    const basePay = monthly ? rate : Number(row.worked_days) * rate;
    const absentDeduct = monthly ? Number(row.absent_days) * dailyRate : 0;
    const otPay = (Number(row.ot_paid_minutes) / 60) * hourlyRate * (row.ot_multiplier ?? 0);
    const lateDeduct = Number(row.late_minutes) * (row.late_deduct_per_minute ?? 0);
    const approvedExpense = Number(row.approved_expense ?? 0);
    const netPay = basePay + otPay - absentDeduct - lateDeduct + approvedExpense;
    return {
      ...row,
      scheduled_days: Number(row.scheduled_days),
      ot_paid_minutes: Number(row.ot_paid_minutes),
      ot_pending_minutes: Number(row.ot_pending_minutes),
      worked_days: Number(row.worked_days),
      absent_days: Number(row.absent_days),
      leave_days: Number(row.leave_days),
      has_type: row.employee_type_id !== null,
      daily_rate: round2(dailyRate),
      hourly_rate: round2(hourlyRate),
      base_pay: round2(basePay),
      ot_pay: round2(otPay),
      absent_deduct: round2(absentDeduct),
      late_deduct: round2(lateDeduct),
      approved_expense: round2(approvedExpense),
      net_pay: round2(netPay),
      balance: round2(netPay - row.advance_total - row.payment_total)
    };
  });
  return payroll;
}

app.get<{ Querystring: { from?: string; to?: string; employeeId?: string; departmentId?: string } }>('/api/payroll', async (request, reply) => {
  const from = parseIsoDate((request.query.from ?? '').trim());
  const to = parseIsoDate((request.query.to ?? '').trim());
  if (from.error || to.error) return reply.code(400).send({ error: from.error ?? to.error });
  if (from.value! > to.value!) return reply.code(400).send({ error: 'วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด' });
  const spanDays = Math.round((Date.parse(to.value!) - Date.parse(from.value!)) / 86400000) + 1;
  if (spanDays > 186) return reply.code(400).send({ error: 'คำนวณได้ครั้งละไม่เกิน 186 วัน' });
  const employeeId = (request.query.employeeId ?? '').trim();
  if (employeeId && !/^\d+$/.test(employeeId)) return reply.code(400).send({ error: 'รหัสอ้างอิงพนักงานไม่ถูกต้อง' });
  const departmentFilter = parseFilterId(request.query.departmentId);
  if (departmentFilter.error) return reply.code(400).send({ error: 'รหัสอ้างอิงแผนกไม่ถูกต้อง' });
  const rows = await computePayroll(from.value!, to.value!, employeeId, departmentFilter.value!);
  return { from: from.value, to: to.value, rows };
});

app.get<{ Querystring: { from?: string; to?: string; employeeId?: string; departmentId?: string } }>('/api/reports/attendance', async (request, reply) => {
  const from = parseIsoDate((request.query.from ?? '').trim());
  const to = parseIsoDate((request.query.to ?? '').trim());
  if (from.error || to.error) return reply.code(400).send({ error: from.error ?? to.error });
  if (from.value! > to.value!) return reply.code(400).send({ error: 'วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด' });
  const spanDays = Math.round((Date.parse(to.value!) - Date.parse(from.value!)) / 86400000) + 1;
  if (spanDays > 186) return reply.code(400).send({ error: 'ออกรายงานได้ครั้งละไม่เกิน 186 วัน' });
  const employeeId = (request.query.employeeId ?? '').trim();
  if (employeeId && !/^\d+$/.test(employeeId)) return reply.code(400).send({ error: 'รหัสอ้างอิงพนักงานไม่ถูกต้อง' });
  const departmentFilter = parseFilterId(request.query.departmentId);
  if (departmentFilter.error) return reply.code(400).send({ error: 'รหัสอ้างอิงแผนกไม่ถูกต้อง' });

  const { rows } = await db.query(`
    WITH days AS (
      SELECT generate_series($1::date, $2::date, INTERVAL '1 day')::date AS work_date
    ),
    base AS (
      SELECT e.id AS employee_id, e.employee_code, e.name, dept.name AS department_name, day.work_date,
             o.note AS override_note,
             CASE WHEN o.employee_id IS NOT NULL THEN o.shift_id
                  WHEN hw.employee_id IS NOT NULL THEN w.shift_id
                  ELSE e.shift_id END AS shift_id
      FROM employees e
      CROSS JOIN days day
      LEFT JOIN schedule_weekly w
        ON w.employee_id = e.id AND w.weekday = EXTRACT(DOW FROM day.work_date)::int
      LEFT JOIN (SELECT DISTINCT employee_id FROM schedule_weekly) hw ON hw.employee_id = e.id
      LEFT JOIN schedule_overrides o ON o.employee_id = e.id AND o.work_date = day.work_date
      LEFT JOIN departments dept ON dept.id = e.department_id
      WHERE ($3 = '' OR e.id = NULLIF($3, '')::bigint)
        AND ($4 = '' OR e.department_id = NULLIF($4, '')::bigint)
    ),
    scans AS (
      SELECT t.employee_id,
             (t.occurred_at AT TIME ZONE 'Asia/Bangkok')::date AS work_date,
             MIN(CASE WHEN t.event_type = 'check_in' THEN t.occurred_at AT TIME ZONE 'Asia/Bangkok' END) AS first_in,
             MAX(CASE WHEN t.event_type = 'check_out' THEN t.occurred_at AT TIME ZONE 'Asia/Bangkok' END) AS last_out
      FROM time_logs t
      WHERE (t.occurred_at AT TIME ZONE 'Asia/Bangkok')::date BETWEEN $1::date AND $2::date
      GROUP BY 1, 2
    )
    SELECT b.employee_id, b.employee_code, b.name, b.department_name,
           to_char(b.work_date, 'YYYY-MM-DD') AS work_date,
           b.override_note,
           lv.leave_type, lv.note AS leave_note,
           (s.id IS NOT NULL) AS is_workday,
           s.name AS shift_name,
           to_char(s.start_time, 'HH24:MI') AS shift_start,
           to_char(s.end_time, 'HH24:MI') AS shift_end,
           COALESCE(s.break_minutes, 0) AS break_minutes,
           to_char(sc.first_in, 'HH24:MI') AS first_in,
           to_char(sc.last_out, 'HH24:MI') AS last_out,
           CASE WHEN s.id IS NOT NULL AND sc.first_in IS NOT NULL AND lv.employee_id IS NULL
                THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (sc.first_in::time - s.start_time)) / 60)::int - s.grace_minutes)
           END AS late_minutes,
           CASE WHEN s.id IS NOT NULL AND sc.last_out IS NOT NULL
                THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (s.end_time - sc.last_out::time)) / 60)::int)
           END AS early_minutes,
           CASE WHEN s.id IS NOT NULL AND sc.last_out IS NOT NULL
                THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (sc.last_out::time - s.end_time)) / 60)::int)
           END AS ot_minutes,
           CASE WHEN sc.first_in IS NOT NULL AND sc.last_out IS NOT NULL AND sc.last_out > sc.first_in
                THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (sc.last_out - sc.first_in)) / 60)::int - COALESCE(s.break_minutes, 0))
           END AS worked_minutes,
           (ota.employee_id IS NOT NULL) AS ot_approved,
           CASE WHEN ota.employee_id IS NOT NULL THEN COALESCE(ota.approved_minutes,
                  GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (sc.last_out::time - s.end_time)) / 60)::int))
                ELSE 0 END AS ot_paid_minutes,
           ota.note AS ot_note
    FROM base b
    LEFT JOIN shifts s ON s.id = b.shift_id
    LEFT JOIN scans sc ON sc.employee_id = b.employee_id AND sc.work_date = b.work_date
    LEFT JOIN leaves lv ON lv.employee_id = b.employee_id AND lv.work_date = b.work_date
    LEFT JOIN ot_approvals ota ON ota.employee_id = b.employee_id AND ota.work_date = b.work_date
    ORDER BY b.employee_code, b.work_date
  `, [from.value, to.value, employeeId, departmentFilter.value]);
  return { from: from.value, to: to.value, rows };
});

app.get('/api/schedules/weekly', async () => {
  const { rows } = await db.query(
    'SELECT employee_id, weekday, shift_id FROM schedule_weekly ORDER BY employee_id, weekday'
  );
  return rows;
});

// เขียนครบทั้ง 7 วันในคำสั่งเดียว จึงไม่มีช่วงที่ตารางหายไปกลางทาง
app.put<{ Params: { employeeId: string }; Body: { days?: Record<string, string | number | null> } }>('/api/schedules/weekly/:employeeId', async (request, reply) => {
  if (!/^\d+$/.test(request.params.employeeId)) return reply.code(400).send({ error: 'รหัสอ้างอิงพนักงานไม่ถูกต้อง' });
  const days = request.body.days ?? {};
  const weekdays: number[] = [];
  const shiftIds: (string | null)[] = [];
  for (let weekday = 0; weekday < 7; weekday += 1) {
    const raw = days[String(weekday)];
    const trimmed = raw === null || raw === undefined ? '' : String(raw).trim();
    if (trimmed && !/^\d+$/.test(trimmed)) return reply.code(400).send({ error: 'รหัสอ้างอิงกะไม่ถูกต้อง' });
    weekdays.push(weekday);
    shiftIds.push(trimmed || null);
  }
  const employee = await db.query('SELECT 1 FROM employees WHERE id = $1', [request.params.employeeId]);
  if (!employee.rowCount) return reply.code(404).send({ error: 'ไม่พบพนักงาน' });
  try {
    await db.query(`
      INSERT INTO schedule_weekly (employee_id, weekday, shift_id)
      SELECT $1, day.weekday, day.shift_id
      FROM UNNEST($2::int[], $3::bigint[]) AS day(weekday, shift_id)
      ON CONFLICT (employee_id, weekday) DO UPDATE SET shift_id = EXCLUDED.shift_id
    `, [request.params.employeeId, weekdays, shiftIds]);
  } catch (error) {
    const { code } = error as { code?: string };
    if (code === '23503') return reply.code(400).send({ error: 'ไม่พบกะที่เลือก' });
    throw error;
  }
  const { rows } = await db.query(
    'SELECT employee_id, weekday, shift_id FROM schedule_weekly WHERE employee_id = $1 ORDER BY weekday',
    [request.params.employeeId]
  );
  return rows;
});

// ล้างตารางประจำสัปดาห์ กลับไปใช้กะประจำของพนักงาน
app.delete<{ Params: { employeeId: string } }>('/api/schedules/weekly/:employeeId', async (request, reply) => {
  if (!/^\d+$/.test(request.params.employeeId)) return reply.code(400).send({ error: 'รหัสอ้างอิงพนักงานไม่ถูกต้อง' });
  await db.query('DELETE FROM schedule_weekly WHERE employee_id = $1', [request.params.employeeId]);
  return reply.code(204).send();
});

app.get<{ Querystring: { from?: string; to?: string } }>('/api/schedules/overrides', async (request, reply) => {
  const from = parseIsoDate((request.query.from ?? '').trim());
  const to = parseIsoDate((request.query.to ?? '').trim());
  if (from.error || to.error) return reply.code(400).send({ error: from.error ?? to.error });
  const { rows } = await db.query(`
    SELECT o.employee_id, to_char(o.work_date, 'YYYY-MM-DD') AS work_date, o.shift_id, o.note,
           e.employee_code, e.name, s.name AS shift_name
    FROM schedule_overrides o
    JOIN employees e ON e.id = o.employee_id
    LEFT JOIN shifts s ON s.id = o.shift_id
    WHERE o.work_date BETWEEN $1::date AND $2::date
    ORDER BY o.work_date, e.employee_code
  `, [from.value, to.value]);
  return rows;
});

app.put<{ Body: { employeeId?: string | number; workDate?: string; shiftId?: string | number | null; note?: string } }>('/api/schedules/overrides', async (request, reply) => {
  const employeeId = String(request.body.employeeId ?? '').trim();
  if (!/^\d+$/.test(employeeId)) return reply.code(400).send({ error: 'รหัสอ้างอิงพนักงานไม่ถูกต้อง' });
  const workDate = parseIsoDate(String(request.body.workDate ?? '').trim());
  if (workDate.error) return reply.code(400).send({ error: workDate.error });
  const shiftRaw = request.body.shiftId === null || request.body.shiftId === undefined ? '' : String(request.body.shiftId).trim();
  if (shiftRaw && !/^\d+$/.test(shiftRaw)) return reply.code(400).send({ error: 'รหัสอ้างอิงกะไม่ถูกต้อง' });
  const note = String(request.body.note ?? '').trim() || null;
  try {
    const { rows } = await db.query(`
      INSERT INTO schedule_overrides (employee_id, work_date, shift_id, note)
      VALUES ($1, $2::date, $3, $4)
      ON CONFLICT (employee_id, work_date) DO UPDATE SET shift_id = EXCLUDED.shift_id, note = EXCLUDED.note
      RETURNING employee_id, to_char(work_date, 'YYYY-MM-DD') AS work_date, shift_id, note
    `, [employeeId, workDate.value, shiftRaw || null, note]);
    return rows[0];
  } catch (error) {
    const { code, constraint } = error as { code?: string; constraint?: string };
    if (code === '23503') {
      return reply.code(400).send({ error: constraint === 'schedule_overrides_shift_id_fkey' ? 'ไม่พบกะที่เลือก' : 'ไม่พบพนักงาน' });
    }
    throw error;
  }
});

// ตั้งหรือล้างตารางรายวันเป็นช่วง เช่น ทั้งสัปดาห์หน้าในครั้งเดียว
// ทำในคำสั่ง SQL เดียวจึงเป็น all or nothing ไม่มีสภาพครึ่งๆ กลางๆ ถ้าพลาดกลางทาง
app.post<{ Body: { action?: string; employeeIds?: (string | number)[]; from?: string; to?: string; weekdays?: (string | number)[]; shiftId?: string | number | null; note?: string } }>('/api/schedules/overrides/bulk', async (request, reply) => {
  const action = request.body.action ?? 'set';
  if (action !== 'set' && action !== 'clear') return reply.code(400).send({ error: 'action ต้องเป็น set หรือ clear' });

  const employeeIds = (request.body.employeeIds ?? []).map(value => String(value).trim());
  if (!employeeIds.length) return reply.code(400).send({ error: 'ต้องเลือกพนักงานอย่างน้อย 1 คน' });
  if (employeeIds.length > 500) return reply.code(400).send({ error: 'เลือกพนักงานได้ไม่เกิน 500 คนต่อครั้ง' });
  if (!employeeIds.every(id => /^\d+$/.test(id))) return reply.code(400).send({ error: 'รหัสอ้างอิงพนักงานไม่ถูกต้อง' });

  const from = parseIsoDate(String(request.body.from ?? '').trim());
  const to = parseIsoDate(String(request.body.to ?? '').trim());
  if (from.error || to.error) return reply.code(400).send({ error: from.error ?? to.error });
  if (from.value! > to.value!) return reply.code(400).send({ error: 'วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด' });
  const spanDays = Math.round((Date.parse(to.value!) - Date.parse(from.value!)) / 86400000) + 1;
  if (spanDays > 366) return reply.code(400).send({ error: 'ตั้งได้ครั้งละไม่เกิน 366 วัน' });

  const weekdaysInput = request.body.weekdays ?? [0, 1, 2, 3, 4, 5, 6];
  const weekdays = weekdaysInput.map(value => Number(value));
  if (!weekdays.length) return reply.code(400).send({ error: 'ต้องเลือกวันในสัปดาห์อย่างน้อย 1 วัน' });
  if (!weekdays.every(day => Number.isInteger(day) && day >= 0 && day <= 6)) {
    return reply.code(400).send({ error: 'วันในสัปดาห์ต้องเป็นเลข 0 ถึง 6' });
  }

  if (action === 'clear') {
    const { rowCount } = await db.query(`
      DELETE FROM schedule_overrides
      WHERE employee_id = ANY($1::bigint[])
        AND work_date BETWEEN $2::date AND $3::date
        AND EXTRACT(DOW FROM work_date)::int = ANY($4::int[])
    `, [employeeIds, from.value, to.value, weekdays]);
    return { action, cleared: rowCount ?? 0 };
  }

  const shiftRaw = request.body.shiftId === null || request.body.shiftId === undefined ? '' : String(request.body.shiftId).trim();
  if (shiftRaw && !/^\d+$/.test(shiftRaw)) return reply.code(400).send({ error: 'รหัสอ้างอิงกะไม่ถูกต้อง' });
  const note = String(request.body.note ?? '').trim() || null;

  const existing = await db.query('SELECT COUNT(*)::int AS found FROM employees WHERE id = ANY($1::bigint[])', [employeeIds]);
  if (existing.rows[0].found !== new Set(employeeIds).size) return reply.code(400).send({ error: 'มีพนักงานที่ไม่พบในระบบ' });

  try {
    const { rowCount } = await db.query(`
      INSERT INTO schedule_overrides (employee_id, work_date, shift_id, note)
      SELECT employee.id, day.work_date, $4, $5
      FROM UNNEST($1::bigint[]) AS employee(id)
      CROSS JOIN (
        SELECT generate_series($2::date, $3::date, INTERVAL '1 day')::date AS work_date
      ) AS day
      WHERE EXTRACT(DOW FROM day.work_date)::int = ANY($6::int[])
      ON CONFLICT (employee_id, work_date)
        DO UPDATE SET shift_id = EXCLUDED.shift_id, note = EXCLUDED.note
    `, [employeeIds, from.value, to.value, shiftRaw || null, note, weekdays]);
    return { action, saved: rowCount ?? 0 };
  } catch (error) {
    const { code } = error as { code?: string };
    if (code === '23503') return reply.code(400).send({ error: 'ไม่พบกะที่เลือก' });
    throw error;
  }
});

app.delete<{ Params: { employeeId: string; workDate: string } }>('/api/schedules/overrides/:employeeId/:workDate', async (request, reply) => {
  if (!/^\d+$/.test(request.params.employeeId)) return reply.code(400).send({ error: 'รหัสอ้างอิงพนักงานไม่ถูกต้อง' });
  const workDate = parseIsoDate(request.params.workDate);
  if (workDate.error) return reply.code(400).send({ error: workDate.error });
  await db.query('DELETE FROM schedule_overrides WHERE employee_id = $1 AND work_date = $2::date', [request.params.employeeId, workDate.value]);
  return reply.code(204).send();
});

type WorkSiteInput = { name?: string; latitude?: number | string; longitude?: number | string; radiusM?: number | string; note?: string; active?: boolean };

function parseWorkSite(body: WorkSiteInput, creating: boolean) {
  const updates: Record<string, string | number | boolean | null> = {};
  if (creating || body.name !== undefined) {
    const name = String(body.name ?? '').trim();
    if (!name) return { error: 'ต้องระบุชื่อสถานที่ทำงาน' };
    updates.name = name;
  }
  const coordinates: [keyof WorkSiteInput, string, number, number, string][] = [
    ['latitude', 'latitude', -90, 90, 'ละติจูดต้องอยู่ระหว่าง -90 ถึง 90'],
    ['longitude', 'longitude', -180, 180, 'ลองจิจูดต้องอยู่ระหว่าง -180 ถึง 180']
  ];
  for (const [key, column, min, max, message] of coordinates) {
    if (!creating && body[key] === undefined) continue;
    const value = Number(body[key]);
    if (!Number.isFinite(value) || value < min || value > max) return { error: message };
    updates[column] = Math.round(value * 1000000) / 1000000;
  }
  if (creating || body.radiusM !== undefined) {
    const radius = Number(body.radiusM ?? 200);
    if (!Number.isInteger(radius) || radius < 20 || radius > 20000) {
      return { error: 'รัศมีต้องเป็นจำนวนเต็ม 20 ถึง 20,000 เมตร' };
    }
    updates.radius_m = radius;
  }
  if (body.note !== undefined) updates.note = String(body.note ?? '').trim() || null;
  if (body.active !== undefined) updates.active = Boolean(body.active);
  return { updates };
}

const WORK_SITE_FIELDS = 'id, name, latitude::float8 AS latitude, longitude::float8 AS longitude, radius_m, note, active';

app.get('/api/work-sites', async () => {
  const { rows } = await db.query(`SELECT ${WORK_SITE_FIELDS} FROM work_sites ORDER BY name`);
  return rows;
});

app.post<{ Body: WorkSiteInput }>('/api/work-sites', async (request, reply) => {
  const parsed = parseWorkSite(request.body, true);
  if (parsed.error) return reply.code(400).send({ error: parsed.error });
  const updates = parsed.updates ?? {};
  try {
    const { rows } = await db.query(
      `INSERT INTO work_sites (name, latitude, longitude, radius_m, note)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${WORK_SITE_FIELDS}`,
      [updates.name, updates.latitude, updates.longitude, updates.radius_m, updates.note ?? null]
    );
    return reply.code(201).send(rows[0]);
  } catch (error) {
    const { code } = error as { code?: string };
    if (code === '23505') return reply.code(409).send({ error: 'ชื่อสถานที่ทำงานนี้มีอยู่ในระบบแล้ว' });
    throw error;
  }
});

app.patch<{ Params: { id: string }; Body: WorkSiteInput }>('/api/work-sites/:id', async (request, reply) => {
  if (!/^\d+$/.test(request.params.id)) return reply.code(400).send({ error: 'รหัสอ้างอิงสถานที่ไม่ถูกต้อง' });
  const parsed = parseWorkSite(request.body, false);
  if (parsed.error) return reply.code(400).send({ error: parsed.error });
  const updates = parsed.updates ?? {};
  const columns = Object.keys(updates);
  if (!columns.length) return reply.code(400).send({ error: 'ไม่มีข้อมูลที่ต้องแก้ไข' });
  const assignments = columns.map((column, index) => `${column} = $${index + 2}`).join(', ');
  try {
    const { rows } = await db.query(
      `UPDATE work_sites SET ${assignments} WHERE id = $1 RETURNING ${WORK_SITE_FIELDS}`,
      [request.params.id, ...columns.map(column => updates[column])]
    );
    if (!rows.length) return reply.code(404).send({ error: 'ไม่พบสถานที่ทำงาน' });
    return rows[0];
  } catch (error) {
    const { code } = error as { code?: string };
    if (code === '23505') return reply.code(409).send({ error: 'ชื่อสถานที่ทำงานนี้มีอยู่ในระบบแล้ว' });
    throw error;
  }
});

type DepartmentInput = { name?: string; note?: string; active?: boolean };

function parseDepartment(body: DepartmentInput, creating: boolean) {
  const updates: Record<string, string | boolean | null> = {};
  if (creating || body.name !== undefined) {
    const name = String(body.name ?? '').trim();
    if (!name) return { error: 'ต้องระบุชื่อแผนก' };
    updates.name = name;
  }
  if (body.note !== undefined) updates.note = String(body.note ?? '').trim() || null;
  if (body.active !== undefined) updates.active = Boolean(body.active);
  return { updates };
}

app.get('/api/departments', async () => {
  const { rows } = await db.query(`
    SELECT d.id, d.name, d.note, d.active, COUNT(e.id)::int AS employee_count
    FROM departments d LEFT JOIN employees e ON e.department_id = d.id
    GROUP BY d.id ORDER BY d.name
  `);
  return rows;
});

app.post<{ Body: DepartmentInput }>('/api/departments', async (request, reply) => {
  const parsed = parseDepartment(request.body, true);
  if (parsed.error) return reply.code(400).send({ error: parsed.error });
  const updates = parsed.updates ?? {};
  try {
    const { rows } = await db.query(
      'INSERT INTO departments (name, note) VALUES ($1, $2) RETURNING id, name, note, active',
      [updates.name, updates.note ?? null]
    );
    return reply.code(201).send(rows[0]);
  } catch (error) {
    const constraint = constraintMessage(error);
    if (constraint) return reply.code(constraint.status).send({ error: constraint.error });
    throw error;
  }
});

app.patch<{ Params: { id: string }; Body: DepartmentInput }>('/api/departments/:id', async (request, reply) => {
  if (!/^\d+$/.test(request.params.id)) return reply.code(400).send({ error: 'รหัสอ้างอิงแผนกไม่ถูกต้อง' });
  const parsed = parseDepartment(request.body, false);
  if (parsed.error) return reply.code(400).send({ error: parsed.error });
  const updates = parsed.updates ?? {};
  const columns = Object.keys(updates);
  if (!columns.length) return reply.code(400).send({ error: 'ไม่มีข้อมูลที่ต้องแก้ไข' });
  const assignments = columns.map((column, index) => `${column} = $${index + 2}`).join(', ');
  try {
    const { rows } = await db.query(
      `UPDATE departments SET ${assignments} WHERE id = $1 RETURNING id, name, note, active`,
      [request.params.id, ...columns.map(column => updates[column])]
    );
    if (!rows.length) return reply.code(404).send({ error: 'ไม่พบแผนก' });
    return rows[0];
  } catch (error) {
    const constraint = constraintMessage(error);
    if (constraint) return reply.code(constraint.status).send({ error: constraint.error });
    throw error;
  }
});

type EmployeeTypeInput = { name?: string; payType?: string; payRate?: number | string; note?: string; active?: boolean;
  otMultiplier?: number | string; lateDeductPerMinute?: number | string;
  monthlyDaysDivisor?: number | string; workHoursPerDay?: number | string };

// ตอนสร้างต้องกรอกครบ ตอนแก้ไขอัปเดตเฉพาะฟิลด์ที่ส่งมา
function parseEmployeeType(body: EmployeeTypeInput, creating: boolean) {
  const updates: Record<string, string | number | boolean | null> = {};
  if (creating || body.name !== undefined) {
    const name = String(body.name ?? '').trim();
    if (!name) return { error: 'ต้องระบุชื่อประเภทพนักงาน' };
    updates.name = name;
  }
  if (creating || body.payType !== undefined) {
    const payType = String(body.payType ?? '').trim();
    if (payType !== 'daily' && payType !== 'monthly') return { error: 'วิธีจ่ายต้องเป็น daily หรือ monthly' };
    updates.pay_type = payType;
  }
  if (creating || body.payRate !== undefined) {
    const payRate = Number(body.payRate ?? 0);
    if (!Number.isFinite(payRate) || payRate < 0 || payRate > 10000000) {
      return { error: 'อัตราค่าตอบแทนต้องเป็นตัวเลข 0 ถึง 10,000,000' };
    }
    updates.pay_rate = Math.round(payRate * 100) / 100;
  }
  const numericRules: [keyof EmployeeTypeInput, string, number, number, string][] = [
    ['otMultiplier', 'ot_multiplier', 0, 10, 'อัตรา OT ต้องเป็นตัวเลข 0 ถึง 10 เท่า'],
    ['lateDeductPerMinute', 'late_deduct_per_minute', 0, 10000, 'ค่าหักสายต่อนาทีต้องเป็นตัวเลข 0 ถึง 10,000'],
    ['monthlyDaysDivisor', 'monthly_days_divisor', 1, 31, 'ฐานวันต่อเดือนต้องเป็นจำนวนเต็ม 1 ถึง 31'],
    ['workHoursPerDay', 'work_hours_per_day', 0.5, 24, 'ชั่วโมงทำงานต่อวันต้องเป็นตัวเลข 0.5 ถึง 24']
  ];
  for (const [key, column, min, max, message] of numericRules) {
    if (body[key] === undefined) continue;
    const value = Number(body[key]);
    if (!Number.isFinite(value) || value < min || value > max) return { error: message };
    if (column === 'monthly_days_divisor' && !Number.isInteger(value)) return { error: message };
    updates[column] = Math.round(value * 100) / 100;
  }
  if (body.note !== undefined) updates.note = String(body.note ?? '').trim() || null;
  if (body.active !== undefined) updates.active = Boolean(body.active);
  return { updates };
}

app.get('/api/employee-types', async () => {
  const { rows } = await db.query(`
    SELECT t.id, t.name, t.pay_type, t.pay_rate::float8 AS pay_rate, t.note, t.active,
           t.ot_multiplier::float8 AS ot_multiplier,
           t.late_deduct_per_minute::float8 AS late_deduct_per_minute,
           t.monthly_days_divisor, t.work_hours_per_day::float8 AS work_hours_per_day,
           COUNT(e.id)::int AS employee_count
    FROM employee_types t LEFT JOIN employees e ON e.employee_type_id = t.id
    GROUP BY t.id ORDER BY t.pay_type, t.name
  `);
  return rows;
});

app.post<{ Body: EmployeeTypeInput }>('/api/employee-types', async (request, reply) => {
  const parsed = parseEmployeeType(request.body, true);
  if (parsed.error) return reply.code(400).send({ error: parsed.error });
  const updates = parsed.updates ?? {};
  try {
    const { rows } = await db.query(
      `INSERT INTO employee_types (name, pay_type, pay_rate, note, ot_multiplier,
                                   late_deduct_per_minute, monthly_days_divisor, work_hours_per_day)
       VALUES ($1, $2, $3, $4, COALESCE($5, 1.5), COALESCE($6, 0), COALESCE($7, 30), COALESCE($8, 8))
       RETURNING ${EMPLOYEE_TYPE_FIELDS}`,
      [updates.name, updates.pay_type, updates.pay_rate, updates.note ?? null,
       updates.ot_multiplier ?? null, updates.late_deduct_per_minute ?? null,
       updates.monthly_days_divisor ?? null, updates.work_hours_per_day ?? null]
    );
    return reply.code(201).send(rows[0]);
  } catch (error) {
    const constraint = constraintMessage(error);
    if (constraint) return reply.code(constraint.status).send({ error: constraint.error });
    throw error;
  }
});

app.patch<{ Params: { id: string }; Body: EmployeeTypeInput }>('/api/employee-types/:id', async (request, reply) => {
  if (!/^\d+$/.test(request.params.id)) return reply.code(400).send({ error: 'รหัสอ้างอิงประเภทพนักงานไม่ถูกต้อง' });
  const parsed = parseEmployeeType(request.body, false);
  if (parsed.error) return reply.code(400).send({ error: parsed.error });
  const updates = parsed.updates ?? {};
  const columns = Object.keys(updates);
  if (!columns.length) return reply.code(400).send({ error: 'ไม่มีข้อมูลที่ต้องแก้ไข' });
  const assignments = columns.map((column, index) => `${column} = $${index + 2}`).join(', ');
  try {
    const { rows } = await db.query(
      `UPDATE employee_types SET ${assignments} WHERE id = $1 RETURNING ${EMPLOYEE_TYPE_FIELDS}`,
      [request.params.id, ...columns.map(column => updates[column])]
    );
    if (!rows.length) return reply.code(404).send({ error: 'ไม่พบประเภทพนักงาน' });
    return rows[0];
  } catch (error) {
    const constraint = constraintMessage(error);
    if (constraint) return reply.code(constraint.status).send({ error: constraint.error });
    throw error;
  }
});

app.get('/api/shifts', async () => {
  const { rows } = await db.query(`
    SELECT s.id, s.name, to_char(s.start_time, 'HH24:MI') AS start_time,
           to_char(s.end_time, 'HH24:MI') AS end_time, s.grace_minutes, s.break_minutes, s.active,
           COUNT(e.id)::int AS employee_count
    FROM shifts s LEFT JOIN employees e ON e.shift_id = s.id
    GROUP BY s.id ORDER BY s.start_time, s.name
  `);
  return rows;
});

app.post<{ Body: ShiftInput }>('/api/shifts', async (request, reply) => {
  const parsed = parseShift(request.body, true);
  if (parsed.error) return reply.code(400).send({ error: parsed.error });
  const updates = parsed.updates ?? {};
  try {
    const { rows } = await db.query(
      `INSERT INTO shifts (name, start_time, end_time, grace_minutes, break_minutes)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${SHIFT_FIELDS}`,
      [updates.name, updates.start_time, updates.end_time, updates.grace_minutes, updates.break_minutes]
    );
    return reply.code(201).send(rows[0]);
  } catch (error) {
    const constraint = constraintMessage(error);
    if (constraint) return reply.code(constraint.status).send({ error: constraint.error });
    throw error;
  }
});

app.patch<{ Params: { id: string }; Body: ShiftInput }>('/api/shifts/:id', async (request, reply) => {
  if (!/^\d+$/.test(request.params.id)) return reply.code(400).send({ error: 'รหัสอ้างอิงกะไม่ถูกต้อง' });
  const parsed = parseShift(request.body, false);
  if (parsed.error) return reply.code(400).send({ error: parsed.error });
  const updates = parsed.updates ?? {};
  const columns = Object.keys(updates);
  if (!columns.length) return reply.code(400).send({ error: 'ไม่มีข้อมูลที่ต้องแก้ไข' });
  const assignments = columns.map((column, index) => `${column} = $${index + 2}`).join(', ');
  try {
    const { rows } = await db.query(
      `UPDATE shifts SET ${assignments} WHERE id = $1 RETURNING ${SHIFT_FIELDS}`,
      [request.params.id, ...columns.map(column => updates[column])]
    );
    if (!rows.length) return reply.code(404).send({ error: 'ไม่พบกะการทำงาน' });
    return rows[0];
  } catch (error) {
    const constraint = constraintMessage(error);
    if (constraint) return reply.code(constraint.status).send({ error: constraint.error });
    throw error;
  }
});

app.post<{ Body: { employeeCode: string; eventType: 'check_in' | 'check_out'; note?: string } }>('/api/time-logs', async (request, reply) => {
  const { employeeCode, eventType, note } = request.body;
  if (!employeeCode || !['check_in', 'check_out'].includes(eventType)) return reply.code(400).send({ error: 'invalid request' });
  const employee = await db.query('SELECT id FROM employees WHERE employee_code = $1 AND active = TRUE', [employeeCode]);
  if (!employee.rowCount) return reply.code(404).send({ error: 'employee not found' });
  const { rows } = await db.query(
    'INSERT INTO time_logs (employee_id, event_type, note) VALUES ($1, $2, $3) RETURNING id, event_type, occurred_at',
    [employee.rows[0].id, eventType, note ?? null]
  );
  return reply.code(201).send(rows[0]);
});

app.get('/api/time-logs/today', async () => {
  const { rows } = await db.query(`
    WITH entries AS (
      SELECT t.id, t.employee_id, t.event_type, t.occurred_at, t.note, t.source,
             t.latitude, t.longitude, t.accuracy_m, t.location_address,
             (t.occurred_at AT TIME ZONE 'Asia/Bangkok')::date AS work_date
      FROM time_logs t
      WHERE (t.occurred_at AT TIME ZONE 'Asia/Bangkok')::date = (NOW() AT TIME ZONE 'Asia/Bangkok')::date
    ),
    resolved AS (
      SELECT entries.*, src.employee_code, src.name, src.effective_shift_id,
             src.has_override, src.has_weekly, src.default_shift_id
      FROM entries
      JOIN LATERAL (${scheduleSourceSql('entries.work_date')}) src ON src.employee_id = entries.employee_id
    )
    SELECT r.employee_code, r.name, r.event_type, r.occurred_at, r.note,
           r.latitude::float8 AS latitude, r.longitude::float8 AS longitude,
           r.accuracy_m::float8 AS accuracy_m, r.location_address, r.source,
           site.site_name, site.distance_m, site.inside_site,
           s.name AS shift_name, to_char(s.start_time, 'HH24:MI') AS shift_start_time,
           CASE WHEN r.event_type = 'check_in' AND s.id IS NOT NULL
                THEN ${lateMinutesSql('r.occurred_at')} END AS late_minutes,
           (s.id IS NULL AND (r.has_override OR r.has_weekly)) AS off_schedule
    FROM resolved r
    LEFT JOIN shifts s ON s.id = r.effective_shift_id
    ${nearestSiteJoin('r.latitude', 'r.longitude')}
    ORDER BY r.occurred_at DESC
  `);
  return rows;
});

type LineEvent = {
  type?: string;
  replyToken?: string;
  source?: { userId?: string };
  message?: { type?: string; text?: string };
};

async function replyLine(replyToken: string, text: string) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return;
  const response = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] })
  });
  if (!response.ok) throw new Error(`LINE reply failed: ${response.status}`);
}

// ปิดการลงเวลาด้วยการพิมพ์ในแชทเป็นค่าเริ่มต้น เพื่อบังคับให้ทุกการลงเวลามีพิกัด
// เปิดกลับได้ด้วย ALLOW_CHAT_CHECKIN=true ใน .env
const chatCheckInAllowed = () => /^(1|true|on|yes)$/i.test((process.env.ALLOW_CHAT_CHECKIN ?? '').trim());

// ลิงก์เปิดหน้าลงเวลาพร้อม GPS พนักงานแตะจากแชทได้เลย ไม่ต้องมีริชเมนูก่อน
const liffLink = () => {
  const liffId = (process.env.LIFF_ID ?? '').trim();
  return liffId ? `https://liff.line.me/${liffId}` : '';
};

async function handleLineCommand(userId: string, command: string) {
  const registration = command.match(/^ลงทะเบียน\s+([A-Za-z0-9_-]+)$/i);
  if (registration) {
    const result = await db.query(
      `UPDATE employees SET line_user_id = $1
       WHERE employee_code = $2 AND active = TRUE AND (line_user_id IS NULL OR line_user_id = $1)
       RETURNING name`, [userId, registration[1]]
    );
    if (!result.rowCount) return 'ไม่พบรหัสพนักงาน หรือบัญชี LINE นี้ถูกผูกกับพนักงานคนอื่นแล้ว';
    const registered = liffLink();
    return `ลงทะเบียนสำเร็จ: ${result.rows[0].name}\nพิมพ์ “เมนู” เพื่อดูคำสั่ง`
      + (registered ? `\n\nลงเวลาพร้อมพิกัด GPS แตะลิงก์นี้\n${registered}` : '');
  }

  const link = liffLink();
  // คำที่พนักงานมักพิมพ์เมื่ออยากลงเวลาแบบมีพิกัด
  if (/^(\/?liff|ลงเวลา|gps|จุดพิกัด|ตำแหน่ง)$/i.test(command)) {
    return link
      ? `ลงเวลาพร้อมพิกัด GPS แตะลิงก์นี้\n${link}\n\nหรือใช้คำสั่งในแชท\n• ลงเวลาเข้า\n• ลงเวลาออก`
      : 'ยังไม่ได้ตั้งค่าหน้าลงเวลาพร้อมพิกัด กรุณาแจ้งผู้ดูแล\n\nใช้คำสั่งในแชทได้\n• ลงเวลาเข้า\n• ลงเวลาออก';
  }

  if (command === 'เมนู') {
    if (chatCheckInAllowed()) {
      return 'คำสั่งที่ใช้ได้\n• ลงเวลาเข้า\n• ลงเวลาออก\n• ลงทะเบียน E001'
        + (link ? `\n\nลงเวลาพร้อมพิกัด GPS แตะลิงก์นี้\n${link}` : '');
    }
    return link
      ? `ลงเวลาเข้าและออก แตะลิงก์นี้\n${link}\n\nคำสั่งในแชทที่ใช้ได้\n• ลงทะเบียน E001 (ผูกบัญชีครั้งแรก)`
      : 'คำสั่งที่ใช้ได้\n• ลงทะเบียน E001';
  }

  const employee = await db.query(
    'SELECT id, name FROM employees WHERE line_user_id = $1 AND active = TRUE', [userId]
  );
  if (!employee.rowCount) return 'ยังไม่ได้ผูกบัญชี LINE\nกรุณาพิมพ์ “ลงทะเบียน รหัสพนักงาน” เช่น ลงทะเบียน E001';
  if (command !== 'ลงเวลาเข้า' && command !== 'ลงเวลาออก') {
    return 'ไม่เข้าใจคำสั่ง\nพิมพ์ “เมนู” เพื่อดูคำสั่งที่ใช้ได้'
      + (link ? `\n\nลงเวลาพร้อมพิกัด GPS แตะลิงก์นี้\n${link}` : '');
  }

  // ปิดอยู่จึงไม่บันทึกอะไร แต่บอกทางที่ถูกให้แทน
  if (!chatCheckInAllowed()) {
    return link
      ? `${command}ผ่านแชทถูกปิดแล้ว เพราะระบบต้องบันทึกพิกัดที่ลงเวลาด้วย\n\nแตะลิงก์นี้เพื่อลงเวลา\n${link}`
      : `${command}ผ่านแชทถูกปิดแล้ว กรุณาแจ้งผู้ดูแลเพื่อเปิดหน้าลงเวลา`;
  }

  const eventType = command === 'ลงเวลาเข้า' ? 'check_in' : 'check_out';
  const existing = await db.query(
    `SELECT 1 FROM time_logs WHERE employee_id = $1 AND event_type = $2
     AND (occurred_at AT TIME ZONE 'Asia/Bangkok')::date = (NOW() AT TIME ZONE 'Asia/Bangkok')::date
     LIMIT 1`, [employee.rows[0].id, eventType]
  );
  if (existing.rowCount) return `คุณได้${command}แล้วในวันนี้`;
  if (eventType === 'check_out') {
    const checkedIn = await db.query(
      `SELECT 1 FROM time_logs WHERE employee_id = $1 AND event_type = 'check_in'
       AND (occurred_at AT TIME ZONE 'Asia/Bangkok')::date = (NOW() AT TIME ZONE 'Asia/Bangkok')::date
       LIMIT 1`, [employee.rows[0].id]
    );
    if (!checkedIn.rowCount) return 'ยังไม่พบเวลาเข้างานของวันนี้';
  }
  const inserted = await db.query(
    'INSERT INTO time_logs (employee_id, event_type) VALUES ($1, $2) RETURNING occurred_at',
    [employee.rows[0].id, eventType]
  );
  const occurredAt = inserted.rows[0].occurred_at;
  const time = new Intl.DateTimeFormat('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' }).format(occurredAt);
  let message = `${command}สำเร็จ\n${employee.rows[0].name}\nเวลา ${time} น.`;
  const schedule = await db.query(
    `SELECT s.id AS shift_id, s.name, to_char(s.start_time, 'HH24:MI') AS start_time,
            ${lateMinutesSql('$1::timestamptz')} AS late_minutes,
            (s.id IS NULL AND (src.has_override OR src.has_weekly)) AS off_schedule
     FROM (${scheduleSourceSql("($1::timestamptz AT TIME ZONE 'Asia/Bangkok')::date")}) src
     LEFT JOIN shifts s ON s.id = src.effective_shift_id
     WHERE src.employee_id = $2`,
    [occurredAt, employee.rows[0].id]
  );
  const schedules = schedule.rows[0];
  if (schedules?.off_schedule) {
    message += '\nวันนี้ไม่มีตารางงาน บันทึกเป็นการทำงานนอกตาราง';
  } else if (schedules?.shift_id && eventType === 'check_in') {
    message += `\nกะ ${schedules.name} เข้างาน ${schedules.start_time} น.`;
    message += schedules.late_minutes > 0 ? `\nสาย ${schedules.late_minutes} นาที` : '\nตรงเวลา';
  }
  return message;
}

app.post('/webhooks/line', async (request, reply) => {
  const secret = process.env.LINE_CHANNEL_SECRET;
  const signature = request.headers['x-line-signature'];
  if (secret) {
    const expected = crypto.createHmac('sha256', secret).update(request.rawBody ?? Buffer.alloc(0)).digest('base64');
    const received = typeof signature === 'string' ? Buffer.from(signature) : Buffer.alloc(0);
    const expectedBuffer = Buffer.from(expected);
    if (received.length !== expectedBuffer.length || !crypto.timingSafeEqual(received, expectedBuffer)) {
      return reply.code(401).send({ error: 'invalid LINE signature' });
    }
  }
  const events = (request.body as { events?: LineEvent[] }).events ?? [];
  for (const event of events) {
    if (event.type !== 'message' || event.message?.type !== 'text' || !event.source?.userId || !event.replyToken) continue;
    try {
      await replyLine(event.replyToken, await handleLineCommand(event.source.userId, event.message.text?.trim() ?? ''));
    } catch (error) {
      request.log.error(error, 'Unable to process LINE event');
    }
  }
  return reply.code(200).send({ ok: true });
});

await initializeDatabase();

// บัญชีผู้ดูแลระบบคนแรก สร้างจาก ADMIN_BOOTSTRAP_EMAIL ใน .env
// สร้างให้ครั้งเดียวตอนที่ยังไม่มีบัญชีนั้น แล้วพิมพ์ลิงก์ตั้งรหัสผ่านลง log ให้ไปตั้งเอง
// ตั้งใจไม่ให้ "คนแรกที่สมัครได้เป็นผู้ดูแลระบบ" เพราะเว็บนี้เปิดอยู่บนอินเทอร์เน็ตจริง
const bootstrapEmail = (process.env.ADMIN_BOOTSTRAP_EMAIL ?? '').trim().toLowerCase();
if (bootstrapEmail) {
  const existing = await db.query('SELECT id FROM admins WHERE email = $1', [bootstrapEmail]);
  if (!existing.rowCount) {
    const created = await db.query(
      `INSERT INTO admins (email, name, role, status, line_user_id)
       VALUES ($1, $2, 'admin', 'active', $3) RETURNING id`,
      [bootstrapEmail, (process.env.ADMIN_BOOTSTRAP_NAME ?? 'ผู้ดูแลระบบ').trim(),
       (process.env.ADMIN_BOOTSTRAP_LINE_USER_ID ?? '').trim() || null]);
    const token = newToken();
    await db.query(
      "INSERT INTO password_resets (token_hash, admin_id, expires_at) VALUES ($1, $2, NOW() + interval '24 hours')",
      [hashToken(token), created.rows[0].id]);
    app.log.warn(`สร้างบัญชีผู้ดูแลระบบคนแรก ${bootstrapEmail} แล้ว ตั้งรหัสผ่านที่ ${BASE_URL}/reset?token=${token} (ลิงก์ใช้ได้ 24 ชั่วโมง)`);
  }
}
await app.listen({ host: '0.0.0.0', port });
