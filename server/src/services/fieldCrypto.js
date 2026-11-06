// Application-level field encryption (AES-256-GCM) for identifying fields such
// as phone numbers. In production on Atlas, MongoDB Client-Side Field Level
// Encryption or Queryable Encryption would replace this.
import crypto from 'node:crypto';
import { config } from '../config.js';

let warned = false;
function key() {
  if (config.fieldEncKey) return Buffer.from(config.fieldEncKey, 'hex');
  if (!warned) { console.warn('[crypto] FIELD_ENC_KEY not set; using a development key'); warned = true; }
  return crypto.createHash('sha256').update('cnis-dev-key').digest();
}

export function encrypt(plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

export function decrypt(token) {
  if (!token) return null;
  try {
    const [iv, tag, enc] = token.split('.').map((s) => Buffer.from(s, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export function maskPhone(phone) {
  if (!phone) return null;
  return phone.replace(/\d(?=\d{4})/g, '•');
}
