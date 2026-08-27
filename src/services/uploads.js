/**
 * src/services/uploads.js
 * ───────────────────────────────────────────────────────────────────────
 * নিরাপদ মিডিয়া আপলোড (Multer + disk storage)।
 *
 * নিরাপত্তা চেকলিস্ট (প্রতিটি এখানে বাস্তবায়িত):
 *   ১) সাইজ লিমিট — MAX_FILE_SIZE_MB (Multer limits)
 *   ২) extension allowlist — অজানা extension সরাসরি বাতিল
 *   ৩) client MIME allowlist — সস্তা প্রাথমিক ফিল্টার (কিন্তু বিশ্বাস করা হয় না)
 *   ৪) magic-byte যাচাই — আপলোডের পর ফাইলের আসল ধরন পরীক্ষা; না মিললে
 *      ফাইল ডিস্ক থেকে মুছে ফেলা হয় (src/utils/sniff.js)
 *   ৫) র‍্যান্ডম ফাইলনেম — ইউজারের দেওয়া নাম কখনো পাথে ব্যবহার হয় না
 *      (path traversal / overwrite প্রতিরোধ)
 *   ৬) এক্সিকিউটেবল কখনো গ্রহণ করা হয় না, এবং /uploads ডিরেক্টরি শুধু
 *      static ফাইল হিসেবে (nosniff + attachment হেডারসহ) সার্ভ হয় — সার্ভারে
 *      কোনো আপলোড করা ফাইল কখনো execute হয় না
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const config = require('../config');
const logger = require('../utils/logger');
const { detectFromFile } = require('../utils/sniff');
const { badRequest, payloadTooLarge } = require('../utils/errors');

// ── ক্যাটেগরি অনুযায়ী নিয়ম ────────────────────────────────────────────
const CATEGORIES = {
  image: {
    dir: 'images',
    exts: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
    clientMimes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
    sniffMimes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
  },
  avatar: {
    dir: 'avatars',
    exts: ['jpg', 'jpeg', 'png', 'webp'],
    clientMimes: ['image/jpeg', 'image/png', 'image/webp'],
    sniffMimes: ['image/jpeg', 'image/png', 'image/webp']
  },
  audio: {
    dir: 'audio',
    exts: ['webm', 'ogg', 'oga', 'mp3', 'm4a', 'mp4', 'wav', 'aac'],
    clientMimes: [
      'audio/webm',
      'audio/ogg',
      'audio/mpeg',
      'audio/mp3',
      'audio/mp4',
      'audio/x-m4a',
      'audio/aac',
      'audio/wav',
      'audio/wave',
      'audio/x-wav',
      'video/webm' // কিছু ব্রাউজার MediaRecorder-এ audio-only হলেও video/webm বলে
    ],
    sniffMimes: ['audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav']
  },
  file: {
    dir: 'files',
    exts: ['pdf', 'txt', 'zip', 'doc', 'docx'],
    clientMimes: [
      'application/pdf',
      'text/plain',
      'application/zip',
      'application/x-zip-compressed',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ],
    sniffMimes: [
      'application/pdf',
      'text/plain',
      'application/zip',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ]
  }
};

/** আপলোড ডিরেক্টরিগুলো তৈরি করে (প্রথম বুটে) */
function ensureUploadDirs() {
  for (const category of Object.values(CATEGORIES)) {
    fs.mkdirSync(path.join(config.upload.dir, category.dir), { recursive: true });
  }
  // .gitkeep — খালি ডিরেক্টরি রিপোতে টিকে থাকার জন্য
  const keep = path.join(config.upload.dir, '.gitkeep');
  if (!fs.existsSync(keep)) fs.writeFileSync(keep, '');
}

const extensionOf = (filename) =>
  String(path.extname(filename || '') || '')
    .replace('.', '')
    .toLowerCase();

/** র‍্যান্ডম, নিরাপদ ফাইলনেম: <32 hex>.<ext> */
function safeFilename(ext) {
  return `${crypto.randomBytes(16).toString('hex')}.${ext}`;
}

/**
 * নির্দিষ্ট ক্যাটেগরির জন্য multer instance তৈরি করে।
 * @param {'image'|'avatar'|'audio'|'file'} categoryName
 */
