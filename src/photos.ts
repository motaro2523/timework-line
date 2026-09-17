import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyReply } from 'fastify';

// ===== รูปใบเสร็จของรายการค่าใช้จ่าย =====
// เก็บเป็นไฟล์ใน volume แยก ไม่เก็บลงฐานข้อมูล เพราะไฟล์สำรอง pg_dump จะบวมจนกู้คืนลำบาก
// โฟลเดอร์นี้อยู่นอก public จึงไม่มีทางถูกเสิร์ฟเป็นไฟล์สาธารณะโดยบังเอิญ
export const UPLOAD_DIR = process.env.UPLOAD_DIR ?? path.join(process.cwd(), 'uploads');
export const PHOTO_MAX_BYTES = 3 * 1024 * 1024;
// ตรวจจากไบต์ขึ้นต้นจริง ไม่เชื่อนามสกุลหรือ content-type ที่ผู้ส่งบอกมา
const PHOTO_SIGNATURES: { mime: string; ext: string; magic: number[] }[] = [
  { mime: 'image/jpeg', ext: 'jpg', magic: [0xff, 0xd8, 0xff] },
  { mime: 'image/png',  ext: 'png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }
];

export type PhotoResult = { error: string } | { file: string; mime: string; bytes: number } | null;

// คืน null เมื่อไม่ได้แนบรูปมา ซึ่งถูกต้องเพราะรูปเป็นของแถมไม่ใช่ของบังคับ
export async function saveExpensePhoto(value: unknown): Promise<PhotoResult> {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return { error: 'รูปใบเสร็จไม่ถูกต้อง' };
  const base64 = value.startsWith('data:') ? value.slice(value.indexOf(',') + 1) : value;
  if (!/^[A-Za-z0-9+/]+=*$/.test(base64)) return { error: 'รูปใบเสร็จไม่ถูกต้อง' };
  let buffer: Buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch {
    return { error: 'รูปใบเสร็จไม่ถูกต้อง' };
  }
  if (!buffer.length) return { error: 'รูปใบเสร็จไม่ถูกต้อง' };
  if (buffer.length > PHOTO_MAX_BYTES) {
    return { error: `รูปใบเสร็จต้องไม่เกิน ${Math.floor(PHOTO_MAX_BYTES / 1024 / 1024)} MB` };
  }
  const signature = PHOTO_SIGNATURES.find(item =>
    item.magic.every((byte, index) => buffer[index] === byte));
  if (!signature) return { error: 'แนบได้เฉพาะไฟล์รูปภาพ JPG หรือ PNG' };
  const file = `${Date.now().toString(36)}-${crypto.randomBytes(12).toString('hex')}.${signature.ext}`;
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.writeFile(path.join(UPLOAD_DIR, file), buffer);
  return { file, mime: signature.mime, bytes: buffer.length };
}

// ชื่อไฟล์มาจากฐานข้อมูลก็จริง แต่ยังกันไว้ไม่ให้หลุดออกนอกโฟลเดอร์ได้เด็ดขาด
export function photoPath(file: string): string | null {
  if (!/^[A-Za-z0-9-]+\.(jpg|png)$/.test(file)) return null;
  const full = path.join(UPLOAD_DIR, file);
  return full.startsWith(UPLOAD_DIR + path.sep) ? full : null;
}

export async function removeExpensePhoto(file: string | null | undefined) {
  if (!file) return;
  const full = photoPath(file);
  if (!full) return;
  await fs.rm(full, { force: true }).catch(() => {});
}

// เสิร์ฟรูปแบบล็อกดาวน์: ห้ามเบราว์เซอร์เดารูปแบบไฟล์ ห้ามรันสคริปต์ และไม่ให้แคชค้างในตัวกลาง
export async function sendPhoto(reply: FastifyReply, file: string, mime: string) {
  const full = photoPath(file);
  if (!full) return reply.code(404).send({ error: 'ไม่พบรูปใบเสร็จ' });
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(full);
  } catch {
    return reply.code(404).send({ error: 'ไม่พบรูปใบเสร็จ' });
  }
  return reply
    .header('Content-Type', mime)
    .header('Content-Disposition', 'inline')
    .header('X-Content-Type-Options', 'nosniff')
    .header('Content-Security-Policy', "default-src 'none'; sandbox")
    .header('Cache-Control', 'private, no-store')
    .send(buffer);
}
