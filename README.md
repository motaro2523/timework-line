# TimeWork LINE

ระบบต้นแบบบันทึกเวลาเข้า-ออกงานผ่าน LINE โดยมี API, PostgreSQL และ Docker Compose

## เริ่มใช้งาน

1. คัดลอก `.env.example` เป็น `.env` แล้วตั้งค่ารหัสผ่านฐานข้อมูลและ `ADMIN_API_KEY` ให้ปลอดภัย
2. รัน `docker compose up --build -d`
3. เปิด `http://localhost:3000` และทดสอบ `http://localhost:3000/health`

## การเข้าสู่ระบบ

Dashboard และ `/api` ทุกเส้นทางถูกป้องกันด้วย `ADMIN_API_KEY` เปิดหน้าเว็บแล้วเบราว์เซอร์จะถามชื่อผู้ใช้และรหัสผ่าน ให้ใส่ชื่อผู้ใช้อะไรก็ได้ เช่น `admin` และใช้ค่า `ADMIN_API_KEY` เป็นรหัสผ่าน

เส้นทางที่ไม่ต้องยืนยันตัวตนมีเพียง `/health` สำหรับ monitoring และ `/webhooks/line` ที่ตรวจ HMAC signature ของ LINE อยู่แล้ว

## ทดลองเพิ่มพนักงาน

```bash
curl -X POST http://localhost:3000/api/employees \
  -H "x-admin-key: $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"employeeCode":"E001","name":"สมชาย ใจดี"}'
```

หรือใช้ Basic auth ก็ได้ `curl -u admin:$ADMIN_API_KEY http://localhost:3000/api/employees`

## รายละเอียดพนักงาน

เพิ่มหรือแก้ไขได้ทั้ง `nationalId`, `phone`, `address`, `startDate` และ `ethnicity` โดยส่งค่าว่างเพื่อล้างข้อมูลออก

```bash
curl -X PATCH http://localhost:3000/api/employees/1 \
  -H "x-admin-key: $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"phone":"081-234-5678","startDate":"2026-07-01","ethnicity":"ไทย"}'
```

เลขที่บัตรประชาชนต้องเป็นเลขไทย 13 หลักที่ check digit ถูกต้อง และห้ามซ้ำกับพนักงานคนอื่น

## กะการทำงาน

```bash
curl -X POST http://localhost:3000/api/shifts \
  -H "x-admin-key: $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"กะเช้า","startTime":"08:00","endTime":"17:00","graceMinutes":15}'
```

ผูกกะกับพนักงานด้วย `{"shiftId":"1"}` ผ่าน PATCH ข้างต้น ค่านี้เป็นกะประจำที่ใช้เมื่อยังไม่ตั้งตารางการทำงาน

## ตารางการทำงาน

ตารางประจำสัปดาห์ ส่งครบทั้ง 7 วัน โดย `0` คืออาทิตย์ ถึง `6` คือเสาร์ ค่า `null` คือวันหยุด

```bash
curl -X PUT http://localhost:3000/api/schedules/weekly/1 \
  -H "x-admin-key: $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"days":{"0":null,"1":"1","2":"1","3":"1","4":"1","5":"1","6":null}}'
```

แก้เป็นรายวันเมื่อสลับเวร ค่านี้ทับตารางประจำสัปดาห์

```bash
curl -X PUT http://localhost:3000/api/schedules/overrides \
  -H "x-admin-key: $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"employeeId":"1","workDate":"2026-09-12","shiftId":"2","note":"สลับเวรกับ E002"}'
```

ตั้งทั้งสัปดาห์ให้หลายคนในครั้งเดียว ส่ง `action` เป็น `clear` เพื่อล้างช่วงนั้นแทน

```bash
curl -X POST http://localhost:3000/api/schedules/overrides/bulk \
  -H "x-admin-key: $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"employeeIds":["1","2"],"from":"2026-09-07","to":"2026-09-13","weekdays":[1,2,3,4,5],"shiftId":"2","note":"สัปดาห์หน้าเข้ากะดึก"}'
```

ดูตารางที่ใช้จริงของทุกคนในวันหนึ่งด้วย `GET /api/schedules/day?date=2026-09-12` หรือดูเป็นช่วงด้วย `GET /api/schedules/range?from=2026-09-07&to=2026-09-13` ซึ่งเป็นข้อมูลที่มุมมองรายสัปดาห์ใช้

ลำดับความสำคัญคือ ตารางรายวัน ก่อน ตารางประจำสัปดาห์ ก่อน กะประจำของพนักงาน

## ลงเวลาพร้อม GPS ผ่าน LIFF

ต้องตั้ง `LIFF_ID` และ `LINE_LOGIN_CHANNEL_ID` ใน `.env` โดย LINE Login channel ต้องอยู่ provider เดียวกับ Messaging API channel ไม่อย่างนั้น userId จะไม่ตรงกัน

```bash
curl -X POST http://localhost:3000/api/work-sites \
  -H "x-admin-key: $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"สำนักงานใหญ่","latitude":14.977,"longitude":102.083,"radiusM":200}'
```

พนักงานเปิด `/liff` ในแอป LINE แล้วกดลงเวลา ระบบเก็บพิกัดและวัดระยะจากสถานที่ที่ใกล้ที่สุด เกินรัศมีจะติดป้าย นอกพื้นที่