function createUploader(categoryName) {
  const category = CATEGORIES[categoryName];
  if (!category) throw new Error(`অজানা upload category: ${categoryName}`);

  const storage = multer.diskStorage({
    destination(req, file, cb) {
      const target = path.join(config.upload.dir, category.dir);
      fs.mkdirSync(target, { recursive: true });
      cb(null, target);
    },
    filename(req, file, cb) {
      // extension নেওয়া হয় allowlist থেকে, ইউজারের নাম থেকে নয়
      let ext = extensionOf(file.originalname);
      if (!category.exts.includes(ext)) {
        // client MIME থেকে অনুমান (পরে magic-byte যাচাই হবেই)
        const guess = {
          'image/jpeg': 'jpg',
          'image/png': 'png',
          'image/webp': 'webp',
          'image/gif': 'gif',
          'audio/webm': 'webm',
          'video/webm': 'webm',
          'audio/ogg': 'ogg',
          'audio/mpeg': 'mp3',
          'audio/mp4': 'm4a',
          'audio/x-m4a': 'm4a',
          'audio/wav': 'wav',
          'application/pdf': 'pdf',
          'text/plain': 'txt',
          'application/zip': 'zip'
        }[file.mimetype];
        ext = guess || category.exts[0];
      }
      cb(null, safeFilename(ext));
    }
  });

  return multer({
    storage,
    limits: {
      fileSize: config.upload.maxFileSizeBytes,
      files: 1,
      fields: 12
    },
    fileFilter(req, file, cb) {
      const ext = extensionOf(file.originalname);
      const mime = String(file.mimetype || '').split(';')[0].toLowerCase();
      const extOk = !ext || category.exts.includes(ext);
      const mimeOk = category.clientMimes.includes(mime);
      if (!extOk || !mimeOk) {
        cb(badRequest(`এই ফাইল টাইপ অনুমোদিত নয় (${mime || ext || 'unknown'})`, 'unsupported_file_type'));
        return;
      }
      cb(null, true);
    }
  });
}

/**
 * আপলোড শেষে ফাইলের প্রকৃত ধরন যাচাই করে metadata রিটার্ন করে।
 * mismatch হলে ফাইল মুছে ফেলে error throw করে।
 */
async function verifyAndDescribe(file, categoryName) {
  const category = CATEGORIES[categoryName];
  if (!file) throw badRequest('কোনো ফাইল পাওয়া যায়নি', 'no_file');

  const remove = async () => {
    try {
      await fs.promises.unlink(file.path);
    } catch (err) {
      logger.warn('[upload] অবৈধ ফাইল মুছতে ব্যর্থ:', err.message);
    }
  };

  if (file.size > config.upload.maxFileSizeBytes) {
    await remove();
    throw payloadTooLarge(`ফাইল সর্বোচ্চ ${config.upload.maxFileSizeMb}MB হতে পারে`);
  }

  const detected = await detectFromFile(file.path);
  if (!detected || !category.sniffMimes.includes(detected.mime)) {
    await remove();
    logger.warn(
      `[upload] magic-byte যাচাই ব্যর্থ — category=${categoryName}, claimed=${file.mimetype}, detected=${detected ? detected.mime : 'unknown'}`
    );
    throw badRequest('ফাইলের প্রকৃত ধরন অনুমোদিত নয় (ফাইলটি ক্ষতিগ্রস্ত বা ছদ্মবেশী হতে পারে)', 'file_type_mismatch');
  }

  // detected extension ও ফাইলনেমের extension আলাদা হলে ফাইল rename করা হয়
  let filename = path.basename(file.path);
  const currentExt = extensionOf(filename);
  if (detected.ext !== currentExt && category.exts.includes(detected.ext)) {
    const renamed = `${path.basename(filename, `.${currentExt}`)}.${detected.ext}`;
    await fs.promises.rename(file.path, path.join(path.dirname(file.path), renamed));
    filename = renamed;
  }

  const url = `${config.upload.publicPath}/${category.dir}/${filename}`;
  return {
    url,
    name: path.basename(String(file.originalname || filename)).slice(0, 160),
    size: file.size,
    mime: detected.mime,
    category: categoryName
  };
}

/** URL → ডিস্ক পাথ (শুধু ভ্যালিড আপলোড পাথের জন্য) */
function resolveUploadPath(url) {
  const match = /^\/uploads\/(images|audio|files|avatars)\/([A-Za-z0-9._-]+)$/.exec(String(url || ''));
  if (!match) return null;
  return path.join(config.upload.dir, match[1], match[2]);
}

module.exports = { CATEGORIES, ensureUploadDirs, createUploader, verifyAndDescribe, resolveUploadPath };
