const { JSDOM } = require('/tmp/t/node_modules/jsdom');
const html = require('fs').readFileSync('/app/public/index.html','utf8');
const EMPLOYEES = [
  { id:1, employee_code:'ZZ01', name:'ทดสอบ หนึ่ง', active:true, line_user_id:'U111', department_id:null },
  { id:2, employee_code:'ZZ02', name:'ทดสอบ สอง',  active:true, line_user_id:null,  department_id:null },
  { id:3, employee_code:'ZZ03', name:'ทดสอบ สาม',  active:false,line_user_id:'U333', department_id:null }
];
let state = { enabled:false, lineUserId:'', label:'', time:'18:00', lastSent:'', has_recipient:false };
let puts = [], tested = 0, previewed = 0;
const dom = new JSDOM(html, {
  runScripts:'dangerously', url:'https://timework.scriptbin.dev/#settings', pretendToBeVisual:true,
  beforeParse(w) {
    w.bootstrap = { Modal: class { show(){} hide(){} static getInstance(){ return {hide(){}}; } } };
    w.scrollTo = () => {};
    w.fetch = async (url, options) => {
      const u = String(url), method = options?.method;
      if (u.includes('/api/settings/notify/test')) { tested++; return { ok:true, status:200, json:async()=>({ ok:true }) }; }
      if (u.includes('/api/settings/notify/preview')) { previewed++; return { ok:true, status:200, json:async()=>({ text:'ตัวอย่างข้อความสรุป' }) }; }
      if (u.includes('/api/settings/notify') && method === 'PUT') {
        const body = JSON.parse(options.body); puts.push(body);
        if (body.employeeId !== undefined) {
          const emp = EMPLOYEES.find(e => String(e.id) === body.employeeId);
          state.label = emp ? `${emp.employee_code} ${emp.name}` : '';
          state.has_recipient = Boolean(emp);
          state.lineUserId = emp ? 'ตั้งไว้แล้ว' : '';
        }
        if (body.time !== undefined) state.time = body.time;
        if (body.enabled !== undefined) state.enabled = body.enabled;
        return { ok:true, status:200, json:async()=>({ ...state }) };
      }
      const body = u.includes('/api/settings/notify') ? { ...state }
        : u.includes('/api/me') ? { id:'1', name:'ผู้ทดสอบ ระบบ', email:'t@t.co', role:'admin', role_label:'ผู้ดูแลระบบ',
            department_id:null, via_api_key:false, permissions:Object.fromEntries(['overview','employees','shifts','schedule','leaves','logs','missing','ot','reports','pay','advance','expenses','expensePermission','settings','admins'].map(k=>[k,'edit'])) }
        : u.includes('/api/employees') ? EMPLOYEES
        : u.includes('/api/payroll') ? { rows: [] } : [];
      return { ok:true, status:200, json:async()=>body };
    };
  }
});
const w = dom.window, d = w.document, $ = id => d.getElementById(id);
const settle = async (n=25) => { for (let i=0;i<n;i++) await new Promise(r=>setTimeout(r,60)); };
(async () => {
  await new Promise(r => w.addEventListener('load', r));
  await settle();
  let fail = 0;
  const check = (l,c) => { console.log(`  ${c?'✅':'❌'} ${l}`); if(!c) fail++; };

  console.log('--- การ์ดตั้งค่า ---');
  check('อยู่ในหน้า ตั้งค่า', $('view-settings').contains($('notifyEmployee')));
  check('ยังไม่เปิดการแจ้งเตือน', !$('notifyEnabled').checked);
  check('เวลาเริ่มต้น 18:00', $('notifyTime').value === '18:00');
  const options = [...$('notifyEmployee').options].map(o => o.textContent);
  check('เลือกได้เฉพาะคนที่ผูก LINE และยังใช้งานอยู่', options.length === 2 && options[1].includes('ZZ01'));
  check('ไม่มีคนที่ยังไม่ผูก LINE ในรายการ', !options.some(o => o.includes('ZZ02')));
  check('ไม่มีคนที่ปิดใช้งานในรายการ', !options.some(o => o.includes('ZZ03')));
  check('บอกว่ายังไม่ได้เลือกผู้รับ', /ยังไม่ได้เลือกผู้รับ/.test($('notifySummary').textContent));

  console.log('\n--- เลือกผู้รับ ---');
  $('notifyEmployee').value = '1';
  $('notifyEmployee').dispatchEvent(new w.Event('change', { bubbles:true }));
  await settle(8);
  check('ส่ง employeeId ไปบันทึก', puts.some(p => p.employeeId === '1'));
  check('สรุปบอกชื่อผู้รับ', /ZZ01 ทดสอบ หนึ่ง/.test($('notifySummary').textContent));
  check('ยังคงเลือกคนเดิมไว้หลังโหลดใหม่', $('notifyEmployee').value === '1');

  console.log('\n--- เปลี่ยนเวลาและเปิดใช้งาน ---');
  $('notifyTime').value = '17:45';
  $('notifyTime').dispatchEvent(new w.Event('change', { bubbles:true }));
  await settle(8);
  check('ส่งเวลาใหม่ไปบันทึก', puts.some(p => p.time === '17:45'));
  $('notifyEnabled').checked = true;
  $('notifyEnabled').dispatchEvent(new w.Event('change', { bubbles:true }));
  await settle(8);
  check('ส่งสถานะเปิดไปบันทึก', puts.some(p => p.enabled === true));
  check('สรุปขึ้นว่าเปิดอยู่พร้อมเวลา', /เปิดอยู่/.test($('notifySummary').textContent) && /17:45/.test($('notifySummary').textContent));
  check('บอกว่ายังไม่เคยส่ง', /ยังไม่เคยส่ง/.test($('notifySummary').textContent));

  console.log('\n--- ปุ่มดูตัวอย่างและส่งทดสอบ ---');
  check('กล่องตัวอย่างซ่อนอยู่ก่อนกด', $('notifyPreview').classList.contains('d-none'));
  $('notifyPreviewBtn').dispatchEvent(new w.Event('click', { bubbles:true }));
  await settle(8);
  check('กดดูตัวอย่างแล้วเรียก API', previewed === 1);
  check('แสดงข้อความตัวอย่าง', !$('notifyPreview').classList.contains('d-none') && /ตัวอย่างข้อความสรุป/.test($('notifyPreview').textContent));
  $('notifyTestBtn').dispatchEvent(new w.Event('click', { bubbles:true }));
  await settle(8);
  check('กดส่งทดสอบแล้วเรียก API', tested === 1);
  check('แจ้งผลว่าส่งแล้ว', /ส่งข้อความทดสอบ/.test($('notifySummary').textContent));

  console.log(fail ? `\n❌ ไม่ผ่าน ${fail} ข้อ` : '\n✅ ผ่านทั้งหมด');
  process.exit(fail ? 1 : 0);
})();
