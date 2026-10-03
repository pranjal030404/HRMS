const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const env = require('../config/env');
const { HttpError } = require('../utils/helpers');

const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain', 'text/csv',
]);

/** Factory: upload to uploads/<subdir>/ with random file name. Field name defaults to 'file'. */
function upload(subdir, { fieldName = 'file', maxSizeMb = 15 } = {}) {
  const dir = path.join(env.uploadDir, subdir);
  fs.mkdirSync(dir, { recursive: true });
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, dir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().slice(0, 10);
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  });
  const mw = multer({
    storage,
    limits: { fileSize: maxSizeMb * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (!ALLOWED_MIME.has(file.mimetype)) return cb(new HttpError(400, `Unsupported file type: ${file.mimetype}`));
      cb(null, true);
    },
  });
  const handler = mw.single(fieldName);
  return (req, res, next) => {
    handler(req, res, (err) => {
      if (err instanceof multer.MulterError) return next(new HttpError(400, `Upload error: ${err.message}`));
      next(err);
    });
  };
}

/** Public-ish path of an uploaded file relative to uploadDir. */
function relPath(file) {
  return path.relative(env.uploadDir, file.path).replace(/\\/g, '/');
}

/**
 * Delete an already-written upload.
 *
 * `upload()` puts the file on disk before the route handler runs, which is
 * unavoidable — the size and mime type are only known once the bytes have arrived.
 * It means a request refused *after* that point (a cap, a failed insert) would
 * otherwise leave an orphan on disk that no row references: the tenant's real
 * storage keeps growing while their usage meter says they are under the limit.
 * Any handler that can reject must therefore call this on its way out.
 */
function discardUpload(file) {
  if (!file || !file.path) return;
  try {
    fs.unlinkSync(file.path);
  } catch (e) {
    // Already gone, or never written. Either way there is nothing to clean up, but a
    // real failure here means a leaked file, so it must not pass silently.
    if (e.code !== 'ENOENT') {
      console.error(`[upload] could not discard rejected upload ${file.path}: ${e.message}`);
    }
  }
}

module.exports = { upload, relPath, discardUpload };
