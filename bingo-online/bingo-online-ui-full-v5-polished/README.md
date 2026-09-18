# 🎱 Bingo Online — Real-time Multiplayer Bingo

เกมบิงโกออนไลน์แบบ Real-time รองรับ 1 Host + ผู้เล่นสูงสุด 19 คนต่อห้อง (รวม 20 คน)
ใช้ Node.js + Express + Socket.IO ฝั่ง server เป็นผู้ควบคุมสถานะทั้งหมด (ป้องกันการโกงและการเลือกบัตรซ้ำ)

## โครงสร้างไฟล์
```
server.js        Express + Socket.IO + event handlers ทั้งหมด (สร้างห้อง, สุ่มเลข, ตรวจ Bingo ฯลฯ)
db.js            In-memory data store (schema: rooms / players / cards)
gameLogic.js     สร้างบัตร Bingo, ตรวจ Bingo (แนวนอน/ตั้ง/ทแยง), สร้าง Room Code
public/index.html  หน้าเว็บทั้งหมด (SPA) — home, สร้างห้อง, เข้าห้อง, lobby, เลือกบัตร, กระดานเกม, ผลการแข่งขัน
public/css/style.css  ธีมเกม มือถือ-first, ปุ่มใหญ่, การกระพริบ, animation
public/js/app.js      Socket.IO client — จัดการทุกหน้าจอและ event ทั้งหมด
```

## 1) ติดตั้ง

ต้องมี **Node.js 18 หรือใหม่กว่า** ติดตั้งไว้ในเครื่อง

```bash
cd bingo-online
npm install
```

## 2) ตั้งค่า Environment Variables

```bash
cp .env.example .env
```

เปิดไฟล์ `.env` แล้วปรับ `PORT` ได้ตามต้องการ (ค่าเริ่มต้น 3000) — เกมนี้ไม่ต้องใช้ API Key หรือฐานข้อมูลภายนอกใด ๆ ในเวอร์ชันนี้ (ดูหัวข้อ "อัปเกรดฐานข้อมูล" ด้านล่างถ้าต้องการ persistence ข้ามการรีสตาร์ทเซิร์ฟเวอร์)

## 3) รันในเครื่อง (Local)

```bash
npm start
```

เปิดเบราว์เซอร์ไปที่ `http://localhost:3000`

- คนแรก (Host) กด **สร้างห้อง** → จะได้ Room Code เช่น `BGO-5821`
- ให้คนอื่นในเครือข่ายเดียวกันเปิด `http://<IP เครื่องคุณ>:3000` แล้วกด **เข้าร่วมห้อง** ใส่ Room Code นั้น
  - หา IP เครื่องได้ด้วย `ipconfig` (Windows) หรือ `ifconfig` / `ip a` (Mac/Linux)

## 4) ทดสอบแบบ Real-time หลายคนในเครื่องเดียว

เปิดเบราว์เซอร์หลายแท็บ/หน้าต่าง Incognito แต่ละแท็บจะได้ตัวตน (playerId) ของตัวเอง ใช้จำลองผู้เล่นหลายคนได้ทันที

## 5) Deploy ขึ้นอินเทอร์เน็ต

เกมนี้ไม่ผูกกับฐานข้อมูลภายนอก จึง deploy ได้ง่ายบนแพลตฟอร์มที่รัน Node.js ได้ เช่น **Render**, **Railway**, หรือ **Fly.io**:

**ตัวอย่างบน Render.com**
1. Push โค้ดนี้ขึ้น GitHub repository
2. ที่ Render → New → Web Service → เชื่อมกับ repo นี้
3. Build Command: `npm install`
4. Start Command: `npm start`
5. ตั้งค่า Environment Variable `PORT` (Render จะกำหนดให้อัตโนมัติผ่าน `process.env.PORT` อยู่แล้ว ไม่ต้องแก้โค้ด)
6. Deploy แล้วแชร์ URL ที่ได้ให้ผู้เล่น

**ข้อควรระวังเรื่อง WebSocket**: ตรวจสอบว่าแพลตฟอร์มที่เลือก รองรับ WebSocket persistent connection (Render/Railway/Fly.io รองรับ) — แพลตฟอร์มแบบ serverless functions (เช่น Vercel serverless) **ไม่เหมาะ** กับ Socket.IO เพราะไม่รองรับ connection ค้างไว้แบบนี้

## 6) อัปเกรดเป็นฐานข้อมูลจริง (ถ้าต้องการ persistence)

ปัจจุบันข้อมูลห้อง/ผู้เล่น/บัตรเก็บใน memory (`db.js`) — ถ้าเซิร์ฟเวอร์ restart ห้องทั้งหมดจะหาย (เหมาะกับเกมที่เล่นจบในคราวเดียว) ถ้าต้องการเก็บข้อมูลถาวรหรือรองรับหลาย server instance:

- เปลี่ยน `db.js` ให้เขียน/อ่านจาก Firebase Firestore, Supabase (Postgres), หรือ Redis แทน Map ในเครื่อง
- โครงสร้างข้อมูล (schema) ที่ใช้อยู่ตรงกับที่ระบุไว้แล้ว (`rooms`, `players`, `cards`) จึง map ไปยัง collection/table ได้ตรงตัว
- ไม่ต้องแก้ `server.js` เพราะมันเรียกผ่านฟังก์ชันใน `db.js` เท่านั้น

## กติกาและฟีเจอร์ที่ครอบคลุม

- ล็อกบัตรฝั่ง server กันผู้เล่น 2 คนกดบัตรเดียวกันพร้อมกัน
- ห้ามกากบาทเลขที่ Host ยังไม่สุ่ม (ตรวจฝั่ง server ทุกครั้ง)
- ตรวจ Bingo อัตโนมัติทุกครั้งที่กากบาท (แนวนอน/แนวตั้ง/แนวทแยง 2 เส้น) รองรับผู้ชนะพร้อมกันหลายคน
- Reconnect: รีเฟรชหน้าเว็บแล้วกลับเข้าห้องเดิมได้อัตโนมัติ (เก็บ Room Code + playerId ไว้ใน localStorage)
- Host disconnect: เกมไม่ล้ม ทุกคนเห็นข้อความเตือน รอ Host กลับมาเชื่อมต่อใหม่ได้
- เล่นใหม่: เลือก "ใช้บัตรเดิม" หรือ "เลือกบัตรใหม่" (ค่าเริ่มต้น)
