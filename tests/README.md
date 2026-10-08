# ชุดทดสอบหน้าเว็บ

รันด้วย jsdom ในคอนเทนเนอร์ api ไม่ต้องมีเบราว์เซอร์ และไม่แตะฐานข้อมูลจริง
(ทุกการเรียก API ถูกสวมด้วยข้อมูลจำลองในไฟล์ทดสอบเอง)

```bash
cd /home/aon/timework-line
docker compose exec -T api sh -c 'mkdir -p /tmp/t && cd /tmp/t && npm i jsdom >/dev/null 2>&1'
docker cp tests/smoke.js timework-line-api-1:/tmp/t/
docker compose exec -T api node /tmp/t/smoke.js
docker compose exec -T api rm -rf /tmp/t      # เก็บกวาดเมื่อเสร็จ
```

| ไฟล์ | ตรวจอะไร |
| --- | --- |
| `smoke.js` | เปิดได้ทุกหน้า หน้าอื่นถูกซ่อน ทุกหน้ายังอยู่ใน `<main>` และไม่มี JavaScript error |
| `payrun.js` | หน้าจ่ายเงิน: เปิดหน้าตรงๆ ตอนรายชื่อยังโหลดไม่เสร็จ เลือกพนักงาน ติ๊กรายการ และยอดที่ต้องโอนหลังหักเงินที่จ่ายไว้แล้ว |
| `notify.js` | การ์ดแจ้งสรุปประจำวัน: เลือกผู้รับ ตั้งเวลา เปิดปิด ดูตัวอย่าง ส่งทดสอบ |

`smoke.js` มีข้อที่เช็กว่า **ทุก `[id^=view-]` ต้องมีพ่อเป็น `<main>`** ไว้จับบั๊ก `</div>` เกิน
ที่เคยทำให้สามหน้าสุดท้ายหลุดไปอยู่ใต้ body จนดูเหมือนหน้าว่าง
