/**
 * src/services/visibility.js
 * ───────────────────────────────────────────────────────────────────────
 * "কে কার কী দেখতে পাবে" — privacy প্রয়োগ করে user object তৈরির হেল্পার।
 *
 * WhatsApp-এর মতো নিয়ম: privacy = 'contacts' মানে "যারা আমাকে নিজেদের
 * কনট্যাক্টে সেভ করেছে"। তাই চেক করা হয় — target ইউজারের কনট্যাক্ট লিস্টে
 * viewer-এর ফোন নম্বর আছে কি না।
 */

'use strict';

const { publicUser } = require('./serialize');

async function presentUser(db, user, viewer) {
  if (!user) return null;
  let viewerIsContact = false;
  if (viewer && viewer.id !== user.id) {
    viewerIsContact = await db.contacts.isContact(user.id, viewer.phone);
  }
  return publicUser(user, { viewerId: viewer ? viewer.id : null, viewerIsContact });
}

async function presentUsers(db, users, viewer) {
  const output = [];
  for (const user of users) {
    // eslint-disable-next-line no-await-in-loop
    output.push(await presentUser(db, user, viewer));
  }
  return output;
}

module.exports = { presentUser, presentUsers };
