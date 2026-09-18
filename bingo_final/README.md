# Bingo Online — UI V6

เวอร์ชันนี้แก้ปัญหาจาก UI ก่อนหน้าโดยตรง:

- UI หน้าแรก / สร้างห้อง / เข้าร่วมห้อง / Lobby / เลือกบัตร / เกม / Bingo เป็นธีมเดียวกัน
- บังคับกรอกชื่อ Host และชื่อผู้เล่นก่อนสร้าง/เข้าห้อง
- หลังสร้าง/เข้าห้องจะพาไป Lobby ทันที
- room_state ส่ง `numbers` ของทุกบัตร ทำให้หน้าเลือกบัตรแสดงเลขจริงและเลือกได้
- Host เห็นเลขครบตามช่วง 75 / 80 / 99 / กำหนดเอง
- มีรายชื่อผู้ชนะ Bingo
- มีปุ่มออกจากห้องทั้ง Lobby และหน้าเกม
- Host ออกจากห้องแล้วปิดห้องและแจ้งผู้เล่น
- CSS/JS มี version query `?v=6` เพื่อช่วยลด cache เก่าบน Render

## GitHub + Render

แตก ZIP แล้วเอาไฟล์ในโฟลเดอร์นี้ไปทับไฟล์ใน repository เดิม:

- `server.js`
- `db.js`
- `public/index.html`
- `public/css/style.css`
- `public/js/app.js`

อย่าทับ Environment Variables ใน Render และไม่ต้องลบ `.env` ที่มีอยู่ในระบบ deploy

หลัง Commit ให้รอ Render Deploy สำเร็จ แล้วเปิดเว็บด้วย `Ctrl + F5` เพื่อบังคับโหลด asset รุ่นใหม่
