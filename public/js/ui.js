/**
 * public/js/ui.js
 * ───────────────────────────────────────────────────────────────────────
 * সাধারণ UI অবকাঠামো: toast, modal (focus trap সহ), confirm ডায়ালগ,
 * স্ক্রিন পরিবর্তন, স্কেলেটন/লোডিং স্টেট, সংযোগ ইন্ডিকেটর, lightbox।
 *
 * Accessibility: modal খুললে ফোকাস ভেতরে আটকে থাকে (Tab cycle), Esc-এ বন্ধ
 * হয়, এবং বন্ধ হলে আগের ফোকাসে ফিরে যায়। toast গুলো aria-live অঞ্চলে বসে।
 */

import { $, $$ } from './utils.js';

const modalStack = [];
let lastFocused = null;

// ══════════════ TOAST ══════════════
const ICONS = { success: '✅', error: '⛔', warning: '⚠️', info: 'ℹ️' };

export function toast(message, type = 'info', { timeout = 4200 } = {}) {
  const container = $('#toastContainer');
  if (!container) return () => {};

  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.innerHTML = `<span class="toast-icon" aria-hidden="true"></span><div class="toast-text"></div>
    <button class="toast-close" aria-label="Dismiss">✕</button>`;
  element.querySelector('.toast-icon').textContent = ICONS[type] || ICONS.info;
  element.querySelector('.toast-text').textContent = message;

  const remove = () => {
    if (!element.parentNode) return;
    element.classList.add('is-hiding');
    setTimeout(() => element.remove(), 200);
  };
  element.querySelector('.toast-close').addEventListener('click', remove);
  container.appendChild(element);
  if (timeout) setTimeout(remove, timeout);
  return remove;
}

// ══════════════ MODAL ══════════════
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

function trapFocus(event) {
  const modal = modalStack[modalStack.length - 1];
  if (!modal || event.key !== 'Tab') return;
  const focusable = $$(FOCUSABLE, modal).filter((el) => el.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function openModal(id, { focus } = {}) {
  const element = typeof id === 'string' ? $(id) : id;
  if (!element) return;
  if (!modalStack.length) lastFocused = document.activeElement;

  element.hidden = false;
  modalStack.push(element);
  document.addEventListener('keydown', trapFocus);

  const target = focus ? $(focus, element) : $$(FOCUSABLE, element).find((el) => el.offsetParent !== null);
  if (target) setTimeout(() => target.focus(), 40);
}

export function closeModal(id) {
  const element = typeof id === 'string' ? $(id) : id || modalStack[modalStack.length - 1];
  if (!element) return;
  element.hidden = true;
  const index = modalStack.indexOf(element);
  if (index > -1) modalStack.splice(index, 1);
  if (!modalStack.length) {
    document.removeEventListener('keydown', trapFocus);
    if (lastFocused && lastFocused.focus) lastFocused.focus();
    lastFocused = null;
  }
}

export const isModalOpen = () => modalStack.length > 0;
export const topModal = () => modalStack[modalStack.length - 1] || null;

export function closeTopModal() {
  const element = modalStack[modalStack.length - 1];
  if (element) closeModal(element);
}

/** সব modal-এর [data-close-modal] বাটন ও backdrop ক্লিক wiring */
export function initModals() {
  $$('.modal-backdrop').forEach((backdrop) => {
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) closeModal(backdrop);
    });
    $$('[data-close-modal]', backdrop).forEach((button) => {
      button.addEventListener('click', () => closeModal(backdrop));
    });
  });
}

// ══════════════ CONFIRM ══════════════
/** @returns {Promise<boolean>} */
export function confirmDialog({ title = 'Are you sure?', text = '', confirmLabel = 'Confirm', danger = true }) {
  return new Promise((resolve) => {
    const modal = $('#confirmModal');
    $('#confirmTitle').textContent = title;
    $('#confirmText').textContent = text;
    const okButton = $('#confirmOk');
    const cancelButton = $('#confirmCancel');
    okButton.textContent = confirmLabel;
    okButton.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;

    const cleanup = (result) => {
      okButton.removeEventListener('click', onOk);
      cancelButton.removeEventListener('click', onCancel);
      closeModal(modal);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);

    okButton.addEventListener('click', onOk);
    cancelButton.addEventListener('click', onCancel);
    openModal(modal, { focus: '#confirmOk' });
  });
}

// ══════════════ SCREENS ══════════════
export function showScreen(screen) {
  const loader = $('#appLoader');
  const auth = $('#authScreen');
  const app = $('#appShell');
  if (loader) loader.hidden = screen !== 'loading';
  if (auth) auth.hidden = screen !== 'auth';
  if (app) app.hidden = screen !== 'app';
}

/** মোবাইলে চ্যাট লিস্ট ↔ চ্যাট স্ক্রিন সুইচ */
export function setMobileView(view) {
  document.body.dataset.mobileView = view;
}

// ══════════════ CONNECTION ══════════════
export function setConnectionState(stateName, label) {
  const dot = $('#connDot');
  const text = $('#connState');
  if (dot) dot.dataset.state = stateName;
  if (text) text.textContent = label;
  const diag = $('#diagSocket');
  if (diag) diag.textContent = label;
}

// ══════════════ BUTTON LOADING ══════════════
export function setLoading(button, loading) {
  if (!button) return;
  button.classList.toggle('is-loading', !!loading);
  button.disabled = !!loading;
}

// ══════════════ FORM ERROR ══════════════
export function showFormError(selector, message) {
  const element = $(selector);
  if (!element) return;
  if (!message) {
    element.hidden = true;
    element.textContent = '';
    return;
  }
  element.hidden = false;
  element.textContent = message;
}

// ══════════════ LIGHTBOX ══════════════
export function openLightbox(url, name = 'image') {
  const image = $('#lightboxImage');
  const download = $('#lightboxDownload');
  image.src = url;
  image.alt = name;
  download.href = url;
  download.setAttribute('download', name);
  openModal('#lightbox');
}

// ══════════════ SKELETON ══════════════
export function setSkeleton(selector, visible) {
  const element = $(selector);
  if (element) element.hidden = !visible;
}