## แผนกและประเภทพนักงาน

```bash
curl -X POST http://localhost:3000/api/departments \
  -H "x-admin-key: $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"กลุ่มเทคโนโลยีสารสนเทศ"}'
```

กำหนดให้พนักงานด้วย `{"departmentId":"1"}` ผ่าน PATCH พนักงาน และใช้เป็นตัวกรองได้ด้วย `&departmentId=1` ที่ `/api/reports/attendance` `/api/payroll` และ `/api/time-logs/missing`

## ประเภทพนักงาน

```bash
curl -X POST http://localhost:3000/api/employee-types \
  -H "x-admin-key: $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"พนักงานรายวัน","payType":"daily","payRate":550,"note":"จ่ายทุกวันที่ 5 และ 20"}'
```

`payType` รับ `daily` หรือ `monthly` แล้วกำหนดให้พนักงานด้วย `{"employeeTypeId":"1"}` ผ่าน PATCH พนักงาน

## พนักงานลืมลงเวลา

```bash
curl -H "x-admin-key: $ADMIN_API_KEY" \
  "http://localhost:3000/api/time-logs/missing?from=2026-09-01&to=2026-09-30"

curl -X POST http://localhost:3000/api/time-logs/manual \
  -H "x-admin-key: $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"employeeId":"1","workDate":"2026-09-01","eventType":"check_out","time":"17:00","note":"ลืมสแกนออก"}'
```

เวลาที่เติมย้อนหลังจะมี `source = 'manual'` และลบได้เฉพาะรายการเหล่านี้ การสแกนจาก LINE ลบไม่ได้

## รายการค่าใช้จ่ายของพนักงาน

เปิดสิทธิ์ให้พนักงานส่งรายการด้วย `{"canSubmitExpense":true}` ผ่าน PATCH พนักงาน

```bash
curl -H "x-admin-key: $ADMIN_API_KEY" \
  "http://localhost:3000/api/expenses?from=2026-09-01&to=2026-09-30&status=pending"

curl -X PATCH http://localhost:3000/api/expenses/1 \
  -H "x-admin-key: $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"status":"approved","approvedAmount":300,"reviewNote":"อนุมัติ 300 ตามระเบียบ"}'
```

พนักงานส่งรายการและดูค่าตอบแทนของตัวเองผ่านหน้า `/liff` แท็บ ค่าตอบแทน เงินที่เบิก และ ค่าใช้จ่าย

## อนุมัติ OT

OT ไม่จ่ายเงินจนกว่าจะมีแถวใน `ot_approvals` ของวันนั้น

```bash
curl -H "x-admin-key: $ADMIN_API_KEY" \
  "http://localhost:3000/api/ot?from=2026-09-01&to=2026-09-30"

curl -X PUT http://localhost:3000/api/ot/approve \
  -H "x-admin-key: $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"employeeId":"1","workDate":"2026-09-07","approvedMinutes":30,"note":"อนุมัติบางส่วน"}'
```

`approvedMinutes` ถ้าไม่ส่งหรือส่งค่าว่าง = อนุมัติเท่าที่ระบบคำนวณได้ · `POST /api/ot/approve/bulk` อนุมัติทั้งช่วงในครั้งเดียว

## ค่าจ้าง การเบิกและการจ่ายเงิน

```bash
curl -H "x-admin-key: $ADMIN_API_KEY" \
  "http://localhost:3000/api/payroll?from=2026-09-01&to=2026-09-30"

curl -X POST http://localhost:3000/api/payroll/entries \
  -H "x-admin-key: $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"employeeId":"1","entryDate":"2026-09-15","kind":"advance","amount":500,"method":"เงินสด"}'
```

`kind` รับ `advance` เบิกล่วงหน้า หรือ `payment` จ่ายเงิน ทั้งสองจะถูกหักออกจากยอดสุทธิของช่วงนั้นในช่อง `balance`

กฎคำนวณตั้งที่ประเภทพนักงาน ได้แก่ `otMultiplier` `lateDeductPerMinute` `monthlyDaysDivisor` และ `workHoursPerDay`

## รายงานและการลา

```bash
curl -H "x-admin-key: $ADMIN_API_KEY" \
  "http://localhost:3000/api/reports/attendance?from=2026-09-01&to=2026-09-30"

curl -X POST http://localhost:3000/api/leaves \
  -H "x-admin-key: $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"employeeIds":["1"],"from":"2026-09-14","to":"2026-09-16","leaveType":"ลาป่วย","note":"ใบรับรองแพทย์"}'
```

รายงานคิด สาย ออกก่อน OT และ เวลาทำ จากกะของวันนั้น โดยหักเวลาพักของกะออกจากเวลาทำ วันที่มีการลาจะไม่คิดสายและไม่นับขาดงาน

## โครงสร้าง

- `src/server.ts` — API และ LINE webhook
- `src/db.ts` — การเชื่อมต่อและสร้างตารางฐานข้อมูลเริ่มต้น
- `public/` — หน้า Dashboard เริ่มต้น
- `docker-compose.yml` — API + PostgreSQL

ก่อนใช้จริงควรเพิ่ม migration ที่เป็นทางการ, การตอบข้อความ LINE, กะงาน/การลา และ reverse proxy HTTPS
