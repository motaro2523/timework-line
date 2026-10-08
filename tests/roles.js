// เปิดแดชบอร์ดด้วยบทบาทที่สิทธิ์ไม่ครบ เส้นทางที่ไม่มีสิทธิ์ตอบ 403 เหมือนเซิร์ฟเวอร์จริง
// เคยพัง: loadDashboard วนลูปผล 403 ที่ไม่ใช่รายการ แล้วหยุดกลางทาง
const { JSDOM, VirtualConsole } = require('/tmp/t/node_modules/jsdom');
const html = require('fs').readFileSync('/app/public/index.html', 'utf8');

// ตารางสิทธิ์เริ่มต้นจาก src/db.ts
const MATRIX = {
  finance: { overview:'view', employees:'view', shifts:'none', schedule:'none', leaves:'none', logs:'view',
             missing:'none', ot:'view', reports:'view', pay:'edit', advance:'edit', expenses:'edit',
             expensePermission:'edit', settings:'edit', admins:'none' },
  lead:    { overview:'viewTeam', employees:'viewTeam', shifts:'view', schedule:'editTeam', leaves:'editTeam',
             logs:'viewTeam', missing:'editTeam', ot:'editTeam', reports:'viewTeam', pay:'none', advance:'none',
             expenses:'viewTeam', expensePermission:'none', settings:'none', admins:'none' }
};
// เลียนแบบ ROUTE_PERMISSIONS ฝั่งเซิร์ฟเวอร์ ให้ 403 ตรงกับของจริง
const ROUTES = [
  [/^\/api\/admins/, 'admins'], [/^\/api\/role-permissions/, 'admins'],
  [/^\/api\/reports\//, 'reports'], [/^\/api\/employees/, 'employees'], [/^\/api\/shifts/, 'shifts'],
  [/^\/api\/schedules\//, 'schedule'], [/^\/api\/leaves/, 'leaves'],
  [/^\/api\/time-logs\/(missing|manual)/, 'missing'], [/^\/api\/time-logs/, 'logs'], [/^\/api\/ot/, 'ot'],
  [/^\/api\/payroll\/entries/, 'advance'], [/^\/api\/payroll/, 'pay'], [/^\/api\/payruns/, 'advance'],
  [/^\/api\/expenses/, 'expenses'], [/^\/api\/settings\//, 'settings'],
  [/^\/api\/(departments|employee-types|work-sites)/, 'settings']
];
const EMPLOYEES = [{ id:2, employee_code:'ZZ02', name:'ทดสอบ สอง', active:true, line_user_id:'U2', department_id:3, department_name:'ช่าง' }];

function open(role, hash) {
  const errors = [];
  const forbidden = new Set();
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push((e.detail && e.detail.message) || e.message));
  const perms = MATRIX[role];
  const dom = new JSDOM(html, {
    virtualConsole: vc, runScripts:'dangerously', url:`https://timework.scriptbin.dev/${hash}`, pretendToBeVisual:true,
    beforeParse(w) {
      w.bootstrap = { Modal: class { show(){} hide(){} static getInstance(){ return { hide(){} }; } } };
      w.scrollTo = () => {};
      w.addEventListener('unhandledrejection', e => errors.push('unhandled: ' + (e.reason && e.reason.message)));
      w.fetch = async (url) => {
        const u = String(url).split('?')[0];
        if (u === '/api/me') return { ok:true, status:200, json:async () => ({ id:'9', name:`ทดสอบ ${role}`,
          email:'t@t.co', role, role_label:role, department_id: role === 'lead' ? '3' : null, via_api_key:false, permissions:perms }) };
        const hit = ROUTES.find(([re]) => re.test(u));
        if (hit && perms[hit[1]] === 'none') {
          forbidden.add(u);
          return { ok:false, status:403, json:async () => ({ error:'บัญชีของคุณไม่มีสิทธิ์ดูข้อมูลส่วนนี้' }) };
        }
        const body = u === '/api/employees' ? EMPLOYEES
          : u === '/api/departments' ? [{ id:3, name:'ช่าง', active:true }]
          : u === '/api/payroll' ? { rows: [] }
          : u === '/api/payruns/outstanding' ? { items: [], credit: 0, credits: [] }
          : u === '/api/settings/notify' ? { enabled:false, label:'', time:'18:00', lastSent:'', has_recipient:false }
          : u === '/api/role-permissions' ? { roles:[], pages:[], levels:[], matrix:{} }
          : [];
        return { ok:true, status:200, json:async () => body };
      };
    }
  });
  return { w: dom.window, errors, forbidden };
}
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 60)); };

(async () => {
  let fail = 0;
  const check = (label, ok) => { console.log(`  ${ok ? '✅' : '❌'} ${label}`); if (!ok) fail++; };

  for (const [role, hash, expectPage] of [['finance', '#payrun', 'view-payrun'], ['lead', '#schedule', 'view-schedule']]) {
    const { w, errors, forbidden } = open(role, hash);
    await new Promise(r => w.addEventListener('load', r));
    await settle();
    const d = w.document, $ = id => d.getElementById(id);
    console.log(`\n--- บทบาท ${role} เปิด ${hash} ---`);
    console.log(`     เส้นทางที่ถูกปฏิเสธ 403: ${[...forbidden].sort().join(' ') || 'ไม่มี'}`);
    check('ไม่มี JavaScript error', errors.length === 0);
    if (errors.length) console.log('     ', errors.slice(0, 3).join(' | '));
    check('ภาพรวมนับพนักงานได้ (แดชบอร์ดโหลดจบ)', $('employeeCount').textContent.trim() === '1');
    check(`เปิดหน้า ${expectPage} ได้`, !$(expectPage).classList.contains('d-none'));
    if (role === 'finance') {
      const opts = [...$('payrunEmployee').options].map(o => o.textContent);
      check('ช่องเลือกพนักงานในหน้าจ่ายเงินมีรายชื่อ', opts.some(o => o.includes('ZZ02')));
      check('การ์ดสิทธิ์ส่งค่าใช้จ่ายมีรายชื่อ', $('permList').querySelectorAll('[data-perm-id]').length === 1);
      check('ไม่เห็นเมนูกะการทำงาน', d.querySelector('.nav-link[data-page="shifts"]').classList.contains('d-none'));
    } else {
      check('ไม่เห็นเมนูตั้งค่า', d.querySelector('.nav-link[data-page="settings"]').classList.contains('d-none'));
      check('ไม่เห็นเมนูเงินค่าตอบแทน', d.querySelector('.nav-link[data-page="pay"]').classList.contains('d-none'));
    }
    w.close();
  }
  console.log(fail ? `\n❌ ไม่ผ่าน ${fail} ข้อ` : '\n✅ ผ่านทั้งหมด');
  process.exit(fail ? 1 : 0);
})();
