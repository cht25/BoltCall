/**
 * src/utils/sniff.js
 * ───────────────────────────────────────────────────────────────────────
 * ফাইলের প্রকৃত ধরন "magic bytes" (file signature) দেখে নির্ণয় করা হয়।
 *
 * কেন দরকার? ব্রাউজার পাঠানো Content-Type ("client MIME") জাল করা যায়।
 * কেউ shell.sh কে image/png বলে পাঠাতে পারে। তাই আপলোডের পর ফাইলের প্রথম
 * কয়েক কিলোবাইট পড়ে আসল ধরন যাচাই করা হয় — না মিললে ফাইল মুছে ফেলা হয়।
 */

'use strict';

const fs = require('fs');

/** buffer-এর নির্দিষ্ট offset-এ hex signature মেলে কি না */
function matches(buffer, signatureHex, offset = 0) {
  const signature = Buffer.from(signatureHex.replace(/\s/g, ''), 'hex');
  if (buffer.length < offset + signature.length) return false;
  return buffer.subarray(offset, offset + signature.length).equals(signature);
}

/** ASCII স্ট্রিং মেলানো */
function matchesAscii(buffer, text, offset = 0) {
  if (buffer.length < offset + text.length) return false;
  return buffer.subarray(offset, offset + text.length).toString('latin1') === text;
}

/** buffer কি বৈধ UTF-8 টেক্সট (NUL byte ছাড়া)? — .txt যাচাইয়ের জন্য */
function looksLikeText(buffer) {
  if (buffer.includes(0)) return false;
  const decoded = buffer.toString('utf8');
  // replacement character মানে অবৈধ UTF-8 sequence
  if (decoded.includes('\uFFFD')) return false;
  // eslint-disable-next-line no-control-regex
  const controlChars = decoded.match(/[\u0000-\u0008\u000E-\u001F]/g);
  return !controlChars || controlChars.length / decoded.length < 0.01;
}

/**
 * @returns {{mime:string, ext:string}|null}
 */
function detectFromBuffer(buffer) {
  if (!buffer || buffer.length < 4) return null;

  // ── ছবি ──────────────────────────────────────────────────────────
  if (matches(buffer, 'FFD8FF')) return { mime: 'image/jpeg', ext: 'jpg' };
  if (matches(buffer, '89504E470D0A1A0A')) return { mime: 'image/png', ext: 'png' };
  if (matchesAscii(buffer, 'GIF87a') || matchesAscii(buffer, 'GIF89a')) {
    return { mime: 'image/gif', ext: 'gif' };
  }
  if (matchesAscii(buffer, 'RIFF') && matchesAscii(buffer, 'WEBP', 8)) {
    return { mime: 'image/webp', ext: 'webp' };
  }
  if (matchesAscii(buffer, 'RIFF') && matchesAscii(buffer, 'WAVE', 8)) {
    return { mime: 'audio/wav', ext: 'wav' };
  }
  if (matchesAscii(buffer, 'BM')) return { mime: 'image/bmp', ext: 'bmp' };

  // ── অডিও / ভিডিও কনটেইনার ────────────────────────────────────────
  // WebM/Matroska (Chrome-এর MediaRecorder ডিফল্ট: audio/webm;codecs=opus)
  if (matches(buffer, '1A45DFA3')) return { mime: 'audio/webm', ext: 'webm' };
  if (matchesAscii(buffer, 'OggS')) return { mime: 'audio/ogg', ext: 'ogg' };
  if (matchesAscii(buffer, 'ID3') || matches(buffer, 'FFFB') || matches(buffer, 'FFF3') || matches(buffer, 'FFF2')) {
    return { mime: 'audio/mpeg', ext: 'mp3' };
  }
  // ISO-BMFF: ....ftyp  → Safari-র MediaRecorder audio/mp4 দেয়
  if (matchesAscii(buffer, 'ftyp', 4)) {
    const brand = buffer.subarray(8, 12).toString('latin1');
    if (brand.startsWith('M4A') || brand.startsWith('mp4') || brand.startsWith('isom') || brand.startsWith('iso')) {
      return { mime: 'audio/mp4', ext: 'm4a' };
    }
    return { mime: 'video/mp4', ext: 'mp4' };
  }

  // ── ডকুমেন্ট ─────────────────────────────────────────────────────
  if (matchesAscii(buffer, '%PDF-')) return { mime: 'application/pdf', ext: 'pdf' };
  // ZIP কনটেইনার — docx/xlsx/pptx ও সাধারণ zip একই signature ব্যবহার করে
  if (matches(buffer, '504B0304') || matches(buffer, '504B0506') || matches(buffer, '504B0708')) {
    const head = buffer.subarray(0, Math.min(buffer.length, 2048)).toString('latin1');
    if (head.includes('word/')) {
      return {
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ext: 'docx'
      };
    }
    return { mime: 'application/zip', ext: 'zip' };
  }
  // পুরনো MS Office (doc/xls/ppt) — OLE2 কনটেইনার
  if (matches(buffer, 'D0CF11E0A1B11AE1')) return { mime: 'application/msword', ext: 'doc' };

  // ── এক্সিকিউটেবল → সরাসরি নিষিদ্ধ ────────────────────────────────
  if (matches(buffer, '7F454C46')) return { mime: 'application/x-elf', ext: 'elf' };
  if (matchesAscii(buffer, 'MZ')) return { mime: 'application/x-dosexec', ext: 'exe' };
  if (matchesAscii(buffer, '#!')) return { mime: 'application/x-sh', ext: 'sh' };

  // ── প্লেইন টেক্সট (signature নেই, তাই সবার শেষে) ───────────────────
  if (looksLikeText(buffer)) return { mime: 'text/plain', ext: 'txt' };

  return null;
}

/** ডিস্কে থাকা ফাইলের প্রথম 4KB পড়ে ধরন নির্ণয় করে */
async function detectFromFile(filePath) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, 4096, 0);
    return detectFromBuffer(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

module.exports = { detectFromBuffer, detectFromFile, looksLikeText };
