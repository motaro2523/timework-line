const { JSDOM, VirtualConsole } = require('/tmp/t/node_modules/jsdom');
const html = require('fs').readFileSync('/app/public/index.html','utf8');
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push((e.detail && e.detail.message) || e.message));
const PERMS = Object.fromEntries(['overview','employees','shifts','schedule','leaves','logs','missing','ot','reports','pay','advance','expenses','expensePermission','settings','admins'].map(k=>[k,'edit']));
const dom = new JSDOM(html, {
  virtualConsole: vc, runScripts:'dangerously', url:'https://timework.scriptbin.dev/#overview', pretendToBeVisual:true,
  beforeParse(w) {
    w.bootstrap = { Modal: class { show(){} hide(){} static getInstance(){ return {hide(){}}; } } };
    w.scrollTo = () => {};
    w.fetch = async url => {
      const u = String(url);
      const body = u.includes('/api/me') ? { id:'1', name:'ผู้ทดสอบ ระบบ', email:'t@t.co', role:'admin', role_label:'ผู้ดูแลระบบ', department_id:null, via_api_key:false, permissions:PERMS }
        : u.includes('/api/settings/notify') ? { enabled:false, lineUserId:'', label:'', time:'18:00', lastSent:'', has_recipient:false }
        : u.includes('/api/role-permissions') ? { roles:[{key:'admin',label:'ผู้ดูแลระบบ'}], pages:[{key:'pay',label:'เงินค่าตอบแทน'}], levels:['none','view','edit'], matrix:{admin:{pay:'edit'}} }
        : u.includes('/api/payroll') && !u.includes('entries') ? { rows: [] }
        : [];
      return { ok:true, status:200, json:async()=>body };
    };
  }
});
const w = dom.window, d = w.document;
const settle = async (n=25) => { for (let i=0;i<n;i++) await new Promise(r=>setTimeout(r,60)); };
const goto = async h => { w.location.hash = h; w.dispatchEvent(new w.HashChangeEvent('hashchange')); await settle(10); };
(async () => {
  await new Promise(r => w.addEventListener('load', r));
  await settle();
  let fail = 0;
  const check = (l,c) => { console.log(`  ${c?'✅':'❌'} ${l}`); if(!c) fail++; };

  console.log('--- โครงหน้า ---');
  const views = [...d.querySelectorAll('[id^=view-]')];
  check(`มีครบ 14 หน้า (พบ ${views.length})`, views.length === 14);
  check('ทุกหน้าอยู่ใน <main> ไม่หลุดออกนอก', views.every(v => v.parentElement.tagName === 'MAIN'));
  check('ไม่มี JavaScript error ตอนโหลด', errors.length === 0);
  if (errors.length) console.log('     ', errors.slice(0,2).join(' | '));

  console.log('\n--- เปิดได้ทุกหน้า และมีการ์ดครบ ---');
  for (const [hash, id, min] of [['#overview','view-overview',1], ['#employees','view-employees',1],
      ['#shifts','view-shifts',1], ['#schedule','view-schedule',1], ['#leaves','view-leaves',1],
      ['#logs','view-logs',1], ['#missing','view-missing',1], ['#reports','view-reports',1],
      ['#pay','view-pay',2], ['#advance','view-advance',2], ['#expenses','view-expenses',2],
      ['#settings','view-settings',4], ['#admins','view-admins',2], ['#roles','view-roles',1]]) {
    await goto(hash);
    const view = d.getElementById(id);
    const ok = !view.classList.contains('d-none')
      && views.filter(v => v !== view && !v.classList.contains('d-none')).length === 0
      && view.querySelectorAll('section, .card').length >= min;
    check(`${hash} เปิดได้ หน้าอื่นซ่อน และมีการ์ดอย่างน้อย ${min} ใบ`, ok);
  }

  console.log('\n--- ของที่เพิ่งเพิ่ม ---');
  await goto('#settings');
  check('การ์ดแจ้งเตือนอยู่ในหน้าตั้งค่า', d.getElementById('view-settings').contains(d.getElementById('notifyEmployee')));
  check('การ์ดเดิมในหน้าตั้งค่ายังอยู่ครบ', ['sitesTable','deptsTable','typesTable'].every(id => !!d.getElementById(id)));
  check('เมนูซ้ายยังย่อขยายได้', !!d.getElementById('sidebarMiniBtn') && !!d.getElementById('sidebarToggle'));
  check('ข้อความเมนูยังห่อด้วย span', d.querySelectorAll('.sidebar .nav-text').length >= 14);

  console.log(fail ? `\n❌ ไม่ผ่าน ${fail} ข้อ` : '\n✅ ผ่านทั้งหมด');
  process.exit(fail ? 1 : 0);
})();
