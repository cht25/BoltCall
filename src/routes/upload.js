/**
 * src/routes/upload.js
 * ───────────────────────────────────────────────────────────────────────
 *   POST /api/upload/image   — ছবি (jpg/png/webp/gif)
 *   POST /api/upload/audio   — ভয়েস মেসেজ (webm/ogg/mp4/mp3/wav)
 *   POST /api/upload/file    — ডকুমেন্ট (pdf/txt/zip/doc/docx)
 *
 * তিনটিই authenticated + rate-limited + magic-byte যাচাইকৃত
 * (src/services/uploads.js দেখুন)। রেসপন্স:
 *   { file: { url, name, size, mime, category } }
 * এই url পরে মেসেজ পাঠানোর সময় mediaUrl হিসেবে ব্যবহার করা হয়।
 *
 * ⚠️ Render-এর মতো প্ল্যাটফর্মে ডিফল্ট ডিস্ক ephemeral — deploy/restart-এ
 * আপলোড হারিয়ে যেতে পারে। প্রোডাকশনের জন্য S3/R2 জাতীয় object storage
 * ব্যবহার করুন (README-তে আর্কিটেকচার ব্যাখ্যা করা আছে)।
 */

'use strict';

const express = require('express');

const { asyncHandler } = require('../middleware/error-handler');
const { requireAuth } = require('../middleware/auth');
const { uploadLimiter } = require('../middleware/rate-limit');
const { createUploader, verifyAndDescribe } = require('../services/uploads');

function createUploadRouter() {
  const router = express.Router();
  router.use(requireAuth);
  router.use(uploadLimiter);

  const uploaders = {
    image: createUploader('image'),
    audio: createUploader('audio'),
    file: createUploader('file')
  };

  /** তিনটি endpoint একই লজিক ব্যবহার করে, শুধু category আলাদা */
  const handler = (category) => [
    uploaders[category].single('file'),
    asyncHandler(async (req, res) => {
      const described = await verifyAndDescribe(req.file, category);
      res.status(201).json({ file: described });
    })
  ];

  router.post('/image', ...handler('image'));
  router.post('/audio', ...handler('audio'));
  router.post('/file', ...handler('file'));

  return router;
}

module.exports = { createUploadRouter };
