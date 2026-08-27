/**
 * src/routes/contacts.js
 * ───────────────────────────────────────────────────────────────────────
 *   GET    /api/contacts        — সেভ করা কনট্যাক্ট (registered / unregistered)
 *   POST   /api/contacts/sync   — কনট্যাক্ট লিস্ট সিঙ্ক
 *   DELETE /api/contacts/:id    — একটি কনট্যাক্ট মুছে ফেলা
 *
 * ⚠️ গোপনীয়তা: অ্যাপ কখনো নিজে থেকে ডিভাইসের ফোনবুক পড়ে না। ব্যবহারকারী
 * নিজে JSON/CSV আকারে কনট্যাক্ট দেন, অথবা ব্রাউজারে Contact Picker API
 * (navigator.contacts.select) সমর্থিত হলে স্পষ্ট অনুমতি নিয়ে বেছে দেন।
 * সার্ভার শুধু normalized ফোন নম্বর মিলিয়ে দেখে কে রেজিস্টার্ড।
 */

'use strict';

const express = require('express');

const { getDb } = require('../../database');
const { asyncHandler } = require('../middleware/error-handler');
const { requireAuth } = require('../middleware/auth');
const { searchLimiter } = require('../middleware/rate-limit');
const { presentUser } = require('../services/visibility');
const { normalizePhone } = require('../utils/phone');
const { sanitizeLine, requireId } = require('../utils/validate');
const { badRequest, notFound } = require('../utils/errors');

const MAX_SYNC_ENTRIES = 500;

/** contact row → API shape (registered হলে user object সহ) */
async function presentContact(db, contact, viewer) {
  return {
    id: contact.id,
    phone: contact.phone,
    savedName: contact.savedName || (contact.user ? contact.user.name : ''),
    registered: contact.registered,
    createdAt: contact.createdAt,
    user: contact.user ? await presentUser(db, contact.user, viewer) : null
  };
}

function createContactsRouter() {
  const router = express.Router();
  router.use(requireAuth);

  // ── সব কনট্যাক্ট ─────────────────────────────────────────────────
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const db = getDb();
      const contacts = await db.contacts.listForUser(req.user.id);
      const presented = [];
      for (const contact of contacts) {
        // eslint-disable-next-line no-await-in-loop
        presented.push(await presentContact(db, contact, req.user));
      }
      res.json({
        contacts: presented,
        registered: presented.filter((contact) => contact.registered),
        unregistered: presented.filter((contact) => !contact.registered)
      });
    })
  );

  // ── সিঙ্ক ────────────────────────────────────────────────────────
  // body: { contacts: [{ name, phone }, ...] }
  router.post(
    '/sync',
    searchLimiter,
    asyncHandler(async (req, res) => {
      const db = getDb();
      const incoming = Array.isArray(req.body.contacts) ? req.body.contacts : null;
      if (!incoming) throw badRequest('contacts অ্যারে পাঠাতে হবে', 'validation');
      if (incoming.length > MAX_SYNC_ENTRIES) {
        throw badRequest(`একবারে সর্বোচ্চ ${MAX_SYNC_ENTRIES}টি কনট্যাক্ট সিঙ্ক করা যায়`, 'too_many_contacts');
      }

      // ── normalize + dedupe + নিজের নম্বর বাদ ──────────────────────
      const entries = new Map();
      const skipped = [];
      for (const item of incoming) {
        const phone = normalizePhone(item && (item.phone || item.tel || item.number));
        if (!phone) {
          skipped.push(item && (item.phone || item.name) ? String(item.phone || item.name).slice(0, 40) : 'unknown');
          continue;
        }
        if (phone === req.user.phone) continue; // নিজেকে কনট্যাক্ট বানানো অর্থহীন
        const name = sanitizeLine((item && item.name) || '', 60);
        entries.set(phone, { phone, name });
      }

      const contacts = await db.contacts.sync(req.user.id, Array.from(entries.values()));
      const presented = [];
      for (const contact of contacts) {
        // eslint-disable-next-line no-await-in-loop
        presented.push(await presentContact(db, contact, req.user));
      }

      res.json({
        synced: entries.size,
        skipped,
        contacts: presented,
        registered: presented.filter((contact) => contact.registered),
        unregistered: presented.filter((contact) => !contact.registered)
      });
    })
  );

  // ── মুছে ফেলা ────────────────────────────────────────────────────
  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const db = getDb();
      const id = requireId(req.params.id, 'contact id');
      const removed = await db.contacts.remove(req.user.id, id);
      if (!removed) throw notFound('কনট্যাক্ট পাওয়া যায়নি', 'contact_not_found');
      res.json({ ok: true });
    })
  );

  return router;
}

module.exports = { createContactsRouter };
