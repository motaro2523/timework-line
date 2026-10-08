// หน้าจ่ายเงิน: จำลองการเปิดหน้าตรงๆ ตอนรายชื่อพนักงานยังโหลดไม่เสร็จ
// เคยเป็นบั๊กจริง ช่องเลือกพนักงานค้างอยู่ที่คำว่า เลือกพนักงาน โดยไม่มีชื่อให้เลือก
const { JSDOM } = require('/tmp/t/node_modules/jsdom');
const html = require('fs').readFileSync('/app/public/index.html', 'utf8');
const PERMS = Object.fromEntries(['overview','employees','shifts','schedule','leaves','logs','missing','ot',
  'reports','pay','advance','expenses','expensePermission','settings','admins'].map(k => [k, 'edit']));
const EMPLOYEES = [
  { id:2, employee_code:'ZZ02', name:'ทดสอบ สอง', active:true,  line_user_id:'U2' },
  { id:3, employee_code:'ZZ03', name:'ทดสอบ สาม', active:false, line_user_id:'U3' }
];
const OUTSTANDING = { wage_paid_through:null, as_of:'2026-10-08', credit:5000, credits:[{ id:'10', remaining:5000 }],
  items:[
    { key:'wage:2026-09-01:2026-10-08', source:'wage', amount:9500, label:'ค่าแรงและ OT 1 ก.ย. ถึง 8 ต.ค.', detail:'' },
    { key:'settled:10', source:'settled', amount:-5000, locked:true, label:'จ่ายไปแล้วเมื่อ 28 ก.ย.', detail:'' }
  ] };
let posted = null;
const dom = new JSDOM(html, {
  runScripts:'dangerously', url:'https://timework.scriptbin.dev/#payrun', pretendToBeVisual:true,
  beforeParse(w) {
    w.bootstrap = { Modal: class { show(){} hide(){} static getInstance(){ return { hide(){} }; } } };
    w.scrollTo = () => {};
    w.fetch = async (url, options) => {
      const u = String(url);
      if (u.includes('/api/payruns') && options?.method === 'POST') {
        posted = JSON.parse(options.body);
        return { ok:true, status:201, json:async () => ({ id:'99', total:9500, credit_used:5000, transfer:4500, items:1 }) };
      }
      // รายชื่อพนักงานมาช้ากว่า /api/me ตั้งใจให้หน้าจ่ายเงินโหลดก่อนรายชื่อมาถึง
      if (u.includes('/api/employees')) await new Promise(r => setTimeout(r, 600));
      const body = u.includes('/api/me') ? { id:'1', name:'ผู้ทดสอบ', email:'t@t.co', role:'admin', role_label:'ผู้ดูแลระบบ',
            department_id:null, via_api_key:false, permissions:PERMS }
        : u.includes('/api/payruns/outstanding') ? OUTSTANDING
        : u.includes('/api/employees') ? EMPLOYEES
        : u.includes('/api/payroll') && !u.includes('entries') ? { rows: [] }
        : [];
      return { ok:true, status:200, json:async () => body };
    };
  }
});
const w = dom.window, d = w.document, $ = id => d.getElementById(id);
const settle = async (n = 25) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 60)); };
(async () => {
  await new Promise(r => w.addEventListener('load', r));
  await settle(40);
  let fail = 0;
  const check = (label, ok) => { console.log(`  ${ok ? '✅' : '❌'} ${label}`); if (!ok) fail++; };

  console.log('--- เปิดหน้าจ่ายเงินตรงๆ ตอนรายชื่อยังมาไม่ถึง ---');
  check('หน้าจ่ายเงินแสดงอยู่', !$('view-payrun').classList.contains('d-none'));
  const options = [...$('payrunEmployee').options].map(o => o.textContent);
  check(`ช่องเลือกพนักงานมีรายชื่อแล้ว (พบ ${options.length - 1} คน)`, options.length === 2);
  check('มีพนักงานที่ใช้งานอยู่', options.some(o => o.includes('ZZ02')));
  check('ไม่มีพนักงานที่ปิดใช้งาน', !options.some(o => o.includes('ZZ03')));

  console.log('\n--- เลือกพนักงานแล้วต้องเห็นรายการค้าง ---');
  $('payrunEmployee').value = '2';
  $('payrunEmployee').dispatchEvent(new w.Event('change', { bubbles:true }));
  await settle(10);
  const rows = $('payrunTable').querySelectorAll('tr[data-key]');
  check('ขึ้นรายการค้าง 2 บรรทัด', rows.length === 2);
  check('ค่าแรงติ๊กได้', !!rows[0].querySelector('input[data-pick]'));
  check('เงินที่จ่ายไว้แล้วติ๊กไม่ได้', !rows[1].querySelector('input[data-pick]'));

  console.log('\n--- ติ๊กค่าแรงแล้วยอดที่ต้องโอนต้องหักเงินที่จ่ายไว้แล้ว ---');
  rows[0].querySelector('input[data-pick]').checked = true;
  rows[0].querySelector('input[data-pick]').dispatchEvent(new w.Event('change', { bubbles:true }));
  await settle(5);
  check('รวมรายการที่เลือก 9,500.00', $('payrunPickedTotal').textContent === '9,500.00');
  check('หักเงินที่จ่ายไว้แล้ว −5,000.00', $('payrunCredit').textContent === '−5,000.00');
  check('ยอดที่ต้องโอนจริง 4,500.00', $('payrunTotal').textContent === '4,500.00');
  check('ปุ่มบันทึกกดได้', !$('payrunSaveBtn').disabled);

  $('payrunSaveBtn').dispatchEvent(new w.Event('click', { bubbles:true }));
  await settle(10);
  check('ส่งรายการค่าแรงไปบันทึก', posted && posted.items.length === 1 && posted.items[0].key.startsWith('wage:'));
  check('แจ้งผลว่าโอน 4,500 และหักเงินที่จ่ายไว้ 5,000', /4,500\.00/.test($('payrunMsg').textContent) && /5,000\.00/.test($('payrunMsg').textContent));

  console.log(fail ? `\n❌ ไม่ผ่าน ${fail} ข้อ` : '\n✅ ผ่านทั้งหมด');
  process.exit(fail ? 1 : 0);
})();
