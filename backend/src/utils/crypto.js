const crypto = require('crypto');
const env = require('../config/env');

// AES-256-GCM encryption for sensitive identifiers (PAN, Aadhaar, bank account).
// Output layout: [12B iv][16B auth tag][ciphertext] stored in VARBINARY columns.
const KEY = Buffer.from(env.encryptionKey, 'utf8');

function encrypt(text) {
  if (text === null || text === undefined || text === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

function decrypt(buf) {
  if (!buf) return null;
  try {
    const data = typeof buf === 'string' ? Buffer.from(buf, 'base64') : buf;
    const iv = data.subarray(0, 12);
    const tag = data.subarray(12, 28);
    const ct = data.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (_) {
    return null;
  }
}

function maskPan(v) {
  if (!v) return '';
  return v.length === 10 ? `${v.slice(0, 5)}****${v.slice(9)}` : '•••••';
}
function maskAadhaar(v) {
  if (!v) return '';
  return `•••• •••• ${v.slice(-4)}`;
}
function maskBank(v) {
  if (!v) return '';
  return `••••••${v.slice(-4)}`;
}

module.exports = { encrypt, decrypt, maskPan, maskAadhaar, maskBank };
