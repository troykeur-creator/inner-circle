import React, { useState, useEffect, useLayoutEffect, useCallback, useRef, useContext } from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";
import htm from "https://esm.sh/htm@3.1.1";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const html = htm.bind(React.createElement);
const cfg = window.APP_CONFIG || {};
const configured = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);
const sb = configured ? createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;

const Ctx = React.createContext(null);
const useApp = function () { return useContext(Ctx); };
const MAX_PHOTOS = 10;
const STORY_MS = 6000;
const MAX_VOICE_S = 120;
const SHORT_VIDEO_S = 30;        // anyone can post clips this long, any time
const MAX_VIDEO_S = 180;         // one longer clip (up to 3 minutes) per person per 24 hours
const VIDEO_BUDGET_BYTES = 18 * 1048576;  // long clips are squeezed to fit about this much
const MAX_VIDEO_BYTES = 12 * 1048576;  // clips bigger than this are re-encoded smaller

/* =====================  helpers  ===================== */
const PALETTE = ["#0879a0", "#4a3fd8", "#d9411f", "#0a8a80", "#b02a66", "#a85f00", "#2f63c4"];
function colorFor(key) {
  const s = String(key || "?");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
function initial(name) { return (name || "?").trim().charAt(0).toUpperCase(); }

/* Turn web addresses in text into tappable links (only http and https; opens in a new tab, no tracking) */
function Linkify({ text }) {
  const t = String(text == null ? "" : text);
  const re = /(https?:\/\/[^\s<>"]+|www\.[^\s<>"]+)/gi;
  const out = [];
  let last = 0, m, k = 0;
  while ((m = re.exec(t))) {
    let raw = m[0];
    let tail = "";
    const mt = raw.match(/[.,!?;:)\]'"]+$/);
    if (mt) { tail = mt[0]; raw = raw.slice(0, raw.length - tail.length); }
    if (m.index > last) out.push(t.slice(last, m.index));
    let href = /^https?:\/\//i.test(raw) ? raw : "https://" + raw;
    let ok = false;
    try { const u = new URL(href); ok = (u.protocol === "https:" || u.protocol === "http:") && u.hostname.indexOf(".") > 0; if (ok) href = u.href; } catch (e) { ok = false; }
    if (ok) {
      const shown = raw.replace(/^https?:\/\/(www\.)?/i, "");
      out.push(html`<a key=${"l" + (k++)} className="lnk" href=${href} target="_blank" rel="noopener noreferrer nofollow" onClick=${function (e) { e.stopPropagation(); }}>${shown.length > 45 ? shown.slice(0, 44) + "..." : shown}</a>`);
    } else out.push(raw);
    if (tail) out.push(tail);
    last = m.index + m[0].length;
  }
  if (last < t.length) out.push(t.slice(last));
  return out;
}

function nm(p) { return (p && p.display_name) || "Someone"; }

function agoLong(d) {
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (!(s >= 0)) return "";
  if (s < 60) return "just now";
  if (s < 3600) { const m = Math.floor(s / 60); return m + (m === 1 ? " minute ago" : " minutes ago"); }
  if (s < 86400) { const h = Math.floor(s / 3600); return h + (h === 1 ? " hour ago" : " hours ago"); }
  const days = Math.floor(s / 86400);
  if (days < 7) return days + (days === 1 ? " day ago" : " days ago");
  return new Date(d).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}
function agoShort(d) {
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (!(s >= 0)) return "";
  if (s < 60) return "now";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  if (s < 604800) return Math.floor(s / 86400) + "d";
  return Math.floor(s / 604800) + "w";
}
function daysSince(d) { return Math.floor((Date.now() - new Date(d).getTime()) / 86400000); }
function daysUntil(d) { return Math.max(0, Math.ceil((new Date(d).getTime() - Date.now()) / 86400000)); }

function lovedBy(names) {
  if (!names.length) return "";
  if (names.length === 1) return "Loved by " + names[0];
  if (names.length === 2) return "Loved by " + names[0] + " and " + names[1];
  const n = names.length - 2;
  return "Loved by " + names[0] + ", " + names[1] + " and " + n + (n === 1 ? " other" : " others");
}

function lsGet(k, fallback) { try { const v = localStorage.getItem(k); return v === null ? fallback : v; } catch (e) { return fallback; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function getSeen() { try { return new Set(JSON.parse(lsGet("ic-seen", "[]"))); } catch (e) { return new Set(); } }
function markSeen(id) { const s = getSeen(); s.add(id); lsSet("ic-seen", JSON.stringify(Array.from(s).slice(-300))); }

function isStandalone() {
  try { return (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true; } catch (e) { return false; }
}
function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent || "") || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); }

/* ---- push notifications ---- */
const VAPID_PUBLIC = "BHm6cnEMuBbq6SpQNBmRoLcd2ovUM3HMqcJuOpStei0kh6io2vSrHIpjmC_LX6yW0DohblUmTUtqAaTxpX18Tvo";
function pushCanWork() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && !!VAPID_PUBLIC;
}
function pushNeedsInstall() { return isIOS() && !isStandalone(); }
function b64ToBytes(b) {
  const pad = "=".repeat((4 - (b.length % 4)) % 4);
  const raw = atob((b + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
async function pushSave(sub) {
  const j = sub.toJSON();
  const r = await sb.rpc("save_push_sub", { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth });
  if (r.error) throw r.error;
}
function swReady() {   /* never wait forever for the service worker */
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise(function (_, rej) { setTimeout(function () { rej(new Error("The app helper has not started yet. Close the app completely, reopen it, and try again.")); }, 8000); }),
  ]);
}
function pushWhy(e) {   /* plain-words reason for a failure */
  const m = String((e && (e.message || e.details)) || e || "");
  if (/save_push_sub|function .* does not exist|schema cache|relation|42883|PGRST/i.test(m)) return "The database is missing a step (run push.sql in the Supabase SQL Editor). Detail: " + m.slice(0, 120);
  if (/not allowed|denied|permission/i.test(m)) return "The phone refused permission. Allow notifications for Inner Circle in the phone settings. Detail: " + m.slice(0, 100);
  if (/push service|registration failed|AbortError|network/i.test(m)) return "The phone could not reach its push service. Check the connection and try again. Detail: " + m.slice(0, 100);
  return m ? m.slice(0, 160) : "Unknown problem.";
}
async function pushEnable() {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return perm;
  const reg = await swReady();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(VAPID_PUBLIC) });
  await pushSave(sub);
  lsSet("ic-push", "1");
  window.dispatchEvent(new Event("ic-push-changed"));
  return "granted";
}
async function pushDisable() {
  lsSet("ic-push", "0");
  const reg = await swReady();
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    try { await sb.rpc("drop_push_sub", { p_endpoint: sub.endpoint }); } catch (e) {}
    await sub.unsubscribe();
  }
}
async function pushIsOn() {
  if (!pushCanWork() || Notification.permission !== "granted") return false;
  try { const reg = await navigator.serviceWorker.ready; return !!(await reg.pushManager.getSubscription()) && lsGet("ic-push", "") === "1"; } catch (e) { return false; }
}

async function signOutClean() {   /* stop this phone buzzing for the account being left, then sign out */
  try {
    if (pushCanWork() && Notification.permission === "granted") {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) await sb.rpc("drop_push_sub", { p_endpoint: sub.endpoint });
    }
  } catch (e) {}
  sb.auth.signOut();
}

let deferredInstall = null;
window.addEventListener("beforeinstallprompt", function (e) {
  e.preventDefault();
  deferredInstall = e;
  window.dispatchEvent(new Event("ic-installable"));
});
function useInstallable() {
  const st = useState(!!deferredInstall);
  useEffect(function () {
    const f = function () { st[1](!!deferredInstall); };
    window.addEventListener("ic-installable", f);
    return function () { window.removeEventListener("ic-installable", f); };
  }, []);
  return st[0];
}
async function runInstall() {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  try { await deferredInstall.userChoice; } catch (e) {}
  deferredInstall = null;
  window.dispatchEvent(new Event("ic-installable"));
}

function useKeyboardInset() {
  const st = useState(0);
  useEffect(function () {
    const vv = window.visualViewport;
    if (!vv) return;
    function f() { st[1](Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))); }
    vv.addEventListener("resize", f);
    vv.addEventListener("scroll", f);
    f();
    return function () { vv.removeEventListener("resize", f); vv.removeEventListener("scroll", f); };
  }, []);
  return st[0];
}

/* Invites: each link works once and expires in 7 days. */
function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const a = new Uint32Array(8);
  crypto.getRandomValues(a);
  return Array.from(a).map(function (n) { return chars[n % chars.length]; }).join("");
}
function inviteLink(code) { return location.origin + location.pathname + "?invite=" + encodeURIComponent(code); }
function inviteFromUrl() {
  try { return (new URLSearchParams(location.search).get("invite") || "").trim(); } catch (e) { return ""; }
}
async function sendInviteText(code, fromName, days) {
  const link = inviteLink(code);
  const text = (fromName ? fromName + " invited you to" : "You are invited to") +
    " Inner Circle, a private space for family and close friends. Tap the link to join (your invite code is filled in for you). It works once and expires in " + (days || 7) + " days. If it asks, the code is " + code + "." +
    " After you join, put it on your home screen. iPhone: open the link in Safari, tap the Share button, then Add to Home Screen. Android: tap Install when it asks.";
  if (navigator.share) {
    try { await navigator.share({ title: "Join Inner Circle", text: text, url: link }); return "shared"; }
    catch (e) { if (e && e.name === "AbortError") return "cancelled"; }
  }
  try { await navigator.clipboard.writeText(text + " " + link); return "copied"; }
  catch (e) { window.prompt("Copy this invite and send it:", text + " " + link); return "copied"; }
}

/* Shrinks photos before upload (saves storage and data, and fixes odd phone formats). */
function shrink(file, max) {
  max = max || 1600;
  return new Promise(function (resolve, reject) {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = function () {
      const r = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * r);
      c.height = Math.round(img.height * r);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(function (b) {
        URL.revokeObjectURL(url);
        if (b) resolve(b); else reject(new Error("Could not read that photo. Try a different one."));
      }, "image/jpeg", 0.85);
    };
    img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("Could not read that photo. Try a different one.")); };
    img.src = url;
  });
}

const GIF_MAX = 8 * 1048576;
function isGif(f) { return !!f && (f.type === "image/gif" || /\.gif$/i.test(f.name || "")); }
function gifProblem(f) { return f.size > GIF_MAX ? "That GIF is " + fmtSize(f.size) + ". Please pick one under 8 MB." : ""; }

function fmtSize(b) { return b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB"; }
function fmtTime(sec) { const m = Math.floor(sec / 60); const r = Math.round(sec % 60); return m + ":" + (r < 10 ? "0" : "") + r; }

/* Takes any video from the phone and fits it to our limits:
   at most MAX_VIDEO_S seconds, about 960 px wide, around 1.4 Mbps (roughly 5 MB for 30 seconds).
   It re-records the clip in the browser, so it works without any server. Returns { blob, poster, seconds, trimmed, original }. */
async function prepareVideo(file, onProgress, allowLong) {
  const url = URL.createObjectURL(file);
  const v = document.createElement("video");
  v.src = url; v.playsInline = true; v.setAttribute("playsinline", ""); v.preload = "auto"; v.muted = false; v.volume = 1;
  const cleanup = function () { try { v.pause(); } catch (e) {} v.removeAttribute("src"); try { v.load(); } catch (e) {} URL.revokeObjectURL(url); };
  try {
    await new Promise(function (res, rej) { v.onloadedmetadata = res; v.onerror = function () { rej(new Error("This phone could not read that video. Try a different one.")); }; });
    const realDur = isFinite(v.duration) && v.duration > 0 ? v.duration : MAX_VIDEO_S;
    const cap = allowLong ? MAX_VIDEO_S : SHORT_VIDEO_S;
    const target = Math.min(realDur, cap);
    const trimmed = realDur > cap + 0.5;
    const r = Math.min(1, (target > SHORT_VIDEO_S ? 720 : 960) / Math.max(v.videoWidth, v.videoHeight));
    /* squeeze harder the longer the clip is so it always fits our storage budget */
    const totalBps = Math.floor(VIDEO_BUDGET_BYTES * 8 / target);
    const videoBps = Math.max(450000, Math.min(1400000, totalBps - 64000));
    const w = Math.max(2, Math.round(v.videoWidth * r / 2) * 2);
    const h = Math.max(2, Math.round(v.videoHeight * r / 2) * 2);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const g = canvas.getContext("2d");

    /* poster frame */
    v.currentTime = Math.min(0.3, target / 2);
    await new Promise(function (res) { v.onseeked = res; setTimeout(res, 2500); });
    g.drawImage(v, 0, 0, w, h);
    const poster = await new Promise(function (res) { canvas.toBlob(res, "image/jpeg", 0.82); });

    /* small enough and a friendly format? keep the original, untouched */
    const okType = /^video\/(mp4|webm)$/.test(file.type);
    if (!trimmed && okType && file.size <= MAX_VIDEO_BYTES && r === 1) {
      onProgress(1);
      return { blob: file, poster: poster, seconds: target, trimmed: false, original: true };
    }
    if (!window.MediaRecorder || !canvas.captureStream) {
      if (!trimmed && file.size <= MAX_VIDEO_BYTES) { onProgress(1); return { blob: file, poster: poster, seconds: target, trimmed: false, original: true }; }
      throw new Error("This phone cannot shrink videos yet. Please choose a shorter or smaller clip.");
    }
    const types = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    const mime = types.find(function (t) { return MediaRecorder.isTypeSupported(t); }) || "";

    const stream = canvas.captureStream(30);
    let ac = null;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      ac = new AC();
      if (ac.state === "suspended") await ac.resume();
      const src = ac.createMediaElementSource(v);
      const dest = ac.createMediaStreamDestination();
      src.connect(dest);
      dest.stream.getAudioTracks().forEach(function (t) { stream.addTrack(t); });
    } catch (e) { /* no audio track; the clip will be silent */ }

    const rec = new MediaRecorder(stream, Object.assign({ videoBitsPerSecond: videoBps, audioBitsPerSecond: 64000 }, mime ? { mimeType: mime } : {}));
    const chunks = [];
    rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise(function (res) { rec.onstop = res; });

    v.currentTime = 0;
    await new Promise(function (res) { v.onseeked = res; setTimeout(res, 2500); });
    rec.start(500);
    try { await v.play(); } catch (e) { throw new Error("Could not start the video. Tap Add a short video again."); }
    let raf;
    await new Promise(function (resolve) {
      function tick() {
        g.drawImage(v, 0, 0, w, h);
        onProgress(Math.min(1, v.currentTime / target));
        if (v.ended || v.currentTime >= target) { resolve(); return; }
        raf = requestAnimationFrame(tick);
      }
      tick();
      v.onended = resolve;
    });
    cancelAnimationFrame(raf);
    v.pause();
    rec.stop();
    await stopped;
    if (ac) { try { ac.close(); } catch (e) {} }
    stream.getTracks().forEach(function (t) { t.stop(); });
    const type = (rec.mimeType || mime || "video/webm").split(";")[0];
    const blob = new Blob(chunks, { type: type });
    if (!blob.size) throw new Error("Could not prepare that video. Try a different one.");
    if (blob.size > 24 * 1048576) throw new Error("That clip is still too large. Please choose a shorter one.");
    onProgress(1);
    return { blob: blob, poster: poster, seconds: target, trimmed: trimmed, original: false };
  } finally { cleanup(); }
}

async function savePhoto(url, toast) {
  try {
    const blob = await (await fetch(url)).blob();
    const isVid = /^video/.test(blob.type);
    const file = new File([blob], isVid ? "inner-circle-video." + (/mp4/.test(blob.type) ? "mp4" : "webm") : "inner-circle-photo.jpg", { type: blob.type || "image/jpeg" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] });
      return;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast((isVid ? "Video" : "Photo") + " saved to your downloads");
  } catch (e) {
    if (e && e.name === "AbortError") return;
    window.open(url, "_blank");
    toast("Press and hold to save it");
  }
}

/* Download everything a person has shared as one file on their phone. */
async function downloadArchive(me, profiles, setStatus) {
  setStatus("Gathering your moments...");
  const r = await sb.from("posts").select("*").eq("author_id", me.id).order("created_at");
  if (r.error) throw r.error;
  const posts = r.data || [];
  const mod = await import("https://esm.sh/jszip@3.10.1");
  const JSZip = mod.default || mod;
  const zip = new JSZip();
  const lines = ["Inner Circle archive for " + (me.display_name || "me"), "Made " + new Date().toLocaleString(), ""];
  let n = 0;
  const total = posts.reduce(function (a, p) { return a + allPaths(p).length; }, 0);
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    const day = new Date(p.created_at).toISOString().slice(0, 10);
    const files = [];
    const ps = allPaths(p).filter(function (x) { return x !== p.image_path || !p.video_path; });
    await ensureUrls(ps);
    for (let k = 0; k < ps.length; k++) {
      n++;
      setStatus("Saving photo " + n + " of " + total + "...");
      const c = urlCache.get(ps[k]);
      if (!c) continue;
      try {
        const blob = await (await fetch(c.url)).blob();
        const isV = ps[k] === p.video_path;
        const name = (isV ? "videos/" : "photos/") + day + "-" + (i + 1) + (ps.length > 1 ? "-" + (k + 1) : "") + (isV ? (/\.mp4$/.test(ps[k]) ? ".mp4" : ".webm") : ".jpg");
        zip.file(name, blob);
        files.push(name);
      } catch (e) {}
    }
    lines.push(day + (p.place ? "  at " + p.place : ""));
    if (p.caption) lines.push(p.caption);
    if (files.length) lines.push("(" + files.join(", ") + ")");
    lines.push("");
  }
  zip.file("captions.txt", lines.join("\n"));
  setStatus("Packing it up...");
  const out = await zip.generateAsync({ type: "blob" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(out);
  a.download = "inner-circle-archive.zip";
  document.body.appendChild(a);
  a.click();
  a.remove();
  return posts.length;
}

/* Photos live in a private vault; each one gets a short-lived link. */
const urlCache = new Map();
const pendingUrls = new Map();
async function ensureUrls(paths) {
  const now = Date.now();
  const all = Array.from(new Set(paths.filter(Boolean)));
  const waits = all.filter(function (p) { return pendingUrls.has(p); }).map(function (p) { return pendingUrls.get(p); });
  const need = all.filter(function (p) {
    const c = urlCache.get(p);
    return !pendingUrls.has(p) && (!c || c.exp - now < 600000);
  });
  if (need.length) {
    const job = sb.storage.from("photos").createSignedUrls(need, 3600).then(function (r) {
      (r.data || []).forEach(function (d) {
        if (d.signedUrl) urlCache.set(d.path, { url: d.signedUrl, exp: now + 3600000 });
      });
    }).catch(function () {}).then(function () { need.forEach(function (p) { pendingUrls.delete(p); }); });
    need.forEach(function (p) { pendingUrls.set(p, job); });
    waits.push(job);
  }
  await Promise.all(waits);
}
function useUrls(paths) {
  const st = useState(0);
  const bump = st[1];
  const key = paths.filter(Boolean).join("|");
  useEffect(function () {
    let live = true;
    ensureUrls(paths).then(function () { if (live) bump(function (v) { return v + 1; }); }).catch(function () {});
    return function () { live = false; };
  }, [key]);
  return function (path) { const c = path && urlCache.get(path); return c ? c.url : null; };
}
function spanFor(n, k) { return n === 3 ? (k === 0 ? 6 : 3) : n === 2 || n === 4 ? 3 : k < 2 ? 3 : 2; }
function postPaths(p) { return [p.image_path].concat(p.extra_paths || []).filter(Boolean); }
function allPaths(p) { return postPaths(p).concat(p.video_path ? [p.video_path] : []); }

/* =====================  icons & small pieces  ===================== */
const ICONS = {
  heart: '<path d="M12 20s-7-4.4-9-9c-1.2-3 .6-6.5 4-6.5 2 0 3.5 1 5 3 1.5-2 3-3 5-3 3.4 0 5.2 3.5 4 6.5-2 4.6-9 9-9 9z"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8 14c1 1.6 2.4 2.4 4 2.4s3-.8 4-2.4"/><path d="M9 9.5h.01M15 9.5h.01"/>',
  gif: '<rect x="2.5" y="6" width="19" height="12" rx="3"/><path d="M9.5 10.5H7.8a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1h1.7v-1.2H8.6M12 10.3v3.4M14.5 13.7v-3.4h2.2M14.5 12h1.6"/>',
  comment: '<path d="M21 12a8.5 8.5 0 0 1-12.6 7.4L3 21l1.6-5.2A8.5 8.5 0 1 1 21 12z"/>',
  home: '<path d="M3 11l9-8 9 8v10h-6v-6H9v6H3z"/>',
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><circle cx="17" cy="9" r="2.5"/><path d="M17 14c2.6 0 4.5 1.7 4.5 4.5"/>',
  plus: '<rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><path d="M12 8v8M8 12h8"/>',
  plusSmall: '<path d="M12 5v14M5 12h14"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  more: '<circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  grid: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M4 10.5h16M4 15.5h16M9.5 4v16M14.5 4v16"/>',
  news: '<path d="M4 5h13v14H6a2 2 0 0 1-2-2zM17 9h3v8a2 2 0 0 1-2 2M8 9h5M8 13h5"/>',
  album: '<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M7 6V4h10v2M3 15l5-4 4 3 3-2 6 4"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  play: '<path d="M7 4.5v15l13-7.5z"/>',
  camera: '<path d="M4 8h3l2-2.5h6L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  chev: '<path d="M9 5l7 7-7 7"/>',
  stack: '<rect x="8" y="3" width="13" height="13" rx="2"/><path d="M5 8v11a2 2 0 0 0 2 2h11"/>'
};
function Icon({ n, s, fill, sw, color }) {
  return html`<svg width=${s || 26} height=${s || 26} viewBox="0 0 24 24" fill=${fill || "none"} stroke=${color || "currentColor"}
    strokeWidth=${sw || 1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML=${{ __html: ICONS[n] }}></svg>`;
}
function Logo({ s }) {
  const z = s || 28;
  return html`<svg width=${z} height=${z} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="5.5"></circle><circle cx="12" cy="12" r="1.6" fill="#d98a3d" stroke="none"></circle></svg>`;
}
function Avatar({ id, name, size }) {
  const s = size || 40;
  const c = useContext(Ctx);
  const path = c && c.profiles && c.profiles[id] && c.profiles[id].avatar_path;
  const urls = useUrls(path ? [path] : []);
  const u = path ? urls(path) : null;
  const st = { width: s + "px", height: s + "px", fontSize: Math.round(s * 0.42) + "px", background: colorFor(id || name) };
  if (u) st.background = "#ddd url(" + u + ") center / cover no-repeat";
  return html`<div className="av" style=${st} role=${u ? "img" : undefined} aria-label=${u ? (name || "Profile photo") : undefined}>${u ? "" : initial(name)}</div>`;
}
function TopBar({ title, back, right }) {
  return html`<div className="top back line">
    <button className="ibtn" aria-label="Back" onClick=${back}><${Icon} n="back" s=${26} sw=${2} /></button>
    <h1>${title}</h1>
    <div style=${{ minWidth: "2.75rem", display: "flex", justifyContent: "flex-end" }}>${right}</div>
  </div>`;
}
function Failed({ what, onRetry }) {
  return html`<div className="center" style=${{ padding: "3rem 1.5rem" }}>
    <p className="muted" style=${{ marginTop: 0 }}>${"We could not load " + (what || "this") + ". Check your connection and try again."}</p>
    <button className="btn" onClick=${onRetry}>Try again</button></div>`;
}
function Sheet({ title, label, onClose, children }) {
  const box = useRef(null);
  useEffect(function () { if (box.current) box.current.focus(); }, []);
  useEffect(function () {
    function k(e) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", k);
    return function () { window.removeEventListener("keydown", k); };
  }, []);
  return html`<div className="scrim" onClick=${onClose}>
    <div className="sheet" ref=${box} tabIndex="-1" role="dialog" aria-modal="true" aria-label=${title || label || "Menu"} onClick=${function (e) { e.stopPropagation(); }}>
      <div className="grab"></div>
      ${title && html`<h2 className="sheet-title">${title}</h2>`}
      ${children}
    </div></div>`;
}


/* =====================  emoji library  ===================== */
const EMOJI = [
  ["Smileys", "😀 😃 😄 😁 😆 😅 😂 🤣 🥲 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🥸 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🤭 🤫 🤥 😶 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 🤑 🤠 😈 👻 💀 🤖 🎃 😺 😸 😹 😻 😼 😽"],
  ["Love", "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 💌 😍 🥰 😘 💋 💍 💐 🌹 🌷 🌸 💒 👰 🤵 💏 💑 👨‍👩‍👧 👪 🫶 🥂 🍾"],
  ["Hands", "👍 👎 👏 🙌 👐 🤲 🤝 🙏 ✌️ 🤞 🤟 🤘 👌 🤌 🤏 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 🤙 💪 🦾 ✍️ 🤳 💅 🫰 🫶 🫡 🙋 🙆 🙇 🤷 🤦 💁 🕺 💃 🚶 🏃"],
  ["Party", "🎉 🎊 🎈 🎁 🎂 🍰 🧁 🎀 🪅 🥳 🎆 🎇 ✨ 🌟 ⭐ 💫 🔥 💯 🏆 🥇 🥈 🥉 🎖️ 🎵 🎶 🎤 🎧 🎸 🎹 🥁 🎷 🎺 🎻 🪩 💃 🕺 🍾 🥂 🍻 🍷 🍸 🍹 🎯 🎮 🎲 🎭 🎨 🎬 📸"],
  ["Food", "🍕 🍔 🍟 🌭 🌮 🌯 🥪 🍗 🍖 🥩 🥓 🍳 🥞 🧇 🥐 🍞 🧀 🥗 🍝 🍜 🍲 🍣 🍤 🍙 🍚 🍛 🥟 🍦 🍧 🍨 🍩 🍪 🍫 🍬 🍭 🍮 🍯 🍎 🍏 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🌽 🥕 🥔 🍄 🥜 ☕ 🍵 🥤 🧃 🥛 🍺 🍷 🥃"],
  ["Nature", "🌞 🌝 🌈 ☀️ ⛅ ☁️ 🌧️ ⛈️ ❄️ ☃️ ⛄ 🌊 💧 🔥 🌍 🌎 🌲 🌳 🌴 🌵 🌾 🌿 ☘️ 🍀 🍁 🍂 🍃 🌺 🌻 🌼 🌷 🌹 🥀 🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🦆 🦉 🦋 🐝 🐞 🐢 🐍 🐙 🐬 🐳 🦈 🐴 🦄 🐕 🐈 🦌"],
  ["Travel", "🚗 🚙 🚌 🚓 🚑 🚒 🏎️ 🛻 🚚 🚜 🏍️ 🚲 ✈️ 🛫 🛬 🚀 🚁 🛶 ⛵ 🚤 🛳️ 🚂 🚆 🏠 🏡 🏖️ 🏝️ 🏕️ ⛺ 🏔️ ⛰️ 🗻 🗽 🏰 🎡 🎢 🎠 🌅 🌄 🌇 🌃 🌉 🗺️ 🧭 🧳 🌴 🛞 🏁"],
  ["Sports", "⚽ 🏀 🏈 ⚾ 🥎 🎾 🏐 🏉 🎱 🏓 🏸 🥅 ⛳ 🏹 🎣 🥊 🥋 ⛷️ 🏂 🏄 🚣 🏊 🚴 🏋️ 🤸 🧘 🎿 🛷 🏆 🥇 🥁 〽️ 🐺"],
  ["Symbols", "❤️ 💯 ✅ ☑️ ✔️ ❌ ❓ ❗ ‼️ ⭐ ✨ 💥 💢 💦 💨 💬 💭 🗯️ 💤 🔔 🔕 📣 🕊️ ☮️ ✝️ 🙏 ♾️ 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ ➕ ➖ ➡️ ⬅️ ⬆️ ⬇️ 🔝 🆕 🆒 🆗 🏳️‍🌈 🇺🇸 🏴"]
].map(function (c) { return { name: c[0], list: Array.from(new Set(c[1].split(" ").filter(Boolean))) }; });

function EmojiSheet({ onPick, onClose }) {
  const [tab, setTab] = useState(0);
  const recent = (function () { try { return JSON.parse(lsGet("ic-emoji-recent", "[]")) || []; } catch (e) { return []; } })();
  const tabs = (recent.length ? [{ name: "Recent", list: recent }] : []).concat(EMOJI);
  const cur = tabs[Math.min(tab, tabs.length - 1)];
  function choose(em) {
    try { lsSet("ic-emoji-recent", JSON.stringify([em].concat(recent.filter(function (x) { return x !== em; })).slice(0, 24))); } catch (e) {}
    onPick(em);
  }
  return html`<${Sheet} title="Pick an emoji" onClose=${onClose}>
    <div className="emtabs" role="tablist">${tabs.map(function (t, i) {
      return html`<button key=${t.name} role="tab" aria-selected=${t === cur} className=${t === cur ? "on" : ""} onClick=${function () { setTab(i); }}>${t.name}</button>`;
    })}</div>
    <div className="emgrid">${cur.list.map(function (em) {
      return html`<button key=${em} aria-label=${"Add " + em} onClick=${function () { choose(em); }}>${em}</button>`;
    })}</div>
    <button className="btn grey block" style=${{ marginTop: ".8rem" }} onClick=${onClose}>Done</button>
  </${Sheet}>`;
}
/* A small smiley button. onPick(emoji) is called with each emoji chosen (the picker stays open so you can add several). */
function EmojiBtn({ onPick, light }) {
  const [open, setOpen] = useState(false);
  return html`<button type="button" className=${"ibtn emojibtn" + (light ? " light" : "")} aria-label="Add an emoji" onClick=${function () { setOpen(true); }}>
      <${Icon} n="smile" s=${24} sw=${1.8} /></button>
    ${open && html`<${EmojiSheet} onPick=${onPick} onClose=${function () { setOpen(false); }} />`}`;
}

/* =====================  sign in / join (text-message code) / email fallback  ===================== */
/* Never show raw server errors on the sign-in screen (they can include account details). */
function friendlyAuthError(err, fallback) {
  const m = String((err && err.message) || "");
  try { console.warn("auth error:", m); } catch (e) {}
  if (/rate|too many|seconds/i.test(m)) return "Too many tries. Please wait a minute and try again.";
  if (/invalid|expired|token/i.test(m)) return "That code did not work. Check the text and try again, or ask for a new one.";
  return fallback || "We could not send a text. Check the number and try again in a few minutes, or ask the organizer for help.";
}

function toE164(raw) {
  const t = String(raw || "").trim();
  const d = t.replace(/\D/g, "");
  if (t.startsWith("+")) return d.length >= 8 ? "+" + d : "";
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.charAt(0) === "1") return "+" + d;
  return "";
}

function AuthScreen({ toast, easy, setEasy }) {
  const urlCode = inviteFromUrl();
  const [mode, setMode] = useState(urlCode ? "up" : "in");   // in | up
  const [chosen, setChosen] = useState(!!urlCode);            // first visit: ask which door before showing a form
  const [step, setStep] = useState("details");                // details | code
  const [f, setF] = useState({ name: "", phone: "", code: urlCode, token: "" });
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(0);
  const set = function (k) { return function (e) { const v = e.target.value; setF(function (o) { return Object.assign({}, o, { [k]: v }); }); }; };

  useEffect(function () {
    if (wait <= 0) return;
    const t = setTimeout(function () { setWait(wait - 1); }, 1000);
    return function () { clearTimeout(t); };
  }, [wait]);

  function go(m) { setMode(m); setStep("details"); setChosen(true); }

  async function sendCode() {
    const phone = toE164(f.phone);
    if (!phone) throw new Error("Please type your mobile number with area code, like 404 555 0123. For another country start with + and the country code.");
    if (mode === "up") {
      if (!f.name.trim()) throw new Error("Please tell us your name so the family knows who you are.");
      const r = await sb.auth.signInWithOtp({ phone: phone, options: { data: { display_name: f.name.trim(), invite_code: f.code.trim() } } });
      if (r.error) throw new Error(friendlyAuthError(r.error));
    } else {
      const r = await sb.auth.signInWithOtp({ phone: phone, options: { shouldCreateUser: false } });
      if (r.error) {
        if (/signup|not allowed|not found/i.test(r.error.message || "")) throw new Error("We do not see that number yet. Tap Join with an invite below.");
        throw new Error(friendlyAuthError(r.error));
      }
    }
    setWait(30);
    setStep("code");
    toast("We texted you a code.");
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      {
        if (step === "details") await sendCode();
        else {
          const r = await sb.auth.verifyOtp({ phone: toE164(f.phone), token: f.token.trim(), type: "sms" });
          if (r.error) throw new Error(friendlyAuthError(r.error, "That code did not work. Check the text and try again, or ask for a new one."));
        }
      }
    } catch (err) {
      toast(err.message || "Something went wrong.");
    }
    setBusy(false);
  }
  async function resend() {
    if (wait > 0) return;
    setBusy(true);
    try { await sendCode(); } catch (err) { toast(err.message || "Could not send a new code."); }
    setBusy(false);
  }

  const phoneMode = true;
  const title = step === "code" ? "Sign in" : mode === "up" ? "Text me a code to join" : "Text me a code";
  return html`
    <div className="authwrap">
      <button className="aa" aria-label=${easy ? "Switch to standard text" : "Switch to larger text"} aria-pressed=${easy} onClick=${function () { setEasy(!easy); }}>Aa</button>
      <div className="center">
        <${Logo} s=${64} />
        <h1 className="serif" style=${{ fontSize: "2.4rem", letterSpacing: "-.02em", color: "#0879a0", margin: ".4rem 0 .2rem" }}>Inner Circle</h1>
        <p className="muted" style=${{ margin: 0 }}>Your people. Nobody else.</p>
      </div>
      ${!chosen && html`<div className="stack" style=${{ marginTop: "2rem" }}>
        <button className="btn block" style=${{ height: "3.6rem", fontSize: "1.05rem" }} onClick=${function () { go("in"); }}>I already have an account</button>
        <button className="btn grey block" style=${{ height: "3.6rem", fontSize: "1.05rem" }} onClick=${function () { go("up"); }}>I was invited, I'm new</button>
        <div className="muted center" style=${{ fontSize: ".85rem" }}>Not sure? If you have never opened Inner Circle on this phone, choose the second one.</div>
      </div>`}
      ${chosen && html`<form className="stack" onSubmit=${submit} style=${{ marginTop: "2rem" }}>
        ${phoneMode && step === "details" && html`
          ${mode === "up" && html`
            <label className="sr" htmlFor="a-name">Your name</label>
            <input id="a-name" className="field" type="text" placeholder="Your full name (how family knows you)" value=${f.name} onChange=${set("name")} autoComplete="name" />`}
          <label className="sr" htmlFor="a-phone">Mobile number</label>
          <input id="a-phone" className="field" type="tel" inputMode="tel" placeholder="Mobile number" value=${f.phone} onChange=${set("phone")} autoComplete="tel" />
          <div className="muted" style=${{ fontSize: ".8rem" }}>We will text you a code. Outside the US, start with + and your country code.</div>
          ${mode === "up" && html`
            <label className="sr" htmlFor="a-code">Invite code</label>
            <input id="a-code" className="field" type="text" placeholder="Invite code" value=${f.code} onChange=${set("code")} autoCapitalize="characters" autoComplete="off" />
            <div className="muted" style=${{ fontSize: ".8rem" }}>${urlCode ? "Your invite code was filled in from the link." : "No code yet? Leave it blank and the family organizer can welcome you in."}</div>`}`}
        ${phoneMode && step === "code" && html`
          <div className="center" style=${{ fontSize: ".95rem" }}>We texted a code to <b>${f.phone}</b>.</div>
          <label className="sr" htmlFor="a-token">Code from the text</label>
          <input id="a-token" className="field center" style=${{ fontSize: "1.6rem", letterSpacing: ".35em" }} type="text" inputMode="numeric" placeholder="123456" maxLength="8"
            value=${f.token} onChange=${set("token")} autoComplete="one-time-code" autoFocus />
          <div className="center">
            <button type="button" className="linkbtn" style=${{ fontWeight: 500 }} disabled=${wait > 0 || busy} onClick=${resend}>${wait > 0 ? "Send a new code in " + wait + "s" : "Send a new code"}</button>
            <button type="button" className="linkbtn" style=${{ fontWeight: 500 }} onClick=${function () { setStep("details"); }}>Wrong number?</button>
          </div>`}
        <button className="btn block" style=${{ height: "3.1rem" }} disabled=${busy}>${busy ? "One moment..." : phoneMode && step === "code" ? "Sign in" : title}</button>
      </form>`}
      <div style=${{ flex: 1 }}></div>
      <div className="center" style=${{ borderTop: "1px solid var(--line)", paddingTop: "1rem" }}>
        ${chosen && mode === "in" && html`<span>New here? <button className="linkbtn" onClick=${function () { go("up"); }}>Join with an invite</button></span>`}
        ${chosen && mode === "up" && html`<span>Already a member? <button className="linkbtn" onClick=${function () { go("in"); }}>Sign in</button></span>`}
        <div className="muted" style=${{ fontSize: ".75rem", marginTop: ".3rem" }}>Private. No ads. No algorithm. No strangers.</div>
      </div>
    </div>`;
}


function Waiting({ me, reloadMe }) {
  const removed = me.status === "removed";
  return html`
    <div className="authwrap center" style=${{ justifyContent: "center", alignItems: "center" }}>
      <${Logo} s=${56} />
      <h1 className="serif" style=${{ color: "#0879a0", margin: ".6rem 0" }}>${removed ? "Access ended" : "Almost in" + (me.display_name ? ", " + me.display_name : "")}</h1>
      <p className="muted">${removed ? "The family organizer has ended your access to Inner Circle." : "The family organizer has been asked to welcome you. This screen updates when they do, or tap the button to check."}</p>
      ${!removed && html`<div><button className="btn" onClick=${reloadMe}>Check again</button></div>`}
      <button className="linkbtn" onClick=${signOutClean}>Sign out</button>
    </div>`;
}

/* =====================  one post  ===================== */
function PostCard({ post, onChange, albumId }) {
  const { me, profiles, toast, push, groupNames } = useApp();
  const [busy, setBusy] = useState(false);
  const [albumSheet, setAlbumSheet] = useState(false);
  const [burst, setBurst] = useState(false);
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(post.caption || "");
  const [capOpen, setCapOpen] = useState(false);
  const [grid, setGrid] = useState(true);
  const [start, setStart] = useState(0);
  const startRef = useRef(null);
  const [idx, setIdx] = useState(0);
  const lastTap = useRef(0);
  const paths = post.video_path ? [] : postPaths(post);
  const vp = post.video_path;
  const urls = useUrls(allPaths(post));
  const author = profiles[post.author_id] || {};
  const authorName = nm(author);
  const hearted = post.hearts.some(function (h) { return h.user_id === me.id; });
  const names = post.hearts.slice().sort(function (a) { return a.user_id === me.id ? -1 : 1; }).map(function (h) {
    return h.user_id === me.id ? "you" : nm(profiles[h.user_id]);
  });
  const mineOrAdmin = post.author_id === me.id || me.role === "admin";
  const nComments = post.comments ? post.comments.length : 0;

  async function setHeart(on) {
    if (busy) return;
    setBusy(true);
    const r = on
      ? await sb.from("hearts").insert({ post_id: post.id, user_id: me.id })
      : await sb.from("hearts").delete().match({ post_id: post.id, user_id: me.id });
    if (r.error) toast(r.error.message);
    await onChange();
    setBusy(false);
  }
  function photoTap() {
    const now = Date.now();
    if (now - lastTap.current < 320) {
      lastTap.current = 0;
      setBurst(true);
      setTimeout(function () { setBurst(false); }, 700);
      if (!hearted) setHeart(true);
    } else { lastTap.current = now; }
  }
  async function remove() {
    setMenu(false);
    if (!confirm("Delete this post for everyone? This cannot be undone.")) return;
    const gone = allPaths(post);
    const r = await sb.from("posts").delete().eq("id", post.id);
    if (r.error) { toast(r.error.message); return; }
    if (gone.length) sb.storage.from("photos").remove(gone);
    await onChange();
  }
  async function saveCaption() {
    const r = await sb.from("posts").update({ caption: draft.trim(), edited_at: new Date().toISOString() }).eq("id", post.id);
    if (r.error) { toast(r.error.message); return; }
    setEditing(false);
    toast("Caption updated");
    await onChange();
  }
  function onScroll(e) { setIdx(Math.round(e.target.scrollLeft / Math.max(1, e.target.clientWidth))); }

  return html`
    <article className="post">
      <div className="phead">
        <button className="pauthor" onClick=${function () { push({ name: "profile", userId: post.author_id }); }}>
          <${Avatar} id=${post.author_id} name=${authorName} size=${36} />
          <div style=${{ minWidth: 0 }}>
            <div className="pname">${authorName}</div>
            ${post.place && html`<div className="psub">${post.place}</div>`}
          </div>
        </button>
        <button className="ibtn" aria-label="Post options" onClick=${function () { setMenu(true); }}><${Icon} n="more" s=${22} fill="currentColor" sw=${0} /></button>
      </div>
      ${vp && html`<div style=${{ position: "relative", background: "#000" }}>
        ${urls(vp) ? html`<video className="photo vid" src=${urls(vp)} poster=${urls(post.image_path) || undefined} controls playsInline preload="metadata" aria-label=${"Video shared by " + authorName}></video>` : html`<div className="photo ph"></div>`}
      </div>`}
      ${paths.length === 1 && html`
        <div style=${{ position: "relative" }} onClick=${photoTap}>
          ${urls(paths[0]) ? html`<img className="photo" src=${urls(paths[0])} alt=${"Photo shared by " + authorName} draggable="false" />` : html`<div className="photo ph"></div>`}
          ${burst && html`<div className="pop"><${Icon} n="heart" s=${90} fill="#fff" color="#fff" sw=${1} /></div>`}
        </div>`}
      ${paths.length > 1 && grid && html`<div className="fgrid">
        ${paths.slice(0, 5).map(function (p, k) {
          const over = k === 4 && paths.length > 5;
          const span = spanFor(paths.length, k);
          return html`<button className="ftile" key=${p} style=${{ gridColumn: "span " + span }} aria-label=${over ? "Show all " + paths.length + " photos" : "Open photo " + (k + 1)}
            onClick=${function () { startRef.current = k; setStart(k); setIdx(k); setGrid(false); }}>
            ${urls(p) ? html`<img src=${urls(p)} alt=${"Photo " + (k + 1) + " of " + paths.length + " shared by " + authorName} draggable="false" />` : html`<span className="ph"></span>`}
            ${over && html`<span className="fmore">+${paths.length - 5}</span>`}
          </button>`;
        })}
      </div>`}
      ${paths.length > 1 && !grid && html`
        <div style=${{ position: "relative" }}>
          <div className="carousel" ref=${function (el) { if (el && startRef.current !== null) { el.scrollLeft = startRef.current * el.clientWidth; startRef.current = null; } }} onScroll=${onScroll} onClick=${photoTap}>
            ${paths.map(function (p, k) {
              return html`<div className="slide" key=${p}>${urls(p) ? html`<img className="photo" src=${urls(p)} alt=${"Photo " + (k + 1) + " of " + paths.length + " shared by " + authorName} draggable="false" />` : html`<div className="photo ph"></div>`}</div>`;
            })}
          </div>
          <div className="count" aria-hidden="true">${idx + 1}/${paths.length}</div>
          <button className="gridbtn" onClick=${function () { setGrid(true); }}>Grid</button>
          ${burst && html`<div className="pop"><${Icon} n="heart" s=${90} fill="#fff" color="#fff" sw=${1} /></div>`}
        </div>
        <div className="dots" aria-hidden="true">${paths.map(function (p, k) { return html`<i key=${p} className=${k === idx ? "on" : ""}></i>`; })}</div>`}
      ${paths.length === 0 && !vp && post.caption && html`<div className="textpost" onClick=${photoTap}><${Linkify} text=${post.caption} /></div>`}
      <div className="acts">
        <button className=${"act" + (hearted ? " on" : "")} aria-label=${hearted ? "Remove your heart" : "Send a heart"} onClick=${function () { setHeart(!hearted); }}>
          <${Icon} n="heart" s=${26} fill=${hearted ? "#d1352b" : "none"} color=${hearted ? "#d1352b" : "currentColor"} />${names.length > 0 && html`<b>${names.length}</b>`}
        </button>
        <button className="act" aria-label="Comments" onClick=${function () { push({ name: "comments", postId: post.id }); }}>
          <${Icon} n="comment" s=${25} />${nComments > 0 && html`<b>${nComments}</b>`}
        </button>
      </div>
      ${names.length > 0 && html`<div className="likes">${lovedBy(names)}</div>`}
      ${(paths.length > 0 || vp) && post.caption && html`<div className=${"cap" + (capOpen ? "" : " clamp")}><b style=${{ fontWeight: 600 }}>${authorName}</b> <${Linkify} text=${post.caption} /></div>
        ${!capOpen && post.caption.length > 110 && html`<button className="morebtn" onClick=${function () { setCapOpen(true); }}>more</button>`}`}
      ${nComments > 0 && html`<button className="linkish" onClick=${function () { push({ name: "comments", postId: post.id }); }}>${nComments === 1 ? "View 1 comment" : "View all " + nComments + " comments"}</button>`}
      <button className="addc" aria-label="Add a comment" onClick=${function () { push({ name: "comments", postId: post.id }); }}>
        <${Avatar} id=${me.id} name=${me.display_name} size=${28} /><span>Add a comment...</span>
      </button>
      <div className="time">${agoLong(post.created_at)}${post.edited_at ? " · edited" : ""}</div>
      ${post.audience_group && html`<div className="aud"><${Icon} n="lock" s=${13} sw=${2} /> ${(groupNames && groupNames[post.audience_group]) || "A private group"} only</div>`}
      ${post.author_id === me.id && (post.hidden_from || []).length > 0 && html`<div className="aud"><${Icon} n="lock" s=${13} sw=${2} /> Hidden from ${post.hidden_from.length} ${post.hidden_from.length === 1 ? "person" : "people"}</div>`}
      ${menu && html`<${Sheet} onClose=${function () { setMenu(false); }}>
        ${paths.length > 0 && html`<button className="sheetbtn" onClick=${function () { setMenu(false); const u = urls(paths[idx] || paths[0]); if (u) savePhoto(u, toast); }}>Save photo to my phone</button>`}
        ${vp && html`<button className="sheetbtn" onClick=${function () { setMenu(false); const u = urls(vp); if (u) savePhoto(u, toast); }}>Save video to my phone</button>`}
        <button className="sheetbtn" onClick=${function () { setMenu(false); setAlbumSheet(true); }}>Add to a shared album</button>
        ${albumId && html`<button className="sheetbtn" onClick=${async function () { setMenu(false); const r = await sb.from("album_posts").delete().match({ album_id: albumId, post_id: post.id }); toast(r.error ? r.error.message : "Removed from album"); await onChange(); }}>Remove from this album</button>`}
        ${post.author_id === me.id && html`<button className="sheetbtn" onClick=${function () { setMenu(false); setDraft(post.caption || ""); setEditing(true); }}>Edit caption</button>`}
        ${mineOrAdmin && html`<button className="sheetbtn danger" onClick=${remove}>Delete post</button>`}
        <button className="sheetbtn" onClick=${function () { setMenu(false); }}>Cancel</button>
      </${Sheet}>`}
      ${albumSheet && html`<${AlbumPickSheet} postId=${post.id} onClose=${function () { setAlbumSheet(false); }} />`}
      ${editing && html`<${Sheet} title="Edit caption" onClose=${function () { setEditing(false); }}>
        <label className="sr" htmlFor=${"ec-" + post.id}>Caption</label>
        <textarea id=${"ec-" + post.id} className="field" rows="4" maxLength="3000" value=${draft} onChange=${function (e) { setDraft(e.target.value); }}></textarea>
        <div className="row" style=${{ marginTop: ".8rem" }}><button className="btn grey grow" onClick=${function () { setEditing(false); }}>Cancel</button><button className="btn grow" onClick=${saveCaption}>Save</button></div>
      </${Sheet}>`}
    </article>`;
}

/* =====================  home (stories + feed)  ===================== */
function GettingStarted({ hasPosts }) {
  const { me, push, openInvite } = useApp();
  const [hidden, setHidden] = useState(lsGet("ic-gs-hide", "") === "1");
  if (hasPosts) {
    if (hidden) return null;
    return html`<div className="pcard slim">
      <div className="grow"><div className="pt" style=${{ fontSize: ".95rem" }}>Just you here so far. Invite the family to see your moments.</div></div>
      <button className="btn sm" onClick=${function () { openInvite(); }}>Invite</button>
      <button className="linkbtn" aria-label="Hide this" onClick=${function () { lsSet("ic-gs-hide", "1"); setHidden(true); }}>Hide</button>
    </div>`;
  }
  return html`<div className="welcomecard">
    <h2 className="serif" style=${{ color: "#0879a0", margin: 0 }}>Welcome, ${me.display_name}</h2>
    <p style=${{ margin: ".4rem 0 .9rem" }}>Inner Circle is only as good as the people in it. Start by inviting the family, then share your first moment.</p>
    <div className="row">
      <button className="btn grow" onClick=${function () { openInvite(); }}>Invite your family</button>
      <button className="btn grey grow" onClick=${function () { push({ name: "new" }); }}>Share a moment</button>
    </div></div>`;
}

function PushAsk() {
  const [show, setShow] = useState(function () {
    return pushCanWork() && !pushNeedsInstall() && Notification.permission === "default" && lsGet("ic-push-ask", "") !== "1";
  });
  const [busy, setBusy] = useState(false);
  const { toast } = useApp();
  useEffect(function () {
    const h = function () { if (Notification.permission !== "default") setShow(false); };
    window.addEventListener("ic-push-changed", h);
    return function () { window.removeEventListener("ic-push-changed", h); };
  }, []);
  if (!show) return null;
  async function turnOn() {
    setBusy(true);
    try {
      const r = await pushEnable();
      if (r === "granted") toast("Notifications are on.");
      else toast("No problem. You can turn them on later in Me, then the gear icon.");
    } catch (e) { toast("Could not turn on notifications. Open Me, then the gear icon, and try the Notifications switch to see why."); }
    lsSet("ic-push-ask", "1"); setShow(false);
  }
  return html`<div className="pcard slim">
    <div className="grow"><div className="pt" style=${{ fontSize: ".95rem" }}>Get a buzz when family shares something new.</div></div>
    <button className="btn sm" disabled=${busy} onClick=${turnOn}>Turn on</button>
    <button className="linkbtn" onClick=${function () { lsSet("ic-push-ask", "1"); setShow(false); }}>Not now</button>
  </div>`;
}

function Home() {
  const { me, profiles, toast, push, tick, unread, memberCount } = useApp();
  const [posts, setPosts] = useState(null);
  const [stories, setStories] = useState([]);
  const [limit, setLimit] = useState(15);
  const [err, setErr] = useState(false);
  const [notes, setNotes] = useState([]);
  const [prompt, setPrompt] = useState(null);
  const [answers, setAnswers] = useState([]);
  const [news, setNews] = useState(null);
  const [noteSheet, setNoteSheet] = useState(null);

  const load = useCallback(async function () {
    const since = new Date(Date.now() - 86400000).toISOString();
    const res = await Promise.all([
      sb.from("posts").select("*, comments(id), hearts(user_id)").order("created_at", { ascending: false }).limit(limit),
      sb.from("posts").select("id,author_id,created_at").eq("also_day", true).gte("created_at", since).order("created_at"),
      sb.from("notes").select("*").gte("created_at", since),
      sb.from("prompts").select("*").order("created_at", { ascending: false }).limit(1),
      sb.from("news").select("*").order("created_at", { ascending: false }).limit(1)
    ]);
    if (res[0].error) { setErr(true); return; }
    setErr(false);
    setPosts(res[0].data);
    setStories(res[1].data || []);
    setNotes(res[2].data || []);
    setNews((res[4].data || [])[0] || null);
    const pr = (res[3].data || [])[0] || null;
    setPrompt(pr);
    if (pr) {
      const a = await sb.from("posts").select("id,author_id").eq("prompt_id", pr.id);
      setAnswers(a.data || []);
    } else setAnswers([]);
  }, [limit]);
  useEffect(function () { load(); }, [load, tick]);

  const seen = getSeen();
  const groups = {};
  stories.forEach(function (s) { (groups[s.author_id] = groups[s.author_id] || []).push(s.id); });
  const noteBy = {};
  notes.forEach(function (n) { noteBy[n.user_id] = n; });
  const trayIds = Object.keys(groups).concat(Object.keys(noteBy).filter(function (id) { return !groups[id]; })).filter(function (id) { return id !== me.id; });
  const others = trayIds.map(function (id) {
    return { id: id, hasStory: !!groups[id], allSeen: groups[id] ? groups[id].every(function (x) { return seen.has(x); }) : true };
  }).sort(function (a, b) {
    const ra = a.hasStory && !a.allSeen ? 0 : a.hasStory ? 1 : 2;
    const rb = b.hasStory && !b.allSeen ? 0 : b.hasStory ? 1 : 2;
    return ra - rb;
  });
  const myNote = noteBy[me.id];
  const mine = groups[me.id];
  const mineSeen = mine ? mine.every(function (x) { return seen.has(x); }) : false;

  const header = html`<div className="top compact"><div className="brand"><${Logo} />Inner Circle</div>
    <div className="row" style=${{ gap: 0 }}>
      ${posts && !noteBy[me.id] && html`<button className="notepill" onClick=${function () { setNoteSheet({ own: true, note: null }); }}>+ Note</button>`}
      <button className="ibtn" aria-label=${unread ? "Activity, new" : "Activity"} onClick=${function () { push({ name: "activity" }); }}><${Icon} n="heart" s=${24} />${unread && html`<span className="badge"></span>`}</button>
    </div></div>`;

  if (err && !posts) return html`<div>${header}<${Failed} what="your feed" onRetry=${load} /></div>`;
  if (!posts) return html`<div>${header}<div className="center muted" style=${{ padding: "4rem 1rem" }}>Loading your Inner Circle...</div></div>`;
  return html`
    <div>
      ${header}
      <div className=${"stories" + (Object.keys(noteBy).length ? " hasnote" : "")}>
        <div className="story">
          ${myNote && html`<button className="tbub" onClick=${function () { setNoteSheet({ own: true, note: myNote }); }}>${myNote.body}</button>`}
          <button className="storybtn" aria-label=${mine ? "View your day" : "Add to your day"}
            onClick=${function () { mine ? push({ name: "story", authorId: me.id }) : push({ name: "new", day: true }); }}>
            <div style=${{ position: "relative", width: "3.75rem", margin: "0 auto" }}>
              <div className=${"ring " + (mine ? (mineSeen ? "seen" : "") : "none")}><${Avatar} id=${me.id} name=${me.display_name} size=${52} /></div>
              <div className="plus"><${Icon} n="plusSmall" s=${12} sw=${3.5} color="#fff" /></div>
            </div>
            <div className="slabel">Your day</div>
          </button>
        </div>
        ${others.map(function (g) {
          const p = profiles[g.id] || {};
          const note = noteBy[g.id];
          return html`<div className="story" key=${g.id}>
            ${note && html`<button className="tbub" onClick=${function () { setNoteSheet({ own: false, note: note }); }}>${note.body}</button>`}
            <button className="storybtn" aria-label=${g.hasStory ? "View " + nm(p) + "'s day" : "Read " + nm(p) + "'s note"} onClick=${function () { g.hasStory ? push({ name: "story", authorId: g.id }) : setNoteSheet({ own: false, note: note }); }}>
              <div className=${"ring " + (g.hasStory ? (g.allSeen ? "seen" : "") : "none")}><${Avatar} id=${g.id} name=${p.display_name} size=${52} /></div>
              <div className="slabel" style=${{ color: g.hasStory && g.allSeen ? "var(--muted)" : "inherit" }}>${nm(p)}</div>
            </button>
          </div>`;
        })}
      </div>
      ${news && daysSince(news.created_at) < 14 && html`<${NewsCard} item=${news} />`}
      ${prompt && daysSince(prompt.created_at) < 14 && html`<${PromptCard} prompt=${prompt} answers=${answers} />`}
      ${noteSheet && html`<${NoteSheet} target=${noteSheet} onClose=${function () { setNoteSheet(null); }} onDone=${load} />`}
      <${PushAsk} />
      <${HomeCelebrate} />
      <${BackupReminder} />
      ${me.role === "admin" && memberCount <= 1 && posts && html`<${GettingStarted} hasPosts=${posts.length > 0} />`}
      ${posts.length === 0 && !(me.role === "admin" && memberCount <= 1) && html`
        <div className="center" style=${{ padding: "3rem 1.5rem" }}>
          <h2 className="serif" style=${{ color: "#0879a0" }}>It is quiet in here</h2>
          <p className="muted">Be the first to share a moment, or say hello to someone.</p>
          <div className="row" style=${{ justifyContent: "center" }}>
            <button className="btn" onClick=${function () { push({ name: "new" }); }}>Share something</button>
          </div>
        </div>`}
      ${posts.map(function (p) { return html`<${PostCard} key=${p.id} post=${p} onChange=${load} />`; })}
      ${posts.length >= limit && html`<div style=${{ padding: "1rem" }}><button className="btn grey block" onClick=${function () { setLimit(limit + 15); }}>Show older posts</button></div>`}
    </div>`;
}

/* =====================  stories ("Your day")  ===================== */
function StoryViewer({ authorId }) {
  const { profiles, back, me } = useApp();
  const [items, setItems] = useState(null);
  const [i, setI] = useState(0);
  const [typing, setTyping] = useState(false);
  const [run, setRun] = useState(0);
  const [reply, setReply] = useState("");
  const { toast } = useApp();
  const cur = items && items[i];
  const urls = useUrls(cur ? [cur.image_path] : []);
  const author = profiles[authorId] || {};

  useEffect(function () {
    (async function () {
      const since = new Date(Date.now() - 86400000).toISOString();
      const r = await sb.from("posts").select("*").eq("author_id", authorId).eq("also_day", true).gte("created_at", since).order("created_at");
      setItems(r.data || []);
    })();
  }, [authorId]);

  useEffect(function () {
    if (!cur) return;
    markSeen(cur.id);
    if (typing) return;
    const t = setTimeout(function () { if (i + 1 < items.length) setI(i + 1); else back(); }, STORY_MS);
    return function () { clearTimeout(t); };
  }, [cur && cur.id, typing, run]);

  async function sendReply(e) {
    e.preventDefault();
    const m = reply.trim();
    if (!m) return;
    const r = await sb.from("hellos").insert({ from_id: me.id, to_id: authorId, message: "Re: your day. " + m });
    if (r.error) { toast(r.error.message); return; }
    toast("Sent to " + nm(author));
    setReply("");
    setTyping(false);
    setRun(run + 1);
  }

  if (!items) return html`<div className="viewer"></div>`;
  if (!items.length) {
    return html`<div className="viewer"><div className="vh"><button className="ibtn" style=${{ color: "#fff" }} aria-label="Close" onClick=${back}><${Icon} n="close" /></button></div>
      <div className="vimg center" style=${{ padding: "2rem" }}>Nothing to see right now. Moments in Your day disappear after 24 hours.</div></div>`;
  }
  const url = urls(cur.image_path);
  return html`
    <div className="viewer">
      <div className="bars">${items.map(function (s, k) {
        return html`<div key=${s.id + (k === i ? "-" + run : "")}><i style=${k < i ? { width: "100%" } : k === i ? { animation: "fill " + STORY_MS + "ms linear forwards", animationPlayState: typing ? "paused" : "running" } : { width: "0%" }}></i></div>`;
      })}</div>
      <div className="vh">
        <${Avatar} id=${authorId} name=${author.display_name} size=${34} />
        <div className="grow"><b>${authorId === me.id ? "Your day" : nm(author)}</b> <span style=${{ opacity: .7, fontSize: ".85rem" }}>${agoShort(cur.created_at)}</span></div>
        <button className="ibtn" style=${{ color: "#fff" }} aria-label="Close" onClick=${back}><${Icon} n="close" /></button>
      </div>
      <div className="vimg">
        <button className="tap" style=${{ left: 0 }} aria-label="Previous" onClick=${function () { if (i > 0) setI(i - 1); }}></button>
        <button className="tap" style=${{ right: 0 }} aria-label="Next" onClick=${function () { if (i + 1 < items.length) setI(i + 1); else back(); }}></button>
        ${cur.image_path
          ? (url ? html`<img src=${url} alt=${"Moment from " + nm(author)} />` : html`<div className="muted">Loading...</div>`)
          : html`<div className="serif center" style=${{ padding: "2rem", fontSize: "1.6rem" }}>${cur.caption}</div>`}
      </div>
      ${cur.image_path && cur.caption && html`<div className="vcap">${cur.caption}</div>`}
      ${authorId !== me.id && html`<form className="vreply" onSubmit=${sendReply}>
        <label className="sr" htmlFor="vr">Reply to ${nm(author)}</label>
        <input id="vr" type="text" maxLength="120" placeholder=${"Reply to " + nm(author) + "..."} value=${reply}
          onFocus=${function () { setTyping(true); }} onBlur=${function () { if (!reply.trim()) { setTyping(false); setRun(run + 1); } }}
          onChange=${function (e) { setReply(e.target.value); }} />
        <button className="tbtn" style=${{ color: "#fff" }} disabled=${!reply.trim()}>Send</button>
      </form>`}
    </div>`;
}

/* =====================  comments (with replies)  ===================== */
function Comments({ postId }) {
  const { me, profiles, toast, back } = useApp();
  const [post, setPost] = useState(null);
  const [list, setList] = useState(null);
  const [err, setErr] = useState(false);
  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState(null);
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  const gifIn = useRef(null);
  const kb = useKeyboardInset();
  const QUICK = ["❤️", "😍", "🙌", "😂", "👏", "🔥"];

  const load = useCallback(async function () {
    const res = await Promise.all([
      sb.from("posts").select("*").eq("id", postId).maybeSingle(),
      sb.from("comments").select("*, comment_hearts(user_id)").eq("post_id", postId).order("created_at")
    ]);
    if (res[1].error) { setErr(true); return; }
    setErr(false);
    setPost(res[0].data);
    setList(res[1].data || []);
  }, [postId]);
  useEffect(function () { load(); }, [load]);

  async function sendBody(body) {
    if (!body || busy) return;
    setBusy(true);
    const r = await sb.from("comments").insert({ post_id: postId, author_id: me.id, body: body, parent_id: replyTo ? replyTo.id : null });
    if (r.error) toast(r.error.message); else { setText(""); setReplyTo(null); }
    await load();
    setBusy(false);
  }
  function send(e) { e.preventDefault(); sendBody(text.trim()); }
  async function pickGif(e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    if (!isGif(f)) { toast("Please choose a GIF."); return; }
    if (f.size > 5 * 1048576) { toast("That GIF is " + fmtSize(f.size) + ". For comments please pick one under 5 MB."); return; }
    setBusy(true);
    const path = me.id + "/" + (window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now())) + ".gif";
    try {
      const up = await sb.storage.from("photos").upload(path, f, { contentType: "image/gif" });
      if (up.error) throw up.error;
      const r = await sb.from("comments").insert({ post_id: postId, author_id: me.id, body: text.trim(), gif_path: path, parent_id: replyTo ? replyTo.id : null });
      if (r.error) { sb.storage.from("photos").remove([path]); throw r.error; }
      setText(""); setReplyTo(null);
    } catch (err) { toast((err && err.message) || "Could not send that GIF."); }
    await load();
    setBusy(false);
  }
  async function toggleHeart(c) {
    const on = c.comment_hearts.some(function (h) { return h.user_id === me.id; });
    const r = on
      ? await sb.from("comment_hearts").delete().match({ comment_id: c.id, user_id: me.id })
      : await sb.from("comment_hearts").insert({ comment_id: c.id, user_id: me.id });
    if (r.error) toast(r.error.message);
    load();
  }
  async function remove(c) {
    if (!confirm("Delete this comment?")) return;
    const del = await sb.from("comments").delete().eq("id", c.id);
    if (!del.error && c.gif_path) sb.storage.from("photos").remove([c.gif_path]);
    load();
  }
  function startReply(c) {
    const all = list || [];
    const top = c.parent_id ? all.find(function (x) { return x.id === c.parent_id; }) || c : c;
    setReplyTo(top);
    setText("@" + nm(profiles[c.author_id]) + " ");
    if (input.current) input.current.focus();
  }

  const authorOf = function (id) { return nm(profiles[id]); };
  const thumbUrls = useUrls(post ? [post.image_path].filter(Boolean) : []);
  const thumb = post && post.image_path ? thumbUrls(post.image_path) : null;
  const all = list || [];
  const gifUrls = useUrls(all.map(function (c) { return c.gif_path; }).filter(Boolean));
  const tops = all.filter(function (c) { return !c.parent_id; });
  const repliesOf = function (id) { return all.filter(function (c) { return c.parent_id === id; }); };

  function row(c, reply) {
    const hearted = c.comment_hearts.some(function (h) { return h.user_id === me.id; });
    const n = c.comment_hearts.length;
    return html`<div key=${c.id} className=${"cmt " + (reply ? "reply" : "")}>
      <${Avatar} id=${c.author_id} name=${authorOf(c.author_id)} size=${reply ? 28 : 36} />
      <div className="grow" style=${{ fontSize: ".9rem" }}>
        <div style=${{ overflowWrap: "anywhere" }}><b style=${{ fontWeight: 600 }}>${authorOf(c.author_id)}</b> ${c.body ? html`<${Linkify} text=${c.body} />` : ""}</div>
        ${c.gif_path && (gifUrls(c.gif_path) ? html`<img className="cgif" src=${gifUrls(c.gif_path)} alt="GIF" loading="lazy" />` : html`<div className="cgif ph"></div>`)}
        <div className="meta">${agoShort(c.created_at)}${n > 0 ? html`<b style=${{ marginLeft: ".8rem", fontWeight: 700 }}>${n === 1 ? "1 heart" : n + " hearts"}</b>` : ""}
          <button onClick=${function () { startReply(c); }}>Reply</button>
          ${(c.author_id === me.id || me.role === "admin") && html`<button onClick=${function () { remove(c); }}>Delete</button>`}
        </div>
      </div>
      <button className="ibtn" aria-label=${hearted ? "Remove heart" : "Heart this comment"} onClick=${function () { toggleHeart(c); }}>
        <${Icon} n="heart" s=${18} fill=${hearted ? "#d1352b" : "none"} color=${hearted ? "#d1352b" : "#6b6b6b"} sw=${2} />
      </button>
    </div>`;
  }

  return html`
    <div>
      <${TopBar} title="Comments" back=${back} />
      ${err && !list && html`<${Failed} what="the comments" onRetry=${load} />`}
      ${post && html`<div className="cmthead">
        ${thumb ? html`<img src=${thumb} alt="" />` : html`<${Avatar} id=${post.author_id} name=${authorOf(post.author_id)} size=${44} />`}
        <div className="grow" style=${{ minWidth: 0 }}>
          <div style=${{ fontWeight: 600 }}>${authorOf(post.author_id)}</div>
          <div className="clamp2">${post.caption || (thumb ? "Shared a photo" : "")}</div>
          <div className="muted" style=${{ fontSize: ".75rem", marginTop: ".1rem" }}>${agoShort(post.created_at)}</div>
        </div></div>`}
      ${list && tops.length === 0 && html`<div className="cmtempty">
        <div className="bub"><${Icon} n="comment" s=${30} sw=${1.6} color="#0879a0" /></div>
        <div className="serif" style=${{ fontSize: "1.25rem", color: "#0879a0" }}>Start the conversation</div>
        <div className="muted" style=${{ margin: ".2rem 0 .9rem" }}>Tap a quick reaction or write a few kind words.</div>
        <div className="qr">${QUICK.map(function (em) { return html`<button key=${em} aria-label=${"Send " + em} onClick=${function () { sendBody(em); }}>${em}</button>`; })}</div>
      </div>`}
      ${tops.map(function (c) {
        return html`<div key=${c.id}>${row(c, false)}${repliesOf(c.id).map(function (r) { return row(r, true); })}</div>`;
      })}
      <div style=${{ height: "9rem" }}></div>
      <div className="composer2" style=${{ bottom: kb + "px", paddingBottom: kb > 0 ? ".5rem" : "calc(env(safe-area-inset-bottom, 0px) + .5rem)" }}>
        ${replyTo && html`<div className="replybar">Replying to <b>${authorOf(replyTo.author_id)}</b><button onClick=${function () { setReplyTo(null); setText(""); }} aria-label="Cancel reply">Cancel</button></div>`}
        ${!replyTo && tops.length > 0 && html`<div className="qr small">${QUICK.map(function (em) { return html`<button key=${em} aria-label=${"Send " + em} onClick=${function () { sendBody(em); }}>${em}</button>`; })}</div>`}
        <form className="cform" onSubmit=${send}>
          <${Avatar} id=${me.id} name=${me.display_name} size=${34} />
          <${EmojiBtn} onPick=${function (em) { setText(function (t) { return (t + em).slice(0, 2000); }); if (input.current) input.current.focus(); }} />
          <input ref=${gifIn} type="file" accept="image/gif" onChange=${pickGif} style=${{ display: "none" }} />
          <button type="button" className="ibtn" aria-label="Add a GIF" disabled=${busy} onClick=${function () { gifIn.current.click(); }}><${Icon} n="gif" s=${26} sw=${1.8} /></button>
          <label className="sr" htmlFor="cm-in">Add a comment</label>
          <input id="cm-in" ref=${input} type="text" value=${text} maxLength="2000"
            placeholder=${replyTo ? "Write a reply..." : "Add a comment..."}
            onChange=${function (e) { setText(e.target.value); }} />
          <button className="sendbtn" aria-label="Post" disabled=${busy || !text.trim()}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button>
        </form>
      </div>
    </div>`;
}

/* =====================  new post (one or many photos)  ===================== */
function NewPost({ day, promptId, promptText, albumId, albumName }) {
  const { me, toast, back, bump, offerNudge } = useApp();
  const [aud, setAud] = useState({ mode: "all", groupId: null, groupName: "", except: [] });
  const [audOpen, setAudOpen] = useState(false);
  const meta = Object.assign({}, aud.mode === "group" && aud.groupId ? { audience_group: aud.groupId } : {}, aud.mode === "except" && aud.except.length ? { hidden_from: aud.except } : {}, promptId ? { prompt_id: promptId } : {});
  const [showAll, setShowAll] = useState(false);
  const [files, setFiles] = useState([]);
  const [caption, setCaption] = useState("");
  const [place, setPlace] = useState("");
  const [alsoDay, setAlsoDay] = useState(!!day);
  const [busy, setBusy] = useState("");
  const [video, setVideo] = useState(null);
  const postId = useRef((window.crypto && crypto.randomUUID) ? crypto.randomUUID() : null).current || undefined;
  const [longAt, setLongAt] = useState(null);   // when the next long video is allowed (null = allowed now)
  const input = useRef(null);
  const vinput = useRef(null);
  const ginput = useRef(null);
  useEffect(function () {
    const since = new Date(Date.now() - 86400000).toISOString();
    sb.from("posts").select("created_at").eq("author_id", me.id).gt("video_seconds", SHORT_VIDEO_S).gte("created_at", since).order("created_at", { ascending: false }).limit(1)
      .then(function (r) {
        const row = r.data && r.data[0];
        setLongAt(row ? new Date(new Date(row.created_at).getTime() + 86400000) : null);
      }).catch(function () {});
  }, []);

  function pickVideo(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const info = { name: file.name, size: file.size, pct: 0, status: "working", seconds: 0, trimmed: false };
    info.longOk = !longAt;
    info.promise = prepareVideo(file, function (f) { setVideo(function (v) { return v && v.name === file.name ? Object.assign({}, v, { pct: f }) : v; }); }, !longAt)
      .then(function (r) {
        setVideo(function (v) { return v && v.name === file.name ? Object.assign({}, v, { status: "ready", result: r, seconds: r.seconds, trimmed: r.trimmed, posterUrl: URL.createObjectURL(r.poster), outSize: r.blob.size }) : v; });
        return r;
      })
      .catch(function (err) {
        setVideo(null);
        toast((err && err.message) || "Could not prepare that video.");
        return null;
      });
    setFiles([]);
    setVideo(info);
  }

  function pick(e) {
    let chosen = Array.from(e.target.files || []);
    const tooBig = chosen.filter(function (f) { return isGif(f) && gifProblem(f); });
    if (tooBig.length) { toast(gifProblem(tooBig[0])); chosen = chosen.filter(function (f) { return tooBig.indexOf(f) < 0; }); }
    if (!chosen.length) { e.target.value = ""; return; }
    if (video) setVideo(null);
    setFiles(function (cur) {
      const room = MAX_PHOTOS - cur.length;
      if (chosen.length > room) toast("You can add up to " + MAX_PHOTOS + " photos to one post.");
      return cur.concat(chosen.slice(0, Math.max(0, room)).map(function (f) { return { file: f, url: URL.createObjectURL(f) }; }));
    });
    e.target.value = "";
  }
  function drop(k) { setFiles(function (cur) { try { URL.revokeObjectURL(cur[k].url); } catch (e) {} return cur.filter(function (_, i) { return i !== k; }); }); }

  async function submit() {
    if (!files.length && !video && !caption.trim()) { toast("Add a photo, a video or a few words first."); return; }
    setBusy("Sharing...");
    const uploaded = [];
    try {
      if (video) {
        setBusy("Preparing video...");
        const res = await video.promise;
        if (!res) { setBusy(""); return; }
        setBusy("Uploading video...");
        const id = (window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
        const ext = /mp4/.test(res.blob.type) ? "mp4" : "webm";
        const vpath = me.id + "/" + id + "." + ext;
        const ppath = me.id + "/" + id + "-poster.jpg";
        const u1 = await sb.storage.from("photos").upload(vpath, res.blob, { contentType: res.blob.type || "video/mp4" });
        if (u1.error) throw u1.error;
        uploaded.push(vpath);
        const u2 = await sb.storage.from("photos").upload(ppath, res.poster, { contentType: "image/jpeg" });
        if (u2.error) throw u2.error;
        uploaded.push(ppath);
        const rv = await sb.from("posts").insert(Object.assign({ id: postId, author_id: me.id, caption: caption.trim(), image_path: ppath, video_path: vpath, video_seconds: Math.round(res.seconds), extra_paths: [], place: place.trim(), also_day: alsoDay }, meta));
        if (rv.error) throw rv.error;
        if (albumId) await sb.from("album_posts").insert({ album_id: albumId, post_id: postId, added_by: me.id });
        toast("Shared with your Inner Circle");
        back();
        bump();
        if (aud.mode === "all") offerNudge();
        return;
      }
      for (let k = 0; k < files.length; k++) {
        setBusy(files.length > 1 ? "Uploading " + (k + 1) + " of " + files.length + "..." : "Uploading...");
        const gif = isGif(files[k].file);
        if (gif && gifProblem(files[k].file)) throw new Error(gifProblem(files[k].file));
        const blob = gif ? files[k].file : await shrink(files[k].file);
        const path = me.id + "/" + (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + k) + (gif ? ".gif" : ".jpg");
        const up = await sb.storage.from("photos").upload(path, blob, { contentType: gif ? "image/gif" : "image/jpeg" });
        if (up.error) throw up.error;
        uploaded.push(path);
      }
      const r = await sb.from("posts").insert(Object.assign({
        id: postId, author_id: me.id, caption: caption.trim(), image_path: uploaded[0] || null, extra_paths: uploaded.slice(1),
        place: place.trim(), also_day: alsoDay
      }, meta));
      if (r.error) throw r.error;
      if (albumId) await sb.from("album_posts").insert({ album_id: albumId, post_id: postId, added_by: me.id });
      toast("Shared with your Inner Circle");
      back();
      bump();
      if (aud.mode === "all") offerNudge();
    } catch (err) {
      if (uploaded.length) sb.storage.from("photos").remove(uploaded);
      toast((err && err.message) || "Could not share. Please try again.");
      setBusy("");
    }
  }

  return html`
    <div>
      <${TopBar} title="New post" back=${back} right=${html`<button className="tbtn" onClick=${submit} disabled=${!!busy}>${busy ? "..." : "Share"}</button>`} />
      ${promptId && html`<div className="promptbar"><b>Add yours:</b> ${promptText}</div>`}
      ${albumId && html`<div className="promptbar">Adding to the album: <b>${albumName}</b></div>`}
      <input ref=${input} type="file" accept="image/*" multiple onChange=${pick} style=${{ display: "none" }} />
      <input ref=${vinput} type="file" accept="video/*" onChange=${pickVideo} style=${{ display: "none" }} />
      <input ref=${ginput} type="file" accept="image/gif" multiple onChange=${pick} style=${{ display: "none" }} />
      ${!files.length && !video && html`<div className="pick2">
        <button onClick=${function () { input.current.click(); }}><${Icon} n="camera" s=${30} sw=${1.6} /><b>Photos</b><span>Up to ${MAX_PHOTOS} in one post</span></button>
        <button onClick=${function () { vinput.current.click(); }}><${Icon} n="play" s=${30} sw=${1.6} /><b>Video</b><span>${longAt ? "Up to 30 seconds. Longer opens at " + longAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "30 seconds, or 3 minutes once a day"}</span></button>
        <button onClick=${function () { ginput.current.click(); }}><${Icon} n="gif" s=${30} sw=${1.6} /><b>GIF</b><span>Animated, up to 8 MB</span></button>
      </div>`}
      <div className="row" style=${{ alignItems: "flex-start", padding: "1rem", borderBottom: "1px solid var(--soft)" }}>
        ${(files.length === 1 || video) && html`<button onClick=${function () { input.current.click(); }} aria-label=${files.length ? "Add more photos" : "Choose photos"}
          style=${{ flex: "none", width: "5.5rem", height: "5.5rem", borderRadius: ".4rem", border: files.length ? 0 : "1px dashed #b9b9b9", background: "#f4f4f4", padding: 0, overflow: "hidden", cursor: "pointer", color: "var(--muted)", fontSize: ".8rem", position: "relative" }}>
          ${video ? (video.posterUrl ? html`<img src=${video.posterUrl} alt="Video preview" style=${{ width: "100%", height: "100%", objectFit: "cover" }} /><span className="addmore">Video</span>` : html`<span>Preparing...</span>`)
            : files.length ? html`<img src=${files[0].url} alt="Your first chosen photo" style=${{ width: "100%", height: "100%", objectFit: "cover" }} />
            <span className="addmore">${files.length < MAX_PHOTOS ? "+ Add more" : files.length + " photos"}</span>` : html`<span>Add photos</span>`}
        </button>`}
        <label className="sr" htmlFor="np-cap">Caption</label>
        <textarea id="np-cap" className="field" style=${{ border: 0, background: "#fff", height: "5.5rem" }} maxLength="3000"
          placeholder="Tell them what is happening, who is in it, how it felt..." value=${caption} onChange=${function (e) { setCaption(e.target.value); }}></textarea>
        <div style=${{ display: "flex", justifyContent: "flex-end", marginTop: "-.3rem" }}><${EmojiBtn} onPick=${function (em) { setCaption(function (c) { return (c + em).slice(0, 3000); }); }} /></div>
      </div>
      ${files.length > 1 && html`<div className="collage">
        ${(showAll ? files : files.slice(0, 5)).map(function (f, k) {
          const over = !showAll && k === 4 && files.length > 5;
          const span = showAll ? 2 : spanFor(files.length, k);
          return html`<div className=${"ctile" + (over ? " over" : "")} key=${f.url} style=${{ gridColumn: "span " + span }}>
            <img src=${f.url} alt=${"Photo " + (k + 1)} />
            ${over ? html`<button className="more" aria-label=${"Show all " + files.length + " photos"} onClick=${function () { setShowAll(true); }}>+${files.length - 5}</button>`
              : html`<button className="x" aria-label=${"Remove photo " + (k + 1)} onClick=${function () { drop(k); }}><${Icon} n="close" s=${14} sw=${3} color="#fff" /></button>`}
          </div>`;
        })}
      </div>
      <div className="row" style=${{ padding: ".5rem 1rem 0" }}>
        ${files.length < MAX_PHOTOS && html`<button className="linkbtn" onClick=${function () { input.current.click(); }}>+ Add more photos</button>`}
        <span className="grow"></span>
        ${showAll && files.length > 5 && html`<button className="linkbtn" onClick=${function () { setShowAll(false); }}>Show fewer</button>`}
      </div>`}
      ${video ? html`<div style=${{ padding: ".6rem 1rem 0" }}>
          <div style=${{ fontSize: ".9rem" }}>${video.status === "working" ? "Getting your video ready... " + Math.round(video.pct * 100) + "%" : "Video ready: " + fmtTime(video.seconds) + ", " + fmtSize(video.outSize) + (video.outSize < video.size ? " (shrunk from " + fmtSize(video.size) + ")" : "")}</div>
          ${video.status === "working" && html`<div className="meter" style=${{ marginTop: ".3rem" }}><i style=${{ width: Math.round(video.pct * 100) + "%" }}></i></div>`}
          ${video.status === "working" && html`<div className="muted" style=${{ fontSize: ".8rem", marginTop: ".2rem" }}>Keep this screen open. Longer clips take about as long to prepare as they last.</div>`}
          ${video.trimmed && html`<div className="muted" style=${{ fontSize: ".8rem", marginTop: ".2rem" }}>${video.longOk ? "Videos can be up to 3 minutes, so we kept the first 3 minutes." : "Only one video longer than 30 seconds can be shared per day, so we kept the first 30 seconds."}</div>`}
          ${video.status === "ready" && video.seconds > SHORT_VIDEO_S && html`<div className="muted" style=${{ fontSize: ".8rem", marginTop: ".2rem" }}>This is your long video for today.</div>`}
          <button className="linkbtn" onClick=${function () { setVideo(null); }}>Remove video</button>
        </div>`
        : null}
      ${files.length === 1 && html`<div style=${{ padding: ".4rem 1rem 0" }}><button className="linkbtn" onClick=${function () { drop(0); }}>Remove photo</button></div>`}
      <div className="opt">
        <label className="sr" htmlFor="np-place">Add a place</label>
        <input id="np-place" className="field" style=${{ border: 0, background: "#fff", padding: 0, height: "2.75rem" }} placeholder="Add a place" maxLength="80" value=${place} onChange=${function (e) { setPlace(e.target.value); }} />
      </div>
      <div className="opt">
        <div className="grow"><div>Also add to Your day</div><div className="muted" style=${{ fontSize: ".75rem" }}>Shows at the top for 24 hours</div></div>
        <button role="switch" aria-checked=${alsoDay} aria-label="Also add to Your day" className=${"switch " + (alsoDay ? "on" : "")} onClick=${function () { setAlsoDay(!alsoDay); }}><i></i></button>
      </div>
      <button className="opt" style=${{ width: "100%", background: "none", border: 0, borderBottom: "1px solid var(--soft)", textAlign: "left", cursor: "pointer" }} onClick=${function () { setAudOpen(true); }}>
        <${Logo} s=${22} />
        <div className="grow"><div style=${{ fontWeight: 600 }}>Share with: ${aud.mode === "group" ? aud.groupName : aud.mode === "except" && aud.except.length ? "Everyone except " + aud.except.length : "Everyone in your Inner Circle"}</div><div className="muted" style=${{ fontSize: ".75rem" }}>Never public. Tap to choose a smaller group.</div></div>
        <${Icon} n="chev" s=${20} sw=${2} color="#6b6b6b" />
      </button>
      ${audOpen && html`<${AudienceSheet} value=${aud} onChange=${setAud} onClose=${function () { setAudOpen(false); }} />`}
      <div style=${{ padding: "1rem" }}><button className="btn block" style=${{ height: "3.1rem" }} onClick=${submit} disabled=${!!busy}>${busy || "Share with your Inner Circle"}</button></div>
    </div>`;
}

/* =====================  hello (with a short message)  ===================== */
const HELLO_PRESETS = ["Thinking of you", "Miss you!", "Call me when you can", "Just saying hi"];
function HelloSheet({ userId, onClose }) {
  const { me, profiles, toast, bump } = useApp();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const p = profiles[userId] || {};
  async function send(message) {
    setBusy(true);
    const r = await sb.from("hellos").insert({ from_id: me.id, to_id: userId, message: message });
    setBusy(false);
    if (r.error) { toast(r.error.message); return; }
    toast("Sent to " + nm(p));
    bump();
    onClose();
  }
  return html`<${Sheet} title=${"Say hello to " + nm(p)} onClose=${onClose}>
    ${HELLO_PRESETS.map(function (t) { return html`<button key=${t} className="sheetbtn" disabled=${busy} onClick=${function () { send(t); }}>${t}</button>`; })}
    <div className="row" style=${{ marginTop: ".6rem" }}>
      <label className="sr" htmlFor="hello-note">Write your own</label>
      <input id="hello-note" className="field" placeholder="Or write your own..." maxLength="140" value=${note} onChange=${function (e) { setNote(e.target.value); }} />
      <${EmojiBtn} onPick=${function (em) { setNote(function (t) { return (t + em).slice(0, 140); }); }} />
      <button className="btn" disabled=${busy || !note.trim()} onClick=${function () { send(note.trim()); }}>Send</button>
    </div>
  </${Sheet}>`;
}

/* =====================  invite someone (one-time link)  ===================== */
function InviteSheet({ onClose, existing }) {
  const { me, toast, bump } = useApp();
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      let code = existing && existing.code;
      let days = existing ? daysUntil(existing.expires_at) : 7;
      if (!code) {
        code = randomCode();
        const r = await sb.from("invites").insert({ code: code, label: label.trim(), created_by: me.id });
        if (r.error) throw r.error;
      }
      const res = await sendInviteText(code, me.display_name, days);
      if (res === "copied") toast("Invite copied. Paste it into a text or email.");
      bump();
      onClose();
    } catch (e) { toast((e && e.message) || "Could not create the invite."); }
    setBusy(false);
  }
  return html`<${Sheet} title="Invite someone you trust" onClose=${onClose}>
    <p className="muted" style=${{ marginTop: 0 }}>This makes a private link that works once and expires in 7 days. You will pick Text, Email or any app next.</p>
    ${!existing && html`<label htmlFor="inv-label" style=${{ fontWeight: 600 }}>Who is it for? (optional)</label>
      <input id="inv-label" className="field" style=${{ marginTop: ".3rem" }} placeholder="Example: Aunt Maria" maxLength="60" value=${label} onChange=${function (e) { setLabel(e.target.value); }} />`}
    <div className="row" style=${{ marginTop: ".9rem" }}><button className="btn grey grow" onClick=${onClose}>Cancel</button><button className="btn grow" disabled=${busy} onClick=${go}>${busy ? "One moment..." : existing ? "Share again" : "Create and send"}</button></div>
  </${Sheet}>`;
}

function NudgeSheet({ onClose }) {
  const { me, toast } = useApp();
  async function send() {
    const url = location.origin + location.pathname;
    const text = me.display_name + " just shared something new on Inner Circle.";
    try {
      if (navigator.share) await navigator.share({ title: "Inner Circle", text: text, url: url });
      else { await navigator.clipboard.writeText(text + " " + url); toast("Copied. Paste it into a text."); }
    } catch (e) { if (e && e.name === "AbortError") return; }
    onClose();
  }
  return html`<${Sheet} title="Shared! Tell the family?" onClose=${onClose}>
    <p className="muted" style=${{ marginTop: 0 }}>Family who have not turned on notifications will not know. A quick text helps everyone see it sooner. You will only be asked once a day.</p>
    <button className="btn block" style=${{ height: "3rem" }} onClick=${send}>Text the family a link</button>
    <button className="sheetbtn" style=${{ textAlign: "center", marginTop: ".4rem" }} onClick=${onClose}>Not now</button>
  </${Sheet}>`;
}

const ShareGlyph = html`<svg className="gl" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 15V3M8 7l4-4 4 4M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>`;
const AddGlyph = html`<svg className="gl" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/></svg>`;
function inAppBrowser() { return /FBAN|FBAV|Instagram|Line\/|MicroMessenger|Snapchat|Twitter|GSA\//i.test(navigator.userAgent || ""); }
function InstallSteps({ installable }) {
  const { toast } = useApp();
  async function copyLink() {
    const u = location.origin + location.pathname;
    try { await navigator.clipboard.writeText(u); toast("Link copied. Paste it into Safari."); } catch (e) { toast(u); }
  }
  if (installable) return html`<div><button className="btn" style=${{ marginTop: ".5rem" }} onClick=${runInstall}>Install app</button></div>`;
  if (isIOS()) return html`<div>
    ${inAppBrowser() && html`<div className="warnbox">You are inside another app. Tap the ••• or compass icon and choose <b>Open in Safari</b> first, or <button className="linkbtn" onClick=${copyLink}>copy the link</button> and paste it into Safari.</div>`}
    <ol className="steps">
      <li><span className="n">1</span><span>Open Inner Circle in <b>Safari</b>.</span></li>
      <li><span className="n">2</span><span>Tap the <b>Share</b> button ${ShareGlyph} at the bottom of the screen (at the top on an iPad).</span></li>
      <li><span className="n">3</span><span>Scroll down and tap <b>Add to Home Screen</b> ${AddGlyph}.</span></li>
      <li><span className="n">4</span><span>Tap <b>Add</b>. Then open Inner Circle from your home screen and sign in once more.</span></li>
    </ol></div>`;
  return html`<ol className="steps">
    <li><span className="n">1</span><span>Tap the <b>three dots</b> in the top corner of Chrome.</span></li>
    <li><span className="n">2</span><span>Tap <b>Install app</b> (or <b>Add to Home screen</b>).</span></li>
    <li><span className="n">3</span><span>Tap <b>Install</b>. The icon appears on your home screen.</span></li>
  </ol>`;
}

/* =====================  welcome (first time in)  ===================== */
function Welcome({ onDone }) {
  const { me, easy, setEasy, reloadMe, reloadProfiles, toast } = useApp();
  const installable = useInstallable();
  const [relation, setRelation] = useState(me.relation || "");
  const [i, setI] = useState(0);
  const [busy, setBusy] = useState(false);
  const standalone = isStandalone();
  const [steps] = useState(function () {   /* decided once, so the steps never change under the person */
    const askPush = pushCanWork() && !pushNeedsInstall() && Notification.permission === "default";
    return (me.relation ? [] : ["hi"]).concat(standalone ? [] : ["install"]).concat(askPush ? ["push"] : []).concat(["tips"]);
  });
  const step = steps[i];
  const first = (me.display_name || "friend").split(" ")[0];
  async function finish() {
    lsSet("ic-welcomed", "1");
    if (relation.trim() && relation.trim() !== (me.relation || "")) {
      await sb.from("profiles").update({ relation: relation.trim() }).eq("id", me.id);
      reloadMe(); reloadProfiles();
    }
    onDone();
  }
  function next() { setI(Math.min(i + 1, steps.length - 1)); }
  async function turnOnPush() {
    setBusy(true);
    try {
      const r = await pushEnable();
      if (r !== "granted") toast("No problem. You can turn it on later in Me, then the gear icon.");
    } catch (e) { toast("Could not turn it on. You can try later in Me, then the gear icon."); }
    lsSet("ic-push-ask", "1");
    setBusy(false);
    next();
  }
  const dots = html`<div className="wdots" aria-hidden="true">${steps.map(function (x, k) { return html`<i key=${x} className=${k === i ? "on" : k < i ? "done" : ""}></i>`; })}</div>`;
  return html`<${Sheet} title="" label="Welcome" onClose=${function () {}}>
    ${dots}
    ${step === "hi" && html`<div>
      <div className="wbig">Hi ${first}! 👋</div>
      <p className="wsub">This is your family's private space. Only people who were invited can see it.</p>
      <label htmlFor="w-rel" style=${{ fontWeight: 600 }}>Who are you to the family?</label>
      <input id="w-rel" className="field" style=${{ marginTop: ".3rem" }} placeholder="Example: Troy's son" maxLength="60" value=${relation} onChange=${function (e) { setRelation(e.target.value); }} />
      <div className="row" style=${{ marginTop: ".9rem", alignItems: "center" }}>
        <div className="grow muted">Bigger text</div>
        <button role="switch" aria-checked=${easy} aria-label="Bigger text" className=${"switch " + (easy ? "on" : "")} onClick=${function () { setEasy(!easy); }}><i></i></button>
      </div>
      <button className="btn block wbtn" onClick=${next}>Next</button>
    </div>`}
    ${step === "install" && html`<div>
      <div className="wbig">Put it on your home screen</div>
      <p className="wsub">Then it opens like any other app, and it can buzz you when someone posts.</p>
      <${InstallSteps} installable=${installable} />
      <button className="btn block wbtn" onClick=${next}>${installable ? "Next" : "I did it"}</button>
      <button className="linkbtn wskip" onClick=${next}>Skip for now</button>
    </div>`}
    ${step === "push" && html`<div>
      <div className="wbig">Get a buzz 🔔</div>
      <p className="wsub">We will tell you when family shares a photo, comments, or says hello. Nothing else, ever.</p>
      <button className="btn block wbtn" disabled=${busy} onClick=${turnOnPush}>Yes, buzz me</button>
      <button className="linkbtn wskip" onClick=${function () { lsSet("ic-push-ask", "1"); next(); }}>Not now</button>
    </div>`}
    ${step === "tips" && html`<div>
      <div className="wbig">You are in! 🎉</div>
      <ul className="tips">
        <li><span>➕</span><span>Tap <b>Share</b> at the bottom to post a photo or video.</span></li>
        <li><span>❤️</span><span>Double-tap a photo to love it.</span></li>
        <li><span>👋</span><span>Tap <b>People</b> to say hello to family.</span></li>
      </ul>
      <button className="btn block wbtn" onClick=${finish}>Start</button>
    </div>`}
  </${Sheet}>`;
}

/* =====================  get to know me (favorites, loves, duels)  ===================== */
const FAVS = [
  { k: "color", e: "🎨", l: "Favorite color", ph: "Forest green" },
  { k: "food", e: "🍽️", l: "Favorite meal", ph: "Grandma's lasagna" },
  { k: "dessert", e: "🍰", l: "Sweet tooth pick", ph: "Peach cobbler" },
  { k: "drink", e: "☕", l: "Go-to drink", ph: "Black coffee" },
  { k: "movie", e: "🎬", l: "Favorite movie", ph: "It's a Wonderful Life" },
  { k: "music", e: "🎵", l: "Music I love", ph: "Motown and classic rock" },
  { k: "book", e: "📚", l: "Favorite book", ph: "Anything by Grisham" },
  { k: "place", e: "✈️", l: "Dream trip", ph: "Italy in the fall" },
  { k: "hobby", e: "🎣", l: "Favorite pastime", ph: "Fishing at sunrise" },
  { k: "gift", e: "🎁", l: "A gift I would love", ph: "A handwritten letter", wide: true },
  { k: "fun", e: "✨", l: "Something you may not know about me", ph: "I once met a president", wide: true }
];
const LOVES = ["Sunday dinners", "Road trips", "The beach", "Mountains", "Gardening", "Board games", "Football", "Baking", "Live music", "Old movies", "Coffee", "Camping", "Reading", "Dogs", "Cats", "Fishing", "Cooking", "History", "Crafts", "Dancing", "Holidays", "Family stories"];
const NOTS = ["Crowds", "Spicy food", "Early mornings", "Horror movies", "Cilantro", "Traffic", "Loud restaurants", "Flying", "Cold weather", "Small talk", "Mushrooms", "Running late", "Surprises", "Phone calls"];
const DUELS = [
  ["coffee", "Coffee", "Tea"], ["place", "Beach", "Mountains"], ["taste", "Sweet", "Salty"], ["clock", "Early bird", "Night owl"],
  ["talk", "Call me", "Text me"], ["pet", "Dogs", "Cats"], ["style", "Homebody", "Adventurer"], ["season", "Summer", "Winter"]
];
function getPrefs(p) {
  const x = (p && p.prefs) || {};
  return { fav: x.fav || {}, loves: x.loves || [], nots: x.nots || [], duel: x.duel || {} };
}
function prefsProgress(p) {
  const x = getPrefs(p);
  const done = FAVS.filter(function (f) { return (x.fav[f.k] || "").trim(); }).length + (x.loves.length ? 1 : 0) + (x.nots.length ? 1 : 0) + DUELS.filter(function (d) { return x.duel[d[0]]; }).length;
  return { done: done, total: FAVS.length + 2 + DUELS.length };
}
function norm(t) { return String(t || "").trim().toLowerCase(); }
function isColor(v) { try { return !!(window.CSS && CSS.supports && CSS.supports("color", String(v).trim().toLowerCase())); } catch (e) { return false; } }

function Chips({ options, picked, onToggle, onAdd, max, tone }) {
  const [custom, setCustom] = useState("");
  const all = options.concat(picked.filter(function (x) { return options.indexOf(x) < 0; }));
  function add(e) {
    e.preventDefault();
    const v = custom.trim();
    if (!v) return;
    if (picked.length >= max && picked.indexOf(v) < 0) return;
    if (picked.map(norm).indexOf(norm(v)) < 0) onAdd(v);
    setCustom("");
  }
  return html`<div>
    <div className="chips">${all.map(function (o) {
      const on = picked.indexOf(o) >= 0;
      return html`<button type="button" key=${o} className=${"chip " + tone + (on ? " on" : "")} aria-pressed=${on} onClick=${function () { onToggle(o); }}>${o}</button>`;
    })}</div>
    <form className="row" style=${{ marginTop: ".6rem" }} onSubmit=${add}>
      <label className="sr" htmlFor=${"chip-" + tone}>Add your own</label>
      <input id=${"chip-" + tone} className="field" style=${{ height: "2.75rem" }} placeholder="Add your own..." maxLength="30" value=${custom} onChange=${function (e) { setCustom(e.target.value); }} />
      <button className="btn grey" disabled=${!custom.trim()}>Add</button>
    </form></div>`;
}

function PrefsEditor() {
  const { me, toast, back, reloadMe, reloadProfiles } = useApp();
  const init = getPrefs(me);
  const [fav, setFav] = useState(init.fav);
  const [loves, setLoves] = useState(init.loves);
  const [nots, setNots] = useState(init.nots);
  const [duel, setDuel] = useState(init.duel);
  const [busy, setBusy] = useState(false);
  const pr = prefsProgress({ prefs: { fav: fav, loves: loves, nots: nots, duel: duel } });
  const tog = function (list, set) { return function (o) { set(list.indexOf(o) >= 0 ? list.filter(function (x) { return x !== o; }) : list.concat([o])); }; };
  async function save() {
    setBusy(true);
    const clean = {};
    Object.keys(fav).forEach(function (k) { const v = (fav[k] || "").trim(); if (v) clean[k] = v; });
    const r = await sb.from("profiles").update({ prefs: { fav: clean, loves: loves, nots: nots, duel: duel } }).eq("id", me.id);
    setBusy(false);
    if (r.error) { toast(r.error.message); return; }
    toast("Saved. Your family can get to know you better.");
    await reloadMe();
    reloadProfiles();
    back();
  }
  return html`<div>
    <${TopBar} title="Get to know me" back=${back} right=${html`<button className="tbtn" onClick=${save} disabled=${busy}>${busy ? "..." : "Save"}</button>`} />
    <div style=${{ padding: "1rem 1rem 0" }}>
      <div style=${{ fontWeight: 600 }}>${pr.done} of ${pr.total} answered</div>
      <div className="meter" style=${{ marginTop: ".4rem" }}><i style=${{ width: Math.round(pr.done * 100 / pr.total) + "%" }}></i></div>
      <p className="muted" style=${{ fontSize: ".85rem" }}>Skip anything you like. Little things help family pick gifts, plan dinners and start conversations.</p>
    </div>

    <h2 className="serif sec" style=${{ margin: ".6rem 1rem .5rem" }}>My favorites</h2>
    <div style=${{ padding: "0 1rem" }}>${FAVS.map(function (f) {
      return html`<div key=${f.k} style=${{ marginBottom: ".8rem" }}>
        <label htmlFor=${"fv-" + f.k} style=${{ fontWeight: 600, fontSize: ".9rem" }}><span aria-hidden="true">${f.e} </span>${f.l}</label>
        <input id=${"fv-" + f.k} className="field" style=${{ marginTop: ".25rem" }} maxLength="80" placeholder=${"Example: " + f.ph} value=${fav[f.k] || ""}
          onChange=${function (e) { const v = e.target.value; setFav(function (o) { return Object.assign({}, o, { [f.k]: v }); }); }} /></div>`;
    })}</div>

    <h2 className="serif sec" style=${{ margin: "1rem 1rem .5rem" }}>Things I love</h2>
    <div style=${{ padding: "0 1rem" }}><${Chips} options=${LOVES} picked=${loves} max=${14} tone="love" onToggle=${tog(loves, setLoves)} onAdd=${function (v) { setLoves(loves.concat([v])); }} /></div>

    <h2 className="serif sec" style=${{ margin: "1.4rem 1rem .5rem" }}>Not so much</h2>
    <div style=${{ padding: "0 1rem" }}><${Chips} options=${NOTS} picked=${nots} max=${14} tone="not" onToggle=${tog(nots, setNots)} onAdd=${function (v) { setNots(nots.concat([v])); }} /></div>

    <h2 className="serif sec" style=${{ margin: "1.4rem 1rem .5rem" }}>This or that</h2>
    <div style=${{ padding: "0 1rem" }}>${DUELS.map(function (d) {
      const pick = function (side) { setDuel(function (o) { const n = Object.assign({}, o); if (n[d[0]] === side) delete n[d[0]]; else n[d[0]] = side; return n; }); };
      return html`<div className="duel" key=${d[0]}>
        <button type="button" className=${duel[d[0]] === "a" ? "on" : ""} aria-pressed=${duel[d[0]] === "a"} onClick=${function () { pick("a"); }}>${d[1]}</button>
        <span aria-hidden="true">or</span>
        <button type="button" className=${duel[d[0]] === "b" ? "on" : ""} aria-pressed=${duel[d[0]] === "b"} onClick=${function () { pick("b"); }}>${d[2]}</button></div>`;
    })}</div>
    <div style=${{ padding: "1.2rem 1rem 2rem" }}><button className="btn block" style=${{ height: "3.1rem" }} onClick=${save} disabled=${busy}>Save</button></div>
  </div>`;
}

function KnowMe({ p, mine }) {
  const { me, push } = useApp();
  const x = getPrefs(p);
  const pr = prefsProgress(p);
  const favs = FAVS.filter(function (f) { return (x.fav[f.k] || "").trim(); });
  const duels = DUELS.filter(function (d) { return x.duel[d[0]]; });
  const nothing = pr.done === 0;
  if (nothing && !mine) return null;

  let common = [];
  if (!mine) {
    const m = getPrefs(me);
    const sl = x.loves.filter(function (v) { return m.loves.map(norm).indexOf(norm(v)) >= 0; });
    const sn = x.nots.filter(function (v) { return m.nots.map(norm).indexOf(norm(v)) >= 0; });
    const sd = duels.filter(function (d) { return m.duel[d[0]] === x.duel[d[0]]; }).map(function (d) { return x.duel[d[0]] === "a" ? d[1] : d[2]; });
    const sf = favs.filter(function (f) { return norm((m.fav || {})[f.k]) === norm(x.fav[f.k]); }).map(function (f) { return f.l.toLowerCase() + ": " + x.fav[f.k]; });
    if (sl.length) common.push("You both love " + sl.join(", "));
    if (sn.length) common.push("Neither of you likes " + sn.join(", "));
    if (sd.length) common.push("You both pick " + sd.join(", "));
    if (sf.length) common.push("Same " + sf.join(" and same "));
  }
  if (nothing && mine) {
    return html`<div className="knowcard">
      <div style=${{ fontWeight: 700, fontSize: "1.05rem" }}>Help your family get to know you</div>
      <div className="muted" style=${{ margin: ".2rem 0 .8rem", fontSize: ".9rem" }}>Favorite color, food, movies, music, places. It takes two minutes and makes gift giving much easier.</div>
      <button className="btn" onClick=${function () { push({ name: "prefs" }); }}>Get started</button></div>`;
  }
  return html`<div style=${{ padding: "0 1rem 1rem" }}>
    ${mine && html`<div className="knowcard" style=${{ margin: "0 0 1rem" }}>
      <div className="row"><div className="grow"><div style=${{ fontWeight: 700 }}>${pr.done} of ${pr.total} answered</div>
        <div className="meter" style=${{ marginTop: ".4rem" }}><i style=${{ width: Math.round(pr.done * 100 / pr.total) + "%" }}></i></div></div>
        <button className="btn sm" onClick=${function () { push({ name: "prefs" }); }}>${pr.done < pr.total ? "Add more" : "Edit"}</button></div></div>`}
    ${common.length > 0 && html`<div className="common"><b>In common with you</b>${common.map(function (c) { return html`<div key=${c}>${c}</div>`; })}</div>`}
    ${favs.length > 0 && html`<h3 className="serif sec" style=${{ margin: ".6rem 0 .5rem", fontSize: "1.1rem" }}>Favorites</h3>
      <div className="tiles">${favs.map(function (f) {
        const v = x.fav[f.k];
        return html`<div key=${f.k} className=${"tile" + (f.wide ? " wide" : "")}>
          <div className="tl"><span aria-hidden="true">${f.e} </span>${f.l}</div>
          <div className="tv">${f.k === "color" && isColor(v) && html`<i className="swatch" style=${{ background: v.trim().toLowerCase() }}></i>`}${v}</div></div>`;
      })}</div>`}
    ${x.loves.length > 0 && html`<h3 className="serif sec" style=${{ margin: "1.1rem 0 .5rem", fontSize: "1.1rem" }}>Loves</h3>
      <div className="chips">${x.loves.map(function (v) { return html`<span key=${v} className="chip love on">${v}</span>`; })}</div>`}
    ${x.nots.length > 0 && html`<h3 className="serif sec" style=${{ margin: "1.1rem 0 .5rem", fontSize: "1.1rem" }}>Not so much</h3>
      <div className="chips">${x.nots.map(function (v) { return html`<span key=${v} className="chip not on">${v}</span>`; })}</div>`}
    ${duels.length > 0 && html`<h3 className="serif sec" style=${{ margin: "1.1rem 0 .5rem", fontSize: "1.1rem" }}>This or that</h3>
      <div className="chips">${duels.map(function (d) { return html`<span key=${d[0]} className="chip pick on">${x.duel[d[0]] === "a" ? d[1] : d[2]}<small> over ${x.duel[d[0]] === "a" ? d[2] : d[1]}</small></span>`; })}</div>`}
  </div>`;
}

/* =====================  profile  ===================== */
function Profile({ userId, root }) {
  const { me, profiles, push, back, tick, easy, setEasy, openHello } = useApp();
  const [posts, setPosts] = useState(null);
  const [err, setErr] = useState(false);
  const [theirPrefs, setTheirPrefs] = useState(null);
  const mine = userId === me.id;
  useEffect(function () {
    if (mine) return;
    let live = true;
    sb.from("profiles").select("prefs").eq("id", userId).maybeSingle().then(function (r) { if (live) setTheirPrefs((r.data && r.data.prefs) || {}); }).catch(function () {});
    return function () { live = false; };
  }, [userId, tick]);
  const p = Object.assign({}, profiles[userId] || {}, { prefs: mine ? me.prefs : theirPrefs });
  const urls = useUrls((posts || []).map(function (x) { return x.image_path; }));

  const load = useCallback(async function () {
    const r = await sb.from("posts").select("id,caption,image_path,extra_paths,video_path,created_at").eq("author_id", userId).order("created_at", { ascending: false }).limit(90);
    if (r.error) { setErr(true); return; }
    setErr(false);
    setPosts(r.data || []);
  }, [userId]);
  useEffect(function () { load(); }, [load, tick]);

  const since = p.created_at ? new Date(p.created_at).toLocaleDateString(undefined, { month: "short", year: "numeric" }) : "";
  const gear = mine ? html`<div className="row" style=${{ gap: 0 }}>
    <button className="ibtn aa2" aria-label=${easy ? "Switch to standard text" : "Switch to larger text"} aria-pressed=${easy} onClick=${function () { setEasy(!easy); }}>Aa</button>
    <button className="ibtn" aria-label="Settings" onClick=${function () { push({ name: "settings" }); }}><${Icon} n="gear" s=${24} /></button></div>` : null;
  const n = posts ? posts.length : 0;
  return html`
    <div>
      ${root
        ? html`<div className="top"><div className="brand" style=${{ fontSize: "1.3rem" }}>${nm(p)}</div>${gear}</div>`
        : html`<${TopBar} title=${nm(p)} back=${back} />`}
      <div className="row" style=${{ padding: ".6rem 1.1rem", gap: "1.4rem" }}>
        <div className="ring" style=${{ width: "5.5rem", height: "5.5rem", flex: "none", margin: 0, borderColor: "var(--amber)" }}><${Avatar} id=${userId} name=${p.display_name} size=${72} /></div>
        <div className="row" style=${{ flex: 1, justifyContent: "space-around" }}>
          <div className="stat"><b>${posts ? n : "-"}</b><span>${n === 1 ? "moment" : "moments"}</span></div>
          <div className="stat"><b>${since}</b><span>here since</span></div>
        </div>
      </div>
      <div style=${{ padding: "0 1.1rem .8rem", fontSize: ".9rem" }}>
        <div style=${{ fontWeight: 600 }}>${nm(p)}</div>
        ${p.relation && html`<div className="muted">${p.relation}</div>`}
        ${p.bio ? html`<div style=${{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}><${Linkify} text=${p.bio} /></div>` : mine ? html`<div className="muted">Add a few words about yourself in Edit profile.</div>` : null}
      </div>
      <div className="row" style=${{ padding: "0 1.1rem 1rem" }}>
        ${mine
          ? html`<button className="btn grey grow" onClick=${function () { push({ name: "settings" }); }}>Edit profile</button>`
          : html`<button className="btn grow" onClick=${function () { openHello(userId); }}>Say hello</button>`}
      </div>
      <${KnowMe} p=${p} mine=${mine} />
      <div className="tabline"><div className="on"><${Icon} n="grid" s=${24} sw=${2} /></div></div>
      ${err && !posts && html`<${Failed} what="their moments" onRetry=${load} />`}
      ${posts && posts.length === 0 && html`<div className="center muted" style=${{ padding: "2.5rem 1rem" }}>${mine ? "Share your first moment with your Inner Circle." : "Nothing shared yet."}</div>`}
      <div className="grid">
        ${(posts || []).map(function (x) {
          const u = urls(x.image_path);
          return html`<button className="cell" key=${x.id} aria-label="Open post" onClick=${function () { push({ name: "post", id: x.id }); }}>
            ${x.image_path ? (u ? html`<img src=${u} alt="" loading="lazy" />` : null) : html`<div className="t">${x.caption}</div>`}
            ${x.video_path && html`<span className="multi"><${Icon} n="play" s=${18} fill="#fff" sw=${0} color="#fff" /></span>`}
            ${!x.video_path && (x.extra_paths || []).length > 0 && html`<span className="multi"><${Icon} n="stack" s=${16} sw=${2} color="#fff" /></span>`}
          </button>`;
        })}
      </div>
    </div>`;
}

function SinglePost({ id }) {
  const { toast, back, tick } = useApp();
  const [post, setPost] = useState(undefined);
  const [err, setErr] = useState(false);
  const load = useCallback(async function () {
    const r = await sb.from("posts").select("*, comments(id), hearts(user_id)").eq("id", id).maybeSingle();
    if (r.error) { setErr(true); return; }
    setErr(false);
    setPost(r.data || null);
  }, [id]);
  useEffect(function () { load(); }, [load, tick]);
  return html`<div><${TopBar} title="Post" back=${back} />
    ${err && post === undefined ? html`<${Failed} what="this post" onRetry=${load} />` : post === undefined ? html`<div className="center muted" style=${{ padding: "3rem" }}>Loading...</div>` : post === null ? html`<div className="center muted" style=${{ padding: "3rem" }}>This post is no longer here.</div>` : html`<${PostCard} post=${post} onChange=${load} />`}</div>`;
}

/* =====================  people  ===================== */
/* =====================  celebrations (birthdays, anniversaries) and events  ===================== */
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_S = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DIM = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
function isLeapY(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
function todayStart() { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
function occurrence(m, d) {   /* next time this month and day comes around (a Feb 29 is kept on Feb 28 in other years) */
  const t0 = todayStart();
  for (let y = t0.getFullYear(); y <= t0.getFullYear() + 8; y++) {
    const dd = (m === 2 && d === 29 && !isLeapY(y)) ? 28 : d;
    const dt = new Date(y, m - 1, dd);
    if (dt >= t0) return dt;
  }
  return new Date(t0.getFullYear() + 1, m - 1, d);
}
function daysAway(dt) { return Math.round((new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()) - todayStart()) / 86400000); }
function awayLabel(n) { return n <= 0 ? "Today" : n === 1 ? "Tomorrow" : "in " + n + " days"; }
function buildCelebrations(profiles, anniv) {
  const list = [];
  Object.keys(profiles).forEach(function (id) {
    const p = profiles[id];
    if (!p || p.status !== "approved" || !p.birth_month) return;
    const dt = occurrence(p.birth_month, p.birth_day);
    list.push({ kind: "birthday", key: id, title: nm(p) + "'s birthday", name: nm(p), m: p.birth_month, d: p.birth_day, dt: dt, days: daysAway(dt), year: dt.getFullYear() });
  });
  (anniv || []).forEach(function (a) {
    const dt = occurrence(a.month, a.day);
    list.push({ kind: "anniversary", key: a.id, title: a.title, name: a.title, m: a.month, d: a.day, dt: dt, days: daysAway(dt), year: dt.getFullYear(), years: a.year ? dt.getFullYear() - a.year : 0, anniv: a });
  });
  return list.sort(function (x, y) { return x.days - y.days || String(x.name).localeCompare(String(y.name)); });
}
function fmtMD(m, d) { return MONTHS[m - 1] + " " + d; }

function MonthDay({ m, d, onM, onD, idp }) {
  const max = m ? DIM[m - 1] : 31;
  return html`<div className="row" style=${{ gap: ".5rem" }}>
    <label className="sr" htmlFor=${idp + "-m"}>Month</label>
    <select id=${idp + "-m"} className="field" value=${m || ""} onChange=${function (e) { onM(e.target.value ? +e.target.value : 0); }}>
      <option value="">Month</option>${MONTHS.map(function (n, i) { return html`<option key=${n} value=${i + 1}>${n}</option>`; })}
    </select>
    <label className="sr" htmlFor=${idp + "-d"}>Day</label>
    <select id=${idp + "-d"} className="field" style=${{ maxWidth: "6rem" }} value=${d || ""} onChange=${function (e) { onD(e.target.value ? +e.target.value : 0); }}>
      <option value="">Day</option>${Array.from({ length: max }, function (_, i) { return html`<option key=${i} value=${i + 1}>${i + 1}</option>`; })}
    </select>
  </div>`;
}

function AnnivForm({ item, onClose, onSaved }) {
  const { me, toast } = useApp();
  const [title, setTitle] = useState(item ? item.title : "");
  const [m, setM] = useState(item ? item.month : 0);
  const [d, setD] = useState(item ? item.day : 0);
  const [yr, setYr] = useState(item && item.year ? String(item.year) : "");
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!title.trim()) { toast("Who is celebrating? Type the names."); return; }
    if (!m || !d) { toast("Pick the month and the day."); return; }
    const y = yr.trim() ? parseInt(yr, 10) : null;
    if (y !== null && (!(y >= 1900 && y <= 2100))) { toast("Type a four-digit year, or leave it blank."); return; }
    setBusy(true);
    const row = { title: title.trim(), month: m, day: Math.min(d, DIM[m - 1]), year: y };
    const r = item ? await sb.from("anniversaries").update(row).eq("id", item.id) : await sb.from("anniversaries").insert(Object.assign({ created_by: me.id }, row));
    setBusy(false);
    if (r.error) { toast(r.error.message); return; }
    toast(item ? "Saved" : "Anniversary added");
    onSaved();
  }
  async function del() {
    if (!confirm("Delete this anniversary?")) return;
    const r = await sb.from("anniversaries").delete().eq("id", item.id);
    if (r.error) { toast(r.error.message); return; }
    toast("Deleted"); onSaved();
  }
  return html`<${Sheet} title=${item ? "Edit anniversary" : "Add an anniversary"} onClose=${onClose}>
    <label htmlFor="an-t" className="flabel">Who is celebrating?</label>
    <input id="an-t" className="field" maxLength="80" placeholder="Example: Aunt Maria and Uncle Dev" value=${title} onChange=${function (e) { setTitle(e.target.value); }} />
    <div className="flabel">Date</div>
    <${MonthDay} idp="an" m=${m} d=${d} onM=${setM} onD=${setD} />
    <label htmlFor="an-y" className="flabel">Year they married (optional, shows how many years)</label>
    <input id="an-y" className="field" inputMode="numeric" maxLength="4" placeholder="Example: 1999" value=${yr} onChange=${function (e) { setYr(e.target.value.replace(/[^0-9]/g, "")); }} />
    <div className="row" style=${{ marginTop: "1rem" }}>
      ${item && html`<button className="btn danger" onClick=${del}>Delete</button>`}
      <button className="btn grey grow" onClick=${onClose}>Cancel</button>
      <button className="btn grow" disabled=${busy} onClick=${save}>${busy ? "Saving..." : "Save"}</button>
    </div>
  </${Sheet}>`;
}

function BirthdayForSheet({ onClose, onSaved }) {
  const { profiles, toast } = useApp();
  const people = Object.keys(profiles).map(function (k) { return profiles[k]; }).filter(function (p) { return p.status === "approved" && !p.birth_month; })
    .sort(function (a, b) { return nm(a).localeCompare(nm(b)); });
  const [who, setWho] = useState(people[0] ? people[0].id : "");
  const [m, setM] = useState(0);
  const [d, setD] = useState(0);
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!who || !m || !d) { toast("Pick a person, a month and a day."); return; }
    setBusy(true);
    const r = await sb.rpc("set_birthday", { target: who, m: m, d: Math.min(d, DIM[m - 1]) });
    setBusy(false);
    if (r.error) { toast(r.error.message); return; }
    toast("Birthday saved"); onSaved();
  }
  return html`<${Sheet} title="Add someone's birthday" onClose=${onClose}>
    ${people.length === 0 ? html`<p className="muted">Everyone already has a birthday saved.</p>` : html`
      <label htmlFor="bf-who" className="flabel">Who</label>
      <select id="bf-who" className="field" value=${who} onChange=${function (e) { setWho(e.target.value); }}>${people.map(function (p) { return html`<option key=${p.id} value=${p.id}>${nm(p)}</option>`; })}</select>
      <div className="flabel">Birthday (no year needed)</div>
      <${MonthDay} idp="bf" m=${m} d=${d} onM=${setM} onD=${setD} />
      <div className="row" style=${{ marginTop: "1rem" }}><button className="btn grey grow" onClick=${onClose}>Cancel</button><button className="btn grow" disabled=${busy} onClick=${save}>${busy ? "Saving..." : "Save"}</button></div>`}
  </${Sheet}>`;
}

function WishSheet({ c, onClose, onEdit }) {
  const { me, profiles, toast } = useApp();
  const [wishes, setWishes] = useState(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const loaded = useRef(false);
  const load = useCallback(async function () {
    const r = await sb.from("wishes").select("*").eq("kind", c.kind).eq("subject", c.key).eq("year", c.year).order("created_at");
    const rows = r.data || [];
    setWishes(rows);
    if (!loaded.current) {
      loaded.current = true;
      const mine = rows.find(function (w) { return w.author_id === me.id; });
      if (mine) setText(mine.body);
    }
  }, [c.kind, c.key, c.year, me.id]);
  useEffect(function () { load(); }, [load]);
  const mine = (wishes || []).find(function (w) { return w.author_id === me.id; });
  const quick = c.kind === "birthday" ? ["Happy birthday! 🎉", "Love you! ❤️", "Have the best day!"] : ["Happy anniversary! 💍", "So happy for you both ❤️", "Cheers to many more!"];
  async function send() {
    const body = text.trim();
    if (!body) return;
    setBusy(true);
    const r = await sb.from("wishes").upsert({ kind: c.kind, subject: c.key, year: c.year, author_id: me.id, body: body }, { onConflict: "kind,subject,year,author_id" });
    setBusy(false);
    if (r.error) { toast(r.error.message); return; }
    toast(mine ? "Wish updated" : "Wish sent");
    load();
  }
  async function removeMine() {
    if (!mine) return;
    await sb.from("wishes").delete().eq("id", mine.id);
    setText(""); load();
  }
  const canEdit = c.kind === "anniversary" && c.anniv && (c.anniv.created_by === me.id || me.role === "admin");
  const isMe = c.kind === "birthday" && c.key === me.id;
  return html`<${Sheet} title=${(c.kind === "birthday" ? "🎂 " : "💍 ") + c.title} onClose=${onClose}>
    <div className="muted" style=${{ marginTop: "-.3rem", marginBottom: ".8rem" }}>${fmtMD(c.m, c.d)} · ${awayLabel(c.days)}${c.years > 0 ? " · " + c.years + (c.years === 1 ? " year" : " years") : ""}</div>
    ${wishes === null ? html`<div className="muted center" style=${{ padding: "1rem" }}>Loading...</div>`
      : wishes.length === 0 ? html`<div className="muted" style=${{ padding: ".2rem 0 .8rem" }}>${isMe ? "Wishes from your family will show up here." : "No wishes yet. Be the first."}</div>`
      : html`<div className="wishes">${wishes.map(function (w) {
          return html`<div className="wish" key=${w.id}><${Avatar} id=${w.author_id} name=${nm(profiles[w.author_id])} size=${32} /><div><b style=${{ fontWeight: 600 }}>${nm(profiles[w.author_id])}</b><div style=${{ overflowWrap: "anywhere" }}><${Linkify} text=${w.body} /></div></div></div>`;
        })}</div>`}
    ${!isMe && html`<div>
      <div className="qr small" style=${{ padding: ".2rem 0 .5rem", justifyContent: "flex-start" }}>${quick.map(function (q) { return html`<button key=${q} className="chip" onClick=${function () { setText(q); }}>${q}</button>`; })}</div>
      <label className="sr" htmlFor="wish-in">Your wish</label>
      <textarea id="wish-in" className="field" rows="3" maxLength="300" placeholder="Write a few kind words..." value=${text} onChange=${function (e) { setText(e.target.value); }}></textarea>
      <div className="row" style=${{ marginTop: ".6rem" }}><${EmojiBtn} onPick=${function (em) { setText(function (t) { return (t + em).slice(0, 300); }); }} />
        ${mine && html`<button className="btn grey" onClick=${removeMine}>Remove</button>`}
        <button className="btn grow" disabled=${busy || !text.trim()} onClick=${send}>${busy ? "Sending..." : mine ? "Update my wish" : "Send wish"}</button>
      </div></div>`}
    ${canEdit && html`<div style=${{ textAlign: "center", marginTop: ".6rem" }}><button className="linkbtn" onClick=${function () { onEdit(c.anniv); }}>Edit or delete this anniversary</button></div>`}
  </${Sheet}>`;
}

function useAnniversaries() {
  const { tick } = useApp();
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(false);
  const load = useCallback(function () {
    return sb.from("anniversaries").select("*").then(function (r) { if (r.error) { setErr(true); return; } setErr(false); setRows(r.data || []); }).catch(function () { setErr(true); });
  }, []);
  useEffect(function () { load(); }, [load, tick]);
  return { rows: rows, err: err, reload: load };
}

function Celebrations() {
  const { me, profiles, back, push, bump } = useApp();
  const an = useAnniversaries();
  const [card, setCard] = useState(null);
  const [form, setForm] = useState(null);
  const [bf, setBf] = useState(false);
  const list = buildCelebrations(profiles, an.rows || []);
  const today = list.filter(function (c) { return c.days === 0; });
  const soon = list.filter(function (c) { return c.days > 0; });
  const missing = Object.keys(profiles).map(function (k) { return profiles[k]; }).filter(function (p) { return p.status === "approved" && !p.birth_month; });
  const iMissing = !(profiles[me.id] && profiles[me.id].birth_month);
  function lead(c) {
    return c.kind === "birthday" ? html`<${Avatar} id=${c.key} name=${c.name} size=${46} />` : html`<span className="emo">💍</span>`;
  }
  function row(c) {
    return html`<button className="listrow" key=${c.kind + c.key} onClick=${function () { setCard(c); }}>
      ${lead(c)}
      <div className="grow" style=${{ minWidth: 0, textAlign: "left" }}>
        <div style=${{ fontWeight: 600 }}>${c.title}</div>
        <div className="muted" style=${{ fontSize: ".85rem" }}>${fmtMD(c.m, c.d)}${c.years > 0 ? " · " + c.years + (c.years === 1 ? " year" : " years") : ""}</div>
      </div>
      <div className=${"away" + (c.days <= 7 ? " near" : "")}>${awayLabel(c.days)}</div>
    </button>`;
  }
  if (an.err && !an.rows) return html`<div><${TopBar} title="Special days" back=${back} /><${Failed} what="special days" onRetry=${an.reload} /></div>`;
  return html`<div>
    <${TopBar} title="Special days" back=${back} right=${html`<button className="tbtn" onClick=${function () { setForm({}); }}>Add</button>`} />
    ${!an.rows && html`<div className="center muted" style=${{ padding: "3rem 1rem" }}>Loading...</div>`}
    ${an.rows && today.length > 0 && html`<div className="todaybox">${today.map(function (c) {
      return html`<div className="todaycard" key=${c.kind + c.key}>
        <div className="big">${c.kind === "birthday" ? "🎂" : "💍"}</div>
        <div className="grow"><div style=${{ fontWeight: 700, fontSize: "1.05rem" }}>${c.kind === "birthday" ? (c.key === me.id ? "Happy birthday, " + String(c.name).split(" ")[0] + "!" : c.title + " today") : c.title + (c.years > 0 ? " · " + c.years + " years" : "")}</div></div>
        <button className="btn sm" onClick=${function () { setCard(c); }}>${c.key === me.id ? "See wishes" : "Send a wish"}</button>
      </div>`;
    })}</div>`}
    ${an.rows && soon.length > 0 && html`<div className="hdr">Coming up</div>`}
    ${an.rows && soon.map(row)}
    ${an.rows && list.length === 0 && html`<div className="center muted" style=${{ padding: "2.5rem 1.5rem" }}>No special days yet. Add your birthday in Edit profile, and add anniversaries with the Add button.</div>`}
    ${an.rows && html`<div style=${{ padding: "1rem" }}>
      ${iMissing && html`<button className="btn block" style=${{ marginBottom: ".6rem" }} onClick=${function () { push({ name: "settings" }); }}>Add my birthday</button>`}
      <button className="btn grey block" onClick=${function () { setForm({}); }}>Add an anniversary</button>
      ${(me.role === "admin" || missing.length > 0) && missing.length > 0 && html`<div style=${{ marginTop: ".9rem", textAlign: "center" }}>
        <div className="muted" style=${{ fontSize: ".85rem" }}>${missing.length} ${missing.length === 1 ? "person has" : "people have"} not added a birthday yet.</div>
        ${me.role === "admin" && html`<button className="linkbtn" onClick=${function () { setBf(true); }}>Add a birthday for someone</button>`}
      </div>`}
    </div>`}
    ${card && html`<${WishSheet} c=${card} onClose=${function () { setCard(null); }} onEdit=${function (a) { setCard(null); setForm(a); }} />`}
    ${form && html`<${AnnivForm} item=${form.id ? form : null} onClose=${function () { setForm(null); }} onSaved=${function () { setForm(null); an.reload(); bump(); }} />`}
    ${bf && html`<${BirthdayForSheet} onClose=${function () { setBf(false); }} onSaved=${function () { setBf(false); bump(); }} />`}
  </div>`;
}

/* ---- Events ---- */
function fmtEvDate(iso) { return new Date(iso).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }); }
function fmtEvTime(iso) { return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
function evState(ev) {
  const s = new Date(ev.starts_at).getTime();
  const e = ev.ends_at ? new Date(ev.ends_at).getTime() : s + 3 * 3600000;
  const now = Date.now();
  if (now > e) return { past: true, label: "Ended" };
  if (now >= s) return { past: false, label: "Happening now", live: true };
  return { past: false, label: awayLabel(daysAway(new Date(ev.starts_at))) };
}
function icsFor(ev) {
  const z = function (iso) { return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); };
  const esc = function (t) { return String(t || "").replace(/\r/g, "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;"); };
  const end = ev.ends_at || new Date(new Date(ev.starts_at).getTime() + 2 * 3600000).toISOString();
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Inner Circle//EN", "BEGIN:VEVENT", "UID:" + ev.id + "@innercircle", "DTSTAMP:" + z(new Date().toISOString()),
    "DTSTART:" + z(ev.starts_at), "DTEND:" + z(end), "SUMMARY:" + esc(ev.title), "LOCATION:" + esc([ev.place, ev.address].filter(Boolean).join(", ")), "DESCRIPTION:" + esc(ev.details), "END:VEVENT", "END:VCALENDAR"].join("\r\n");
}
async function addToCalendar(ev, toast) {
  const file = new File([icsFor(ev)], "inner-circle-event.ics", { type: "text/calendar" });
  try { if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: ev.title }); return; } }
  catch (e) { if (e && e.name === "AbortError") return; }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file); a.download = "inner-circle-event.ics";
  document.body.appendChild(a); a.click(); a.remove();
  toast("Calendar file saved. Open it to add the event.");
}
async function shareEvent(ev, toast) {
  const link = location.origin + location.pathname + "?event=" + encodeURIComponent(ev.id);
  const text = ev.title + " on " + fmtEvDate(ev.starts_at) + ". Open in Inner Circle (family only, you will be asked to sign in):";
  if (navigator.share) {
    try { await navigator.share({ title: ev.title, text: text, url: link }); return; }
    catch (e) { if (e && e.name === "AbortError") return; }
  }
  try { await navigator.clipboard.writeText(text + " " + link); toast("Link copied"); }
  catch (e) { window.prompt("Copy this link and send it:", text + " " + link); }
}
function DateBlock({ iso }) {
  const d = new Date(iso);
  return html`<div className="dateblock" aria-hidden="true"><span>${MONTHS_S[d.getMonth()]}</span><b>${d.getDate()}</b></div>`;
}

function EventForm({ ev, onClose, onSaved }) {
  const { me, toast } = useApp();
  const pad = function (n) { return String(n).padStart(2, "0"); };
  const parts = function (iso) { const d = new Date(iso); return { date: d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()), time: pad(d.getHours()) + ":" + pad(d.getMinutes()) }; };
  const s0 = ev ? parts(ev.starts_at) : { date: "", time: "12:00" };
  const e0 = ev && ev.ends_at ? parts(ev.ends_at) : { date: "", time: "" };
  const [title, setTitle] = useState(ev ? ev.title : "");
  const [date, setDate] = useState(s0.date);
  const [time, setTime] = useState(s0.time);
  const [endTime, setEndTime] = useState(e0.time);
  const [place, setPlace] = useState(ev ? ev.place : "");
  const [address, setAddress] = useState(ev ? ev.address : "");
  const [details, setDetails] = useState(ev ? ev.details : "");
  const [sched, setSched] = useState(ev && Array.isArray(ev.schedule) && ev.schedule.length ? ev.schedule.map(function (x) { return { t: x.t || "", l: x.l || "" }; }) : []);
  const [album, setAlbum] = useState(true);
  const [busy, setBusy] = useState(false);
  function setRow(i, k, v) { setSched(function (cur) { return cur.map(function (r, j) { return j === i ? Object.assign({}, r, { [k]: v }) : r; }); }); }
  async function save() {
    if (!title.trim()) { toast("Give the event a name."); return; }
    if (!date || !time) { toast("Pick the date and the start time."); return; }
    const start = new Date(date + "T" + time);
    if (isNaN(start.getTime())) { toast("That date or time does not look right."); return; }
    let end = null;
    if (endTime) { end = new Date(date + "T" + endTime); if (end <= start) end = new Date(end.getTime() + 86400000); }
    setBusy(true);
    const row = {
      title: title.trim(), details: details.trim(), starts_at: start.toISOString(), ends_at: end ? end.toISOString() : null,
      place: place.trim(), address: address.trim(),
      schedule: sched.filter(function (r) { return r.l.trim(); }).slice(0, 20).map(function (r) { return { t: r.t.trim().slice(0, 20), l: r.l.trim().slice(0, 80) }; })
    };
    try {
      if (ev) {
        const r = await sb.from("events").update(row).eq("id", ev.id);
        if (r.error) throw r.error;
      } else {
        let albumId = null;
        if (album) {
          albumId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now());
          const a = await sb.from("albums").insert({ id: albumId, owner_id: me.id, name: title.trim().slice(0, 60) });
          if (a.error) throw a.error;
        }
        const r = await sb.from("events").insert(Object.assign({ created_by: me.id, album_id: albumId }, row));
        if (r.error) { if (albumId) await sb.from("albums").delete().eq("id", albumId); throw r.error; }
      }
      toast(ev ? "Event saved" : "Event created. The family has been told.");
      onSaved();
    } catch (err) { toast((err && err.message) || "Could not save the event."); }
    setBusy(false);
  }
  return html`<${Sheet} title=${ev ? "Edit event" : "New event"} onClose=${onClose}>
    <label htmlFor="ev-t" className="flabel">What is it?</label>
    <input id="ev-t" className="field" maxLength="80" placeholder="Example: Wedding shower, Thanksgiving, Reunion" value=${title} onChange=${function (e) { setTitle(e.target.value); }} />
    <div className="row" style=${{ gap: ".6rem", marginTop: ".2rem" }}>
      <div className="grow"><label htmlFor="ev-d" className="flabel">Date</label><input id="ev-d" className="field" type="date" value=${date} onChange=${function (e) { setDate(e.target.value); }} /></div>
    </div>
    <div className="row" style=${{ gap: ".6rem" }}>
      <div className="grow"><label htmlFor="ev-s" className="flabel">Starts</label><input id="ev-s" className="field" type="time" value=${time} onChange=${function (e) { setTime(e.target.value); }} /></div>
      <div className="grow"><label htmlFor="ev-e" className="flabel">Ends (optional)</label><input id="ev-e" className="field" type="time" value=${endTime} onChange=${function (e) { setEndTime(e.target.value); }} /></div>
    </div>
    <label htmlFor="ev-p" className="flabel">Where? (optional)</label>
    <input id="ev-p" className="field" maxLength="120" placeholder="Example: The lake house" value=${place} onChange=${function (e) { setPlace(e.target.value); }} />
    <label htmlFor="ev-a" className="flabel">Street address (optional, makes a map link)</label>
    <input id="ev-a" className="field" maxLength="200" placeholder="Example: 123 Lake Rd, Canton, GA" value=${address} onChange=${function (e) { setAddress(e.target.value); }} />
    <label htmlFor="ev-n" className="flabel">Details (optional)</label>
    <textarea id="ev-n" className="field" rows="3" maxLength="2000" placeholder="What to wear, parking, anything people should know" value=${details} onChange=${function (e) { setDetails(e.target.value); }}></textarea>
    <div className="flabel">Schedule (optional)</div>
    ${sched.map(function (r, i) {
      return html`<div className="row" key=${i} style=${{ gap: ".4rem", marginBottom: ".4rem" }}>
        <input className="field" style=${{ maxWidth: "6.5rem" }} aria-label=${"Time " + (i + 1)} placeholder="2:00 PM" maxLength="20" value=${r.t} onChange=${function (e) { setRow(i, "t", e.target.value); }} />
        <input className="field" aria-label=${"What happens " + (i + 1)} placeholder="Ceremony" maxLength="80" value=${r.l} onChange=${function (e) { setRow(i, "l", e.target.value); }} />
        <button className="ibtn" aria-label=${"Remove line " + (i + 1)} onClick=${function () { setSched(function (cur) { return cur.filter(function (_, j) { return j !== i; }); }); }}><${Icon} n="close" s=${18} sw=${2.4} /></button>
      </div>`;
    })}
    ${sched.length < 20 && html`<button className="linkbtn" onClick=${function () { setSched(function (cur) { return cur.concat([{ t: "", l: "" }]); }); }}>+ Add a schedule line</button>`}
    ${!ev && html`<div style=${{ marginTop: ".6rem" }}><${Check} on=${album} label="Make a shared photo album for it" sub="Everyone can add photos from the event page" onClick=${function () { setAlbum(!album); }} /></div>`}
    <div className="row" style=${{ marginTop: "1rem" }}><button className="btn grey grow" onClick=${onClose}>Cancel</button><button className="btn grow" disabled=${busy} onClick=${save}>${busy ? "Saving..." : ev ? "Save" : "Create event"}</button></div>
  </${Sheet}>`;
}

function Events() {
  const { me, back, push, tick, bump } = useApp();
  const [events, setEvents] = useState(null);
  const [rsvps, setRsvps] = useState([]);
  const [err, setErr] = useState(false);
  const [form, setForm] = useState(false);
  const [showPast, setShowPast] = useState(false);
  const load = useCallback(async function () {
    const r = await sb.from("events").select("*").order("starts_at", { ascending: true }).limit(200);
    if (r.error) { setErr(true); return; }
    setErr(false); setEvents(r.data || []);
    const ids = (r.data || []).map(function (e) { return e.id; });
    if (ids.length) { const q = await sb.from("event_rsvps").select("event_id,user_id,status,guests").in("event_id", ids); setRsvps(q.data || []); }
  }, []);
  useEffect(function () { load(); }, [load, tick]);
  const upcoming = (events || []).filter(function (e) { return !evState(e).past; });
  const past = (events || []).filter(function (e) { return evState(e).past; }).reverse();
  function card(e) {
    const st = evState(e);
    const mine = rsvps.find(function (x) { return x.event_id === e.id && x.user_id === me.id; });
    const going = rsvps.filter(function (x) { return x.event_id === e.id && x.status === "yes"; });
    const heads = going.reduce(function (n, x) { return n + 1 + (x.guests || 0); }, 0);
    return html`<button className="evcard" key=${e.id} onClick=${function () { push({ name: "event", id: e.id }); }}>
      <${DateBlock} iso=${e.starts_at} />
      <div className="grow" style=${{ minWidth: 0, textAlign: "left" }}>
        <div style=${{ fontWeight: 700, fontSize: "1.05rem" }}>${e.title}</div>
        <div className="muted" style=${{ fontSize: ".85rem" }}>${fmtEvTime(e.starts_at)}${e.place ? " · " + e.place : ""}</div>
        <div style=${{ fontSize: ".8rem", marginTop: ".2rem" }}>${heads > 0 ? heads + " going" : "No RSVPs yet"}${mine ? " · You: " + (mine.status === "yes" ? "Going" : mine.status === "maybe" ? "Maybe" : "Can't go") : ""}</div>
      </div>
      <span className=${"pillx" + (st.live ? " live" : st.past ? " old" : "")}>${st.label}</span>
    </button>`;
  }
  if (err && !events) return html`<div><${TopBar} title="Events" back=${back} /><${Failed} what="events" onRetry=${load} /></div>`;
  return html`<div>
    <${TopBar} title="Events" back=${back} right=${html`<button className="tbtn" onClick=${function () { setForm(true); }}>New</button>`} />
    ${!events && html`<div className="center muted" style=${{ padding: "3rem 1rem" }}>Loading...</div>`}
    ${events && upcoming.length === 0 && html`<div className="cmtempty">
      <div className="bub"><span style=${{ fontSize: "1.8rem" }}>🎉</span></div>
      <div className="serif" style=${{ fontSize: "1.25rem", color: "#0879a0" }}>Plan something together</div>
      <div className="muted" style=${{ margin: ".2rem 0 1rem" }}>A shower, a reunion, Thanksgiving. Everyone can RSVP, sign up to bring something, and share photos.</div>
      <button className="btn" onClick=${function () { setForm(true); }}>Create the first event</button>
    </div>`}
    ${upcoming.map(card)}
    ${past.length > 0 && html`<div style=${{ padding: ".6rem 1rem" }}><button className="linkbtn" onClick=${function () { setShowPast(!showPast); }}>${showPast ? "Hide past events" : "Show past events (" + past.length + ")"}</button></div>`}
    ${showPast && past.map(card)}
    ${form && html`<${EventForm} onClose=${function () { setForm(false); }} onSaved=${function () { setForm(false); load(); bump(); }} />`}
  </div>`;
}

function EventPhotos({ ev }) {
  const { push, tick } = useApp();
  const [posts, setPosts] = useState(null);
  const [total, setTotal] = useState(0);
  useEffect(function () {
    if (!ev.album_id) return;
    sb.from("album_posts").select("post_id").eq("album_id", ev.album_id).then(function (a) {
      const ids = (a.data || []).map(function (x) { return x.post_id; });
      setTotal(ids.length);
      if (!ids.length) { setPosts([]); return; }
      return sb.from("posts").select("id,image_path,video_path,created_at").in("id", ids).order("created_at", { ascending: false }).limit(9).then(function (p) { setPosts(p.data || []); });
    }).catch(function () { setPosts([]); });
  }, [ev.album_id, tick]);
  const urls = useUrls((posts || []).map(function (p) { return p.image_path; }));
  if (!ev.album_id) return null;
  return html`<div className="evsec">
    <div className="evh"><h3>Photos</h3>${total > 0 && html`<button className="linkbtn" onClick=${function () { push({ name: "album", id: ev.album_id }); }}>See all ${total}</button>`}</div>
    ${posts && posts.length > 0 && html`<div className="evphotos">${posts.map(function (p) {
      return html`<button key=${p.id} onClick=${function () { push({ name: "album", id: ev.album_id }); }} aria-label="Open the photo album">${urls(p.image_path) ? html`<img src=${urls(p.image_path)} alt="" />` : html`<span></span>`}${p.video_path && html`<i className="vplay" aria-hidden="true"></i>`}</button>`;
    })}</div>`}
    ${posts && posts.length === 0 && html`<div className="muted" style=${{ fontSize: ".9rem", padding: ".2rem 0 .6rem" }}>No photos yet. Be the first to add one.</div>`}
    <button className="btn grey block" style=${{ marginTop: ".5rem" }} onClick=${function () { push({ name: "new", albumId: ev.album_id, albumName: ev.title }); }}>Add photos or a video</button>
    ${total > 0 && html`<button className="btn grey block" style=${{ marginTop: ".5rem" }} onClick=${function () { push({ name: "wall", id: ev.id }); }}>Start the photo wall (for a TV)</button>`}
  </div>`;
}

function BringList({ ev }) {
  const { me, profiles, toast, tick } = useApp();
  const [items, setItems] = useState(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async function () {
    const r = await sb.from("event_items").select("*").eq("event_id", ev.id).order("created_at");
    setItems(r.data || []);
  }, [ev.id]);
  useEffect(function () { load(); }, [load, tick]);
  async function add() {
    const label = text.trim();
    if (!label) return;
    setBusy(true);
    const r = await sb.from("event_items").insert({ event_id: ev.id, label: label, created_by: me.id });
    setBusy(false);
    if (r.error) { toast(r.error.message); return; }
    setText(""); load();
  }
  async function claim(it, on) {
    const r = await sb.rpc("claim_event_item", { p_item: it.id, p_claim: on });
    if (r.error) toast(/already/i.test(r.error.message) ? "Someone just claimed that one." : r.error.message);
    load();
  }
  async function del(it) {
    if (!confirm("Remove \"" + it.label + "\" from the list?")) return;
    const r = await sb.from("event_items").delete().eq("id", it.id);
    if (r.error) toast(r.error.message);
    load();
  }
  const canDelete = function (it) { return it.created_by === me.id || ev.created_by === me.id || me.role === "admin"; };
  return html`<div className="evsec">
    <div className="evh"><h3>Who is bringing what</h3></div>
    ${items && items.length === 0 && html`<div className="muted" style=${{ fontSize: ".9rem", paddingBottom: ".5rem" }}>Nothing on the list yet. Add a dish or a job, and people can sign up for it.</div>`}
    ${(items || []).map(function (it) {
      const mine = it.claimed_by === me.id;
      return html`<div className="bring" key=${it.id}>
        <div className="grow" style=${{ minWidth: 0 }}>
          <div style=${{ fontWeight: 600, overflowWrap: "anywhere" }}>${it.label}</div>
          <div className="muted" style=${{ fontSize: ".8rem" }}>${it.claimed_by ? (mine ? "You are bringing this" : nm(profiles[it.claimed_by]) + " is bringing this") : "Still needed"}</div>
        </div>
        ${!it.claimed_by && html`<button className="btn sm" onClick=${function () { claim(it, true); }}>I'll bring it</button>`}
        ${(mine || (it.claimed_by && me.role === "admin")) && html`<button className="btn sm grey" onClick=${function () { claim(it, false); }}>${mine ? "Not me" : "Release"}</button>`}
        ${canDelete(it) && html`<button className="ibtn" aria-label=${"Remove " + it.label} onClick=${function () { del(it); }}><${Icon} n="close" s=${16} sw=${2.4} color="#8a8a8a" /></button>`}
      </div>`;
    })}
    <div className="row" style=${{ marginTop: ".5rem" }}>
      <label className="sr" htmlFor="bring-in">Add something to the list</label>
      <input id="bring-in" className="field" maxLength="60" placeholder="Add something, like Mashed potatoes" value=${text} onChange=${function (e) { setText(e.target.value); }} onKeyDown=${function (e) { if (e.key === "Enter") add(); }} />
      <button className="btn" disabled=${busy || !text.trim()} onClick=${add}>Add</button>
    </div>
  </div>`;
}

function EventScreen({ id }) {
  const { me, profiles, back, toast, tick, bump } = useApp();
  const [ev, setEv] = useState(undefined);
  const [rsvps, setRsvps] = useState([]);
  const [err, setErr] = useState(false);
  const [edit, setEdit] = useState(false);
  const [who, setWho] = useState(false);
  const load = useCallback(async function () {
    const e = await sb.from("events").select("*").eq("id", id).maybeSingle();
    if (e.error) { setErr(true); return; }
    setErr(false); setEv(e.data || null);
    const r = await sb.from("event_rsvps").select("*").eq("event_id", id);
    setRsvps(r.data || []);
  }, [id]);
  useEffect(function () { load(); }, [load, tick]);
  const mine = rsvps.find(function (r) { return r.user_id === me.id; });
  async function setStatus(status) {
    if (mine && mine.status === status) {
      const r = await sb.from("event_rsvps").delete().match({ event_id: id, user_id: me.id });
      if (r.error) { toast(r.error.message); return; }
    } else {
      const r = await sb.from("event_rsvps").upsert({ event_id: id, user_id: me.id, status: status, guests: status === "no" ? 0 : (mine ? mine.guests : 0), updated_at: new Date().toISOString() }, { onConflict: "event_id,user_id" });
      if (r.error) { toast(r.error.message); return; }
    }
    load(); bump();
  }
  async function setGuests(n) {
    if (!mine) return;
    const g = Math.max(0, Math.min(10, n));
    const r = await sb.from("event_rsvps").upsert({ event_id: id, user_id: me.id, status: mine.status, guests: g, updated_at: new Date().toISOString() }, { onConflict: "event_id,user_id" });
    if (r.error) { toast(r.error.message); return; }
    load();
  }
  async function del() {
    if (!confirm("Delete this event? The photo album stays.")) return;
    const r = await sb.from("events").delete().eq("id", id);
    if (r.error) { toast(r.error.message); return; }
    toast("Event deleted"); bump(); back();
  }
  if (err && ev === undefined) return html`<div><${TopBar} title="Event" back=${back} /><${Failed} what="this event" onRetry=${load} /></div>`;
  if (ev === undefined) return html`<div><${TopBar} title="Event" back=${back} /><div className="center muted" style=${{ padding: "3rem 1rem" }}>Loading...</div></div>`;
  if (ev === null) return html`<div><${TopBar} title="Event" back=${back} /><div className="center muted" style=${{ padding: "3rem 1rem" }}>This event is no longer here.</div></div>`;
  const st = evState(ev);
  const yes = rsvps.filter(function (r) { return r.status === "yes"; });
  const maybe = rsvps.filter(function (r) { return r.status === "maybe"; });
  const heads = yes.reduce(function (n, r) { return n + 1 + (r.guests || 0); }, 0);
  const canManage = ev.created_by === me.id || me.role === "admin";
  const mapQ = encodeURIComponent(ev.address || ev.place || "");
  const sched = Array.isArray(ev.schedule) ? ev.schedule : [];
  const rs = function (key, label) {
    return html`<button className=${"rsvpbtn" + (mine && mine.status === key ? " on " + key : "")} aria-pressed=${!!(mine && mine.status === key)} onClick=${function () { setStatus(key); }}>${label}</button>`;
  };
  return html`<div>
    <${TopBar} title="Event" back=${back} right=${canManage ? html`<button className="tbtn" onClick=${function () { setEdit(true); }}>Edit</button>` : null} />
    <div className="evhero">
      <${DateBlock} iso=${ev.starts_at} />
      <div className="grow" style=${{ minWidth: 0 }}>
        <h2 className="serif" style=${{ margin: 0, color: "#0879a0", fontSize: "1.5rem", lineHeight: 1.15, overflowWrap: "anywhere" }}>${ev.title}</h2>
        <div style=${{ marginTop: ".3rem" }}><span className=${"pillx" + (st.live ? " live" : st.past ? " old" : "")}>${st.label}</span></div>
      </div>
    </div>
    <div className="evsec" style=${{ paddingTop: 0 }}>
      <div className="evline"><b>${fmtEvDate(ev.starts_at)}</b><span>${fmtEvTime(ev.starts_at)}${ev.ends_at ? " to " + fmtEvTime(ev.ends_at) : ""}</span></div>
      ${(ev.place || ev.address) && html`<div className="evline"><b>${ev.place || ev.address}</b>${ev.place && ev.address && html`<span>${ev.address}</span>`}
        <a className="linkbtn" href=${"https://www.google.com/maps/search/?api=1&query=" + mapQ} target="_blank" rel="noopener noreferrer">Open in maps</a></div>`}
      ${ev.details && html`<p style=${{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: ".6rem 0 0" }}><${Linkify} text=${ev.details} /></p>`}
      <div className="row" style=${{ gap: ".4rem", flexWrap: "wrap" }}>
        ${!st.past && html`<button className="linkbtn" onClick=${function () { addToCalendar(ev, toast); }}>Add to my calendar</button>`}
        <button className="linkbtn" onClick=${function () { shareEvent(ev, toast); }}>Share link with family</button>
      </div>
    </div>
    ${!st.past && html`<div className="evsec">
      <div className="evh"><h3>Are you coming?</h3></div>
      <div className="rsvprow">${rs("yes", "Going")}${rs("maybe", "Maybe")}${rs("no", "Can't go")}</div>
      ${mine && mine.status !== "no" && html`<div className="row" style=${{ marginTop: ".6rem", alignItems: "center" }}>
        <div className="grow muted">Bringing guests?</div>
        <button className="stepbtn" aria-label="Fewer guests" onClick=${function () { setGuests(mine.guests - 1); }}>−</button>
        <b style=${{ minWidth: "5.2rem", textAlign: "center" }}>${mine.guests === 0 ? "Just me" : "+" + mine.guests + (mine.guests === 1 ? " guest" : " guests")}</b>
        <button className="stepbtn" aria-label="More guests" onClick=${function () { setGuests(mine.guests + 1); }}>+</button>
      </div>`}
    </div>`}
    <div className="evsec">
      <div className="evh"><h3>${heads} going${maybe.length > 0 ? " · " + maybe.length + " maybe" : ""}</h3>${(yes.length + maybe.length) > 0 && html`<button className="linkbtn" onClick=${function () { setWho(!who); }}>${who ? "Hide" : "See who"}</button>`}</div>
      ${who && html`<div className="whos">${yes.concat(maybe).map(function (r) {
        return html`<div key=${r.user_id} className="whorow"><${Avatar} id=${r.user_id} name=${nm(profiles[r.user_id])} size=${30} /><span className="grow">${nm(profiles[r.user_id])}${r.guests > 0 ? " +" + r.guests : ""}</span><span className="muted" style=${{ fontSize: ".8rem" }}>${r.status === "yes" ? "Going" : "Maybe"}</span></div>`;
      })}</div>`}
    </div>
    ${sched.length > 0 && html`<div className="evsec"><div className="evh"><h3>Schedule</h3></div>
      ${sched.map(function (r, i) { return html`<div className="schedrow" key=${i}><b>${r.t || ""}</b><span>${r.l}</span></div>`; })}</div>`}
    <${BringList} ev=${ev} />
    <${EventPhotos} ev=${ev} />
    <${EventMessages} ev=${ev} />
    ${canManage && html`<div style=${{ padding: "1rem" }}><button className="btn danger block" onClick=${del}>Delete this event</button></div>`}
    <div style=${{ height: "1rem" }}></div>
    ${edit && html`<${EventForm} ev=${ev} onClose=${function () { setEdit(false); }} onSaved=${function () { setEdit(false); load(); bump(); }} />`}
  </div>`;
}

/* Home: today's special days and the next event */
function HomeCelebrate() {
  const { profiles, push } = useApp();
  const an = useAnniversaries();
  const { tick } = useApp();
  const [evs, setEvs] = useState([]);
  const [card, setCard] = useState(null);
  useEffect(function () {
    const from = new Date(Date.now() - 6 * 3600000).toISOString();
    const to = new Date(Date.now() + 90 * 86400000).toISOString();
    sb.from("events").select("id,title,starts_at,ends_at,place,album_id").gte("starts_at", from).lte("starts_at", to).order("starts_at", { ascending: true }).limit(20)
      .then(function (r) { setEvs(r.data || []); }).catch(function () {});
  }, [tick]);
  const all = buildCelebrations(profiles, an.rows || []);
  const today = all.filter(function (c) { return c.days === 0; }).slice(0, 3);
  const soon = all.filter(function (c) { return c.days > 0 && c.days <= 30; }).slice(0, 2);
  if (!today.length && !evs.length && !soon.length) return null;
  const many = evs.length > 1;
  return html`<div>
    ${today.map(function (c) {
      return html`<div className="pcard slim" key=${c.kind + c.key}>
        <div style=${{ fontSize: "1.7rem" }} aria-hidden="true">${c.kind === "birthday" ? "🎂" : "💍"}</div>
        <div className="grow"><div className="pt" style=${{ fontSize: "1rem" }}>${c.kind === "birthday" ? "It's " + c.title.replace(/'s birthday$/, "") + "'s birthday!" : c.title + (c.years > 0 ? ": " + c.years + " years today!" : " today!")}</div></div>
        <button className="btn sm" onClick=${function () { setCard(c); }}>Wish</button>
      </div>`;
    })}
    ${(evs.length > 0 || soon.length > 0) && html`<section className="comingup" aria-label="Coming up">
      <div className="cuh"><b>Coming up</b>
        ${evs.length > 0 ? html`<button className="linkbtn" onClick=${function () { push({ name: "events" }); }}>All events</button>` : html`<button className="linkbtn" onClick=${function () { push({ name: "celebrations" }); }}>See all</button>`}</div>
      ${evs.length > 0 && html`<div className=${"evstrip" + (many ? " many" : "")}>${evs.map(function (e) {
        const st = evState(e);
        return html`<button key=${e.id} className="evmini" onClick=${function () { push({ name: "event", id: e.id }); }}>
          <${DateBlock} iso=${e.starts_at} />
          <span className="grow" style=${{ minWidth: 0, textAlign: "left" }}>
            <b className="one">${e.title}</b>
            <span className="muted one" style=${{ fontSize: ".8rem" }}>${fmtEvTime(e.starts_at)}${e.place ? " · " + e.place : ""}</span>
            <span className=${"pillx" + (st.live ? " live" : "")} style=${{ marginTop: ".2rem", display: "inline-block" }}>${st.label}</span>
          </span></button>`;
      })}</div>`}
      ${evs.filter(function (e) { return e.album_id && daysAway(new Date(e.starts_at)) <= 0; }).map(function (e) {
        return html`<button key=${"ph" + e.id} className="btn block" style=${{ marginTop: ".5rem" }} onClick=${function () { push({ name: "new", albumId: e.album_id, albumName: e.title }); }}>Add photos to ${e.title}</button>`;
      })}
      ${soon.map(function (c) {
        return html`<button key=${c.kind + c.key} className="cline" onClick=${function () { push({ name: "celebrations" }); }}>
          <span aria-hidden="true">${c.kind === "birthday" ? "🎂" : "💍"}</span><span className="grow one" style=${{ textAlign: "left" }}>${c.title}</span><span className="away">${awayLabel(c.days)}</span></button>`;
      })}
    </section>`}
    ${card && html`<${WishSheet} c=${card} onClose=${function () { setCard(null); }} onEdit=${function () { setCard(null); push({ name: "celebrations" }); }} />`}
  </div>`;
}


/* =====================  Round 4: photo wall, event messages, backup  ===================== */
function PhotoWall({ id }) {
  const { profiles, back } = useApp();
  const [ev, setEv] = useState(undefined);
  const [items, setItems] = useState([]);
  const [curKey, setCurKey] = useState(null);
  const [ui, setUi] = useState(true);
  const [paused, setPaused] = useState(false);
  const seen = useRef(new Set());
  const itemsRef = useRef([]);
  const load = useCallback(async function () {
    try {
      const e = await sb.from("events").select("id,title,album_id").eq("id", id).maybeSingle();
      setEv(e.data || null);
      if (!e.data || !e.data.album_id) { setItems([]); return; }
      const a = await sb.from("album_posts").select("post_id").eq("album_id", e.data.album_id);
      const ids = (a.data || []).map(function (x) { return x.post_id; });
      if (!ids.length) { setItems([]); return; }
      const p = await sb.from("posts").select("id,author_id,caption,image_path,video_path,extra_paths,created_at").in("id", ids).order("created_at", { ascending: false }).limit(200);
      const list = [];
      (p.data || []).forEach(function (x) {
        [x.image_path].concat(x.extra_paths || []).filter(Boolean).forEach(function (pt, k) { list.push({ key: x.id + ":" + k, path: pt, who: x.author_id, cap: k === 0 ? x.caption : "" }); });
      });
      itemsRef.current = list;
      setItems(list);
    } catch (err) { /* keep showing what we have */ }
  }, [id]);
  useEffect(function () { load(); const t = setInterval(load, 20000); return function () { clearInterval(t); }; }, [load]);
  /* advance: show the newest photo nobody has seen yet, otherwise go on to the next one */
  useEffect(function () {
    if (paused) return;
    function step() {
      const list = itemsRef.current;
      if (!list.length) return;
      const fresh = list.find(function (x) { return !seen.current.has(x.key); });
      setCurKey(function (cur) {
        let next;
        if (fresh) next = fresh.key;
        else { const i = list.findIndex(function (x) { return x.key === cur; }); next = list[(i + 1) % list.length].key; }
        seen.current.add(next);
        return next;
      });
    }
    if (curKey === null) step();
    const t = setInterval(step, 7000);
    return function () { clearInterval(t); };
  }, [paused, items.length > 0]);
  useEffect(function () {   // keep the screen awake while the wall is up
    let lock = null;
    try { if (navigator.wakeLock) navigator.wakeLock.request("screen").then(function (l) { lock = l; }).catch(function () {}); } catch (e) {}
    function k(e) { if (e.key === "Escape") back(); }
    window.addEventListener("keydown", k);
    return function () { window.removeEventListener("keydown", k); try { if (lock) lock.release(); } catch (e) {} };
  }, []);
  const idx = items.findIndex(function (x) { return x.key === curKey; });
  const cur = idx >= 0 ? items[idx] : null;
  const ahead = [0, 1, 2].map(function (k) { const x = items[(Math.max(idx, 0) + k) % Math.max(items.length, 1)]; return x && x.path; }).filter(Boolean);
  const urls = useUrls(ahead);
  function goFull() { try { const el = document.documentElement; if (document.fullscreenElement) document.exitFullscreen(); else if (el.requestFullscreen) el.requestFullscreen(); } catch (e) {} }
  return html`<div className="wall" onClick=${function () { setUi(!ui); }}>
    ${cur && urls(cur.path) ? html`<img key=${cur.key} className="wallimg" src=${urls(cur.path)} alt=${"Photo shared by " + nm(profiles[cur.who])} />` : null}
    ${!cur && html`<div className="wallmsg">${ev === undefined ? "Loading..." : ev === null ? "This event is no longer here." : "Photos will appear here as the family shares them."}</div>`}
    ${cur && html`<div className="wallcap"><b>${nm(profiles[cur.who])}</b>${cur.cap ? html`<span>${cur.cap}</span>` : null}</div>`}
    ${ui && html`<div className="wallbar" onClick=${function (e) { e.stopPropagation(); }}>
      <button className="wbtn2" onClick=${back}>Close</button>
      <span className="wallt">${ev ? ev.title : ""}${items.length ? " · " + (Math.max(idx, 0) + 1) + " of " + items.length : ""}</span>
      <button className="wbtn2" onClick=${function () { setPaused(!paused); }}>${paused ? "Play" : "Pause"}</button>
      <button className="wbtn2" onClick=${goFull}>Full screen</button>
    </div>`}
  </div>`;
}

function EventMessages({ ev }) {
  const { me, profiles, toast, tick, bump } = useApp();
  const [rows, setRows] = useState(null);
  const [text, setText] = useState("");
  const [voice, setVoice] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async function () {
    const r = await sb.from("event_messages").select("*").eq("event_id", ev.id).order("created_at", { ascending: false }).limit(300);
    setRows(r.data || []);
  }, [ev.id]);
  useEffect(function () { load(); }, [load, tick]);
  const urls = useUrls((rows || []).map(function (m) { return m.audio_path; }));
  async function send() {
    if (!text.trim() && !voice) return;
    setBusy(true);
    let path = null;
    try {
      if (voice) {
        const ext = /mp4/.test(voice.blob.type) ? "m4a" : "webm";
        path = me.id + "/" + ((window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now())) + "." + ext;
        const up = await sb.storage.from("photos").upload(path, voice.blob, { contentType: voice.blob.type || "audio/webm" });
        if (up.error) throw up.error;
      }
      const r = await sb.from("event_messages").insert({ event_id: ev.id, author_id: me.id, body: text.trim(), audio_path: path, audio_seconds: voice ? Math.max(1, Math.round(voice.seconds)) : null });
      if (r.error) throw r.error;
      setText(""); setVoice(null); toast("Message added"); await load(); bump();
    } catch (e) {
      if (path) sb.storage.from("photos").remove([path]);
      toast((e && e.message) || "Could not save your message.");
    }
    setBusy(false);
  }
  async function del(m) {
    if (!confirm("Delete this message?")) return;
    const r = await sb.from("event_messages").delete().eq("id", m.id);
    if (r.error) { toast(r.error.message); return; }
    if (m.audio_path) sb.storage.from("photos").remove([m.audio_path]);
    load();
  }
  function keepsake() {
    const lines = ["Messages for " + ev.title, fmtEvDate(ev.starts_at), ""];
    (rows || []).slice().reverse().forEach(function (m) {
      lines.push(nm(profiles[m.author_id]) + " (" + new Date(m.created_at).toLocaleDateString() + ")");
      lines.push(m.body || "(voice message, not included in this file)");
      lines.push("");
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/plain" }));
    a.download = "messages.txt";
    document.body.appendChild(a); a.click(); a.remove();
  }
  const canManage = ev.created_by === me.id || me.role === "admin";
  return html`<div className="evsec">
    <div className="evh"><h3>Messages and well wishes</h3>${canManage && rows && rows.length > 0 && html`<button className="linkbtn" onClick=${keepsake}>Save as a file</button>`}</div>
    <label className="sr" htmlFor="emsg-in">Write a message</label>
    <textarea id="emsg-in" className="field" rows="3" maxLength="600" placeholder="Write a few kind words..." value=${text} onChange=${function (e) { setText(e.target.value); }} style=${{ marginTop: ".5rem" }}></textarea>
    <div style=${{ display: "flex", justifyContent: "flex-end" }}><${EmojiBtn} onPick=${function (em) { setText(function (t) { return (t + em).slice(0, 600); }); }} /></div>
    <div style=${{ margin: ".5rem 0" }}><${VoiceRecorder} value=${voice} onChange=${setVoice} /></div>
    <button className="btn block" disabled=${busy || (!text.trim() && !voice)} onClick=${send}>${busy ? "Saving..." : "Add my message"}</button>
    ${rows && rows.length === 0 && html`<div className="muted" style=${{ fontSize: ".9rem", paddingTop: ".6rem" }}>No messages yet. Yours can be the first.</div>`}
    ${(rows || []).map(function (m) {
      return html`<div className="wish" key=${m.id}>
        <${Avatar} id=${m.author_id} name=${nm(profiles[m.author_id])} size=${32} />
        <div className="grow" style=${{ minWidth: 0 }}>
          <b style=${{ fontWeight: 600 }}>${nm(profiles[m.author_id])}</b>
          ${m.body && html`<div style=${{ overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}><${Linkify} text=${m.body} /></div>`}
          ${m.audio_path && (urls(m.audio_path) ? html`<audio controls preload="none" src=${urls(m.audio_path)} style=${{ width: "100%", marginTop: ".3rem" }} aria-label=${"Voice message from " + nm(profiles[m.author_id])}></audio>` : html`<div className="muted" style=${{ fontSize: ".85rem" }}>Loading voice message...</div>`)}
        </div>
        ${(m.author_id === me.id || canManage) && html`<button className="ibtn" aria-label="Delete this message" onClick=${function () { del(m); }}><${Icon} n="close" s=${16} sw=${2.4} color="#8a8a8a" /></button>`}
      </div>`;
    })}
  </div>`;
}

/* ---- admin backup ---- */
async function runBackup(withMedia, setStatus) {
  const fetchAll = async function (t, sel) {
    const out = [];
    for (let from = 0; from < 20000; from += 1000) {
      const r = await sb.from(t).select(sel || "*").range(from, from + 999);
      if (r.error) throw r.error;
      const d = r.data || [];
      out.push.apply(out, d);
      if (d.length < 1000) break;
    }
    return out;
  };
  setStatus("Reading your family's posts...");
  const names = ["posts", "comments", "news", "prompts", "albums", "album_posts", "events", "event_rsvps", "event_items", "event_messages", "anniversaries", "wishes"];
  const data = { made: new Date().toISOString(), note: "Everything the account that made this backup is allowed to see." };
  data.profiles = await fetchAll("profiles", "id,display_name,bio,relation,role,status,created_at,birth_month,birth_day");
  for (let i = 0; i < names.length; i++) { setStatus("Reading " + names[i].replace("_", " ") + "..."); data[names[i]] = await fetchAll(names[i]); }
  const mod = await import("https://esm.sh/jszip@3.10.1");
  const JSZip = mod.default || mod;
  const zip = new JSZip();
  zip.file("data.json", JSON.stringify(data, null, 1));
  zip.file("README.txt", "Inner Circle backup made " + new Date().toLocaleString() + ".\ndata.json holds posts, comments, events, messages and people (no phone numbers).\n" + (withMedia ? "The media folder holds photos, videos and voice messages, named by their path in the vault.\n" : "This copy has text only. Photos and videos are not in it.\n") + "Keep this file private: it contains your family's memories.\n");
  let skipped = 0;
  if (withMedia) {
    const paths = new Set();
    (data.posts || []).forEach(function (p) { allPaths(p).forEach(function (x) { paths.add(x); }); });
    (data.news || []).forEach(function (n) { if (n.audio_path) paths.add(n.audio_path); });
    (data.event_messages || []).forEach(function (m) { if (m.audio_path) paths.add(m.audio_path); });
    (data.profiles || []).forEach(function () {});
    const list = Array.from(paths);
    let done = 0;
    for (let i = 0; i < list.length; i += 20) {
      const chunk = list.slice(i, i + 20);
      await ensureUrls(chunk);
      for (let k = 0; k < chunk.length; k++) {
        done++;
        setStatus("Saving file " + done + " of " + list.length + "...");
        const c = urlCache.get(chunk[k]);
        if (!c) { skipped++; continue; }
        try { const res = await fetch(c.url); if (!res.ok) throw new Error("x"); zip.file("media/" + chunk[k], await res.blob(), { compression: "STORE" }); }
        catch (e) { skipped++; }
      }
    }
  }
  setStatus("Packing it up...");
  const out = await zip.generateAsync({ type: "blob", streamFiles: true });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(out);
  a.download = "inner-circle-backup-" + new Date().toISOString().slice(0, 10) + (withMedia ? "" : "-text") + ".zip";
  document.body.appendChild(a); a.click(); a.remove();
  lsSet("ic-backup-at", String(Date.now()));
  return { posts: (data.posts || []).length, skipped: skipped };
}

function BackupSection() {
  const { toast } = useApp();
  const [status, setStatus] = useState("");
  const [last, setLast] = useState(Number(lsGet("ic-backup-at", "0")) || 0);
  async function go(media) {
    if (media && !confirm("This downloads every photo and video. It can be very large and slow. Use Wi-Fi and, if you can, a computer. Continue?")) return;
    try {
      const r = await runBackup(media, setStatus);
      setLast(Date.now());
      toast("Backup saved" + (r.skipped ? " (" + r.skipped + " files could not be read)" : ""));
    } catch (e) { toast((e && e.message) || "The backup did not finish. Try again."); }
    setStatus("");
  }
  return html`<div>
    <h2 className="serif sec">Back up</h2>
    <div className="muted" style=${{ fontSize: ".85rem", marginBottom: ".6rem" }}>Save a copy of what your account can see. It does not include private group posts from other people. For a complete copy of the database, also use Backups in your Supabase dashboard (paid plans).</div>
    <div className="muted" style=${{ fontSize: ".8rem", marginBottom: ".5rem" }}>${last ? "Last backup from this device: " + new Date(last).toLocaleDateString() : "No backup from this device yet."}</div>
    ${status ? html`<div role="status" style=${{ fontWeight: 600 }}>${status}</div>` : html`<div className="row">
      <button className="btn grow" onClick=${function () { go(false); }}>Text only (small)</button>
      <button className="btn grey grow" onClick=${function () { go(true); }}>With photos and videos</button></div>`}
  </div>`;
}

function BackupReminder() {
  const { me, push } = useApp();
  const [hide, setHide] = useState(false);
  if (me.role !== "admin" || hide) return null;
  const last = Number(lsGet("ic-backup-at", "0")) || 0;
  const snooze = Number(lsGet("ic-backup-snooze", "0")) || 0;
  const base = last || new Date(me.created_at || Date.now()).getTime();
  const days = Math.floor((Date.now() - base) / 86400000);
  if (days < 30 || Date.now() - snooze < 7 * 86400000) return null;
  return html`<div className="pcard slim">
    <div className="grow"><div className="pk">Back up</div><div className="pt" style=${{ fontSize: ".95rem" }}>${last ? "It has been " + days + " days since your last backup." : "Save a copy of your family's memories."}</div></div>
    <button className="btn sm" onClick=${function () { push({ name: "organizer" }); }}>Back up</button>
    <button className="ibtn" aria-label="Remind me next week" onClick=${function () { lsSet("ic-backup-snooze", String(Date.now())); setHide(true); }}><${Icon} n="close" s=${16} sw=${2.4} color="#8a8a8a" /></button>
  </div>`;
}


function People() {
  const { me, profiles, push, tick, openHello, pendingCount } = useApp();
  const [last, setLast] = useState(null);
  const [err, setErr] = useState(false);

  const load = useCallback(async function () {
    const m = {};
    const q = await sb.rpc("last_shared");
    if (!q.error && Array.isArray(q.data)) {
      q.data.forEach(function (x) { m[x.author_id] = x.last_at; });
    } else {
      const r = await sb.from("posts").select("author_id,created_at").order("created_at", { ascending: false }).limit(1000);
      if (r.error) { setErr(true); return; }
      (r.data || []).forEach(function (x) { if (!m[x.author_id]) m[x.author_id] = x.created_at; });
    }
    setErr(false);
    setLast(m);
  }, []);
  useEffect(function () { load(); }, [load, tick]);

  const members = Object.keys(profiles).map(function (k) { return profiles[k]; }).filter(function (x) { return x.status === "approved"; })
    .sort(function (a, b) { return nm(a).localeCompare(nm(b)); });
  const admin = me.role === "admin";

  const header = html`<div className="top"><div><h1 className="serif" style=${{ color: "#0879a0", fontSize: "1.7rem" }}>Your Inner Circle</h1></div>
    ${admin && html`<button className="btn sm grey" style=${{ position: "relative" }} onClick=${function () { push({ name: "organizer" }); }}>Manage${pendingCount > 0 ? html`<span className="badge" style=${{ top: "-.2rem", right: "-.2rem" }}></span>` : ""}</button>`}</div>`;

  if (err && !last) return html`<div>${header}<${Failed} what="your circle" onRetry=${load} /></div>`;
  if (!last) return html`<div>${header}<div className="center muted" style=${{ padding: "4rem 1rem" }}>Loading...</div></div>`;
  const quietOf = function (m) { return admin && m.id !== me.id && (!last[m.id] || daysSince(last[m.id]) >= 14); };
  const active = members.filter(function (m) { return !quietOf(m); });
  const quiet = members.filter(quietOf);

  function row(m, nudge) {
    const l = last[m.id];
    return html`<div className="listrow" key=${m.id} style=${{ cursor: "default" }}>
      <button className="rowmain" onClick=${function () { push({ name: "profile", userId: m.id }); }}>
        <${Avatar} id=${m.id} name=${m.display_name} size=${52} />
        <div style=${{ minWidth: 0 }}>
          <div style=${{ fontWeight: 600 }}>${nm(m)}${m.id === me.id ? " (you)" : ""}</div>
          ${m.relation && html`<div className="muted" style=${{ fontSize: ".8rem" }}>${m.relation}</div>`}
          <div className="muted" style=${{ fontSize: ".8rem" }}>${l ? "Shared " + agoLong(l) : "Has not shared yet"}</div>
        </div>
      </button>
      ${nudge && html`<button className="btn sm" onClick=${function () { openHello(m.id); }}>Say hello</button>`}
    </div>`;
  }

  return html`
    <div>
      ${header}
      <div className="muted" style=${{ padding: "0 1rem .1rem", fontSize: ".85rem" }}>${members.length} ${members.length === 1 ? "person" : "people"}. Everyone here was invited by family.</div>
      <button className="listrow" style=${{ borderTop: "1px solid var(--soft)", borderBottom: "1px solid var(--soft)", margin: ".5rem 0" }} onClick=${function () { push({ name: "groups" }); }}>
        <div className="grow"><div style=${{ fontWeight: 600 }}>My groups</div><div className="muted" style=${{ fontSize: ".8rem" }}>Share with just some family, like Siblings or Grandkids</div></div>
        <${Icon} n="chev" s=${20} sw=${2} color="#6b6b6b" />
      </button>
      <button className="listrow" style=${{ borderBottom: "1px solid var(--soft)", marginBottom: ".5rem" }} onClick=${function () { push({ name: "events" }); }}>
        <div className="grow"><div style=${{ fontWeight: 600 }}>Events</div><div className="muted" style=${{ fontSize: ".8rem" }}>RSVP, sign up to bring something, share photos</div></div>
        <${Icon} n="chev" s=${20} sw=${2} color="#6b6b6b" />
      </button>
      <button className="listrow" style=${{ borderBottom: "1px solid var(--soft)", marginBottom: ".5rem" }} onClick=${function () { push({ name: "celebrations" }); }}>
        <div className="grow"><div style=${{ fontWeight: 600 }}>Birthdays and anniversaries</div><div className="muted" style=${{ fontSize: ".8rem" }}>Never miss a special day, send a wish</div></div>
        <${Icon} n="chev" s=${20} sw=${2} color="#6b6b6b" />
      </button>
      ${active.map(function (m) { return row(m, false); })}
      ${quiet.length > 0 && html`<div className="hdr">Quiet lately (only you can see this)</div>`}
      ${quiet.map(function (m) { return row(m, true); })}
    </div>`;
}

/* =====================  organizer (admin)  ===================== */
function Organizer() {
  const { me, toast, back, openInvite, reloadProfiles, bump, push } = useApp();
  const [prompts, setPrompts] = useState([]);
  const [promptText, setPromptText] = useState("");
  const loadPrompts = useCallback(function () { sb.from("prompts").select("*").order("created_at", { ascending: false }).limit(5).then(function (r) { setPrompts(r.data || []); }).catch(function () {}); }, []);
  useEffect(function () { loadPrompts(); }, [loadPrompts]);
  async function postPrompt() {
    const r = await sb.from("prompts").insert({ author_id: me.id, body: promptText.trim() });
    if (r.error) { toast(r.error.message); return; }
    setPromptText(""); toast("Prompt posted. It shows at the top of Home."); loadPrompts(); bump();
  }
  async function delPrompt(pr) {
    if (!confirm("Delete this prompt? Answers stay as normal posts.")) return;
    const r = await sb.from("prompts").delete().eq("id", pr.id);
    toast(r.error ? r.error.message : "Prompt deleted"); loadPrompts(); bump();
  }
  const [list, setList] = useState(null);
  const [invites, setInvites] = useState([]);
  const [code, setCode] = useState("");
  const [err, setErr] = useState(false);
  const [used, setUsed] = useState(null);
  useEffect(function () {
    sb.rpc("storage_usage").then(function (r) { if (!r.error && r.data != null) setUsed(Number(r.data)); }).catch(function () {});
  }, []);
  const load = useCallback(async function () {
    const res = await Promise.all([
      sb.from("profiles").select("*").order("created_at"),
      sb.from("settings").select("invite_code").eq("id", 1).maybeSingle(),
      sb.from("invites").select("*").is("used_at", null).gte("expires_at", new Date().toISOString()).order("created_at", { ascending: false })
    ]);
    if (res[0].error) { setErr(true); return; }
    setErr(false);
    setList(res[0].data || []);
    setCode((res[1].data || {}).invite_code || "");
    setInvites(res[2].data || []);
  }, []);
  useEffect(function () { load(); }, [load]);

  async function setStatus(id, status) {
    const r = await sb.rpc("set_member_status", { target: id, new_status: status });
    toast(r.error ? r.error.message : "Done");
    await load(); reloadProfiles(); bump();
  }
  async function saveCode() {
    const c = code.trim();
    if (c.length < 6) { toast("Please use at least 6 characters."); return; }
    const r = await sb.from("settings").update({ invite_code: c }).eq("id", 1);
    toast(r.error ? r.error.message : "Family code saved");
  }
  async function revoke(inv) {
    const r = await sb.from("invites").delete().eq("id", inv.id);
    toast(r.error ? r.error.message : "Invite cancelled");
    load();
  }
  async function reshare(inv) {
    const res = await sendInviteText(inv.code, me.display_name, daysUntil(inv.expires_at));
    if (res === "copied") toast("Invite copied. Paste it into a text or email.");
  }

  if (err && !list) return html`<div><${TopBar} title="Manage your circle" back=${back} /><${Failed} what="the organizer tools" onRetry=${load} /></div>`;
  const pending = (list || []).filter(function (p) { return p.status === "pending"; });
  const approved = (list || []).filter(function (p) { return p.status === "approved" && p.id !== me.id; });
  return html`
    <div>
      <${TopBar} title="Manage your circle" back=${back} />
      <div style=${{ padding: "1rem" }}>
        <h2 className="serif sec">Waiting to be welcomed (${pending.length})</h2>
        ${!pending.length && html`<div className="muted" style=${{ fontSize: ".85rem" }}>Nobody is waiting.</div>`}
        ${pending.map(function (p) {
          return html`<div className="row" key=${p.id} style=${{ margin: ".5rem 0" }}><div className="grow" style=${{ fontWeight: 600 }}>${nm(p)}</div>
            <button className="btn sm" onClick=${function () { setStatus(p.id, "approved"); }}>Welcome</button>
            <button className="btn sm danger" onClick=${function () { setStatus(p.id, "removed"); }}>No</button></div>`;
        })}

        <h2 className="serif sec">Family news</h2>
        <div className="muted" style=${{ fontSize: ".8rem", marginBottom: ".5rem" }}>Post an update with text, a voice memo, or both. It shows at the top of everyone's Home.</div>
        <button className="btn block grey" onClick=${function () { push({ name: "news" }); }}>Post family news</button>

        <h2 className="serif sec">Family prompts</h2>
        <div className="muted" style=${{ fontSize: ".8rem", marginBottom: ".5rem" }}>Ask everyone to "add yours", like "Share your favorite holiday dish".</div>
        <div className="row"><input className="field" aria-label="New prompt" maxLength="140" placeholder="Share your favorite..." value=${promptText} onChange=${function (e) { setPromptText(e.target.value); }} /><button className="btn" disabled=${!promptText.trim()} onClick=${postPrompt}>Post</button></div>
        ${prompts.map(function (pr) {
          return html`<div className="row" key=${pr.id} style=${{ margin: ".5rem 0" }}>
            <button className="rowmain" onClick=${function () { push({ name: "prompt", id: pr.id }); }}><div><div style=${{ fontWeight: 600 }}>${pr.body}</div><div className="muted" style=${{ fontSize: ".75rem" }}>${agoLong(pr.created_at)}</div></div></button>
            <button className="linkbtn" style=${{ color: "var(--red)" }} onClick=${function () { delPrompt(pr); }}>Delete</button></div>`;
        })}

        <h2 className="serif sec">Invite links</h2>
        <div className="muted" style=${{ fontSize: ".8rem", marginBottom: ".6rem" }}>Each link works once and expires in 7 days, so a forwarded link cannot let a stranger in later.</div>
        <button className="btn block" onClick=${function () { openInvite(); }}>Invite someone</button>
        ${invites.map(function (inv) {
          return html`<div className="row" key=${inv.id} style=${{ margin: ".6rem 0" }}>
            <div className="grow"><div style=${{ fontWeight: 600 }}>${inv.label || "Invite"}</div><div className="muted" style=${{ fontSize: ".75rem" }}>${"Expires in " + daysUntil(inv.expires_at) + " days"}</div></div>
            <button className="btn sm grey" onClick=${function () { reshare(inv); }}>Share</button>
            <button className="btn sm danger" onClick=${function () { revoke(inv); }}>Cancel</button></div>`;
        })}

        ${used !== null && html`<h2 className="serif sec">Storage</h2>
          <div className="meter" role="img" aria-label=${"Using " + Math.round(used / 1048576) + " megabytes of 1 gigabyte"}><i style=${{ width: Math.min(100, used / 10737418.24) + "%" }}></i></div>
          <div className="muted" style=${{ fontSize: ".8rem", marginTop: ".3rem" }}>${used < 1048576 * 1000 ? Math.round(used / 1048576) + " MB" : (used / 1073741824).toFixed(2) + " GB"} of 1 GB used (the free plan limit). ${used > 858993459 ? "Getting full. Consider upgrading in Supabase." : ""}</div>`}

        <${BackupSection} />

        <h2 className="serif sec">Family code</h2>
        <div className="muted" style=${{ fontSize: ".8rem", marginBottom: ".5rem" }}>Anyone who types this code is let in right away, so share it carefully. Change it any time to close that door.</div>
        <div className="row"><input className="field" value=${code} onChange=${function (e) { setCode(e.target.value); }} aria-label="Family code" autoCapitalize="characters" /><button className="btn" onClick=${saveCode}>Save</button></div>

        <h2 className="serif sec">Members</h2>
        ${!approved.length && html`<div className="muted" style=${{ fontSize: ".85rem" }}>Just you so far.</div>`}
        ${approved.map(function (p) {
          return html`<div className="row" key=${p.id} style=${{ margin: ".4rem 0" }}><div className="grow">${nm(p)}${p.relation ? html`<span className="muted"> · ${p.relation}</span>` : ""}</div>
            <button className="linkbtn" style=${{ color: "var(--red)" }} onClick=${function () { if (confirm("Remove " + nm(p) + " from Inner Circle?")) setStatus(p.id, "removed"); }}>Remove</button></div>`;
        })}
      </div>
    </div>`;
}

/* =====================  memories  ===================== */
function Memories() {
  const { tick } = useApp();
  const [view, setView] = useState("day");
  const [posts, setPosts] = useState(null);
  const [err, setErr] = useState(false);
  const load = useCallback(async function () {
    const r = await sb.from("posts").select("id,created_at").order("created_at", { ascending: false }).limit(3000);
    if (r.error) { setErr(true); return; }
    setErr(false);
    const now = new Date();
    const ids = (r.data || []).filter(function (p) {
      const d = new Date(p.created_at);
      return d.getMonth() === now.getMonth() && d.getDate() === now.getDate() && d.getFullYear() < now.getFullYear();
    }).map(function (p) { return p.id; });
    if (!ids.length) { setPosts([]); return; }
    const full = await sb.from("posts").select("*, comments(id), hearts(user_id)").in("id", ids).order("created_at", { ascending: false });
    setPosts(full.data || []);
  }, []);
  useEffect(function () { load(); }, [load, tick]);
  const header = html`<div><div className="top"><div><h1 className="serif" style=${{ color: "#0879a0", fontSize: "1.7rem" }}>Memories</h1></div></div>
    <div className="seg" role="tablist"><button role="tab" aria-selected=${view === "day"} className=${view === "day" ? "on" : ""} onClick=${function () { setView("day"); }}>On this day</button><button role="tab" aria-selected=${view === "albums"} className=${view === "albums" ? "on" : ""} onClick=${function () { setView("albums"); }}>Albums</button></div></div>`;
  if (view === "albums") return html`<div>${header}<${AlbumsList} /></div>`;
  if (err && !posts) return html`<div>${header}<${Failed} what="your memories" onRetry=${load} /></div>`;
  return html`
    <div>
      ${header}
      <div className="muted" style=${{ padding: "0 1rem .6rem", fontSize: ".85rem" }}>Moments your Inner Circle shared on this date in years past.</div>
      ${!posts && html`<div className="center muted" style=${{ padding: "3rem" }}>Looking back...</div>`}
      ${posts && posts.length === 0 && html`<div className="center muted" style=${{ padding: "3rem 1.5rem" }}>Nothing from this date yet. Keep sharing and this page will fill with memories.</div>`}
      ${(posts || []).map(function (p) { return html`<${PostCard} key=${p.id} post=${p} onChange=${load} />`; })}
    </div>`;
}

/* =====================  activity  ===================== */
async function fetchActivity(me) {
  const res = await Promise.all([
    sb.from("comments").select("id,post_id,author_id,body,created_at,posts!inner(author_id,image_path)").eq("posts.author_id", me.id).neq("author_id", me.id).order("created_at", { ascending: false }).limit(30),
    sb.from("hearts").select("post_id,user_id,created_at,posts!inner(author_id,image_path)").eq("posts.author_id", me.id).neq("user_id", me.id).order("created_at", { ascending: false }).limit(30),
    sb.from("hellos").select("id,from_id,message,created_at").eq("to_id", me.id).order("created_at", { ascending: false }).limit(30)
  ]);
  if (res[0].error && res[1].error && res[2].error) throw new Error("activity");
  const items = [];
  (res[0].data || []).forEach(function (c) { items.push({ k: "c" + c.id, kind: "comment", who: c.author_id, post: c.post_id, img: c.posts && c.posts.image_path, text: c.body || "Sent a GIF", at: c.created_at }); });
  (res[1].data || []).forEach(function (h) { items.push({ k: "h" + h.post_id + h.user_id, kind: "heart", who: h.user_id, post: h.post_id, img: h.posts && h.posts.image_path, at: h.created_at }); });
  (res[2].data || []).forEach(function (h) { items.push({ k: "x" + h.id, kind: "hello", who: h.from_id, text: h.message, at: h.created_at }); });
  items.sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
  return items.slice(0, 40);
}

function Activity() {
  const { me, profiles, push, back, clearUnread } = useApp();
  const [items, setItems] = useState(null);
  const [err, setErr] = useState(false);
  const load = useCallback(function () {
    fetchActivity(me).then(function (r) { setErr(false); setItems(r); lsSet("ic-activity-seen", String(Date.now())); clearUnread(); }).catch(function () { setErr(true); });
  }, []);
  useEffect(function () { load(); }, [load]);
  const urls = useUrls((items || []).map(function (a) { return a.img; }));
  return html`<div><${TopBar} title="Activity" back=${back} />
    ${err && !items && html`<${Failed} what="your activity" onRetry=${load} />`}
    ${!items && !err && html`<div className="center muted" style=${{ padding: "3rem" }}>Loading...</div>`}
    ${items && items.length === 0 && html`<div className="center muted" style=${{ padding: "3rem 1.5rem" }}>Hearts, comments and hellos from your Inner Circle will show up here.</div>`}
    ${(items || []).map(function (a) {
      const name = nm(profiles[a.who]);
      const line = a.kind === "hello" ? " says hello" + (a.text ? ": " + a.text : ".") : a.kind === "heart" ? " loved your post." : " commented: " + a.text;
      const u = urls(a.img);
      return html`<button className="listrow" key=${a.k} onClick=${function () { a.kind === "comment" ? push({ name: "comments", postId: a.post }) : a.post ? push({ name: "post", id: a.post }) : push({ name: "profile", userId: a.who }); }}>
        <${Avatar} id=${a.who} name=${name} size=${44} />
        <div className="grow" style=${{ fontSize: ".9rem", overflowWrap: "anywhere" }}><b style=${{ fontWeight: 600 }}>${name}</b>${line} <span className="muted">${agoShort(a.at)}</span></div>
        ${u && html`<img src=${u} alt="" className="athumb" />`}
      </button>`;
    })}</div>`;
}

/* =====================  settings / edit profile  ===================== */
function Settings() {
  const { me, toast, back, reloadProfiles, reloadMe, easy, setEasy, push } = useApp();
  const installable = useInstallable();
  const [name, setName] = useState(me.display_name || "");
  const [relation, setRelation] = useState(me.relation || "");
  const [bio, setBio] = useState(me.bio || "");
  const [bm, setBm] = useState(me.birth_month || 0);
  const [bd, setBd] = useState(me.birth_day || 0);
  const [busy, setBusy] = useState(false);
  const [arch, setArch] = useState("");
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushErr, setPushErr] = useState("");
  useEffect(function () { pushIsOn().then(setPushOn); }, []);
  async function togglePush() {
    setPushBusy(true); setPushErr("");
    try {
      if (pushOn) { await pushDisable(); setPushOn(false); toast("Notifications are off on this phone."); }
      else {
        const r = await pushEnable();
        if (r === "granted") { setPushOn(true); toast("Notifications are on."); }
        else { toast("Your phone blocked notifications."); setPushErr("Your phone is blocking notifications for Inner Circle" + (isIOS() ? ". On iPhone: Settings, Notifications, Inner Circle, Allow Notifications." : ". On Android: long-press the Inner Circle icon, App info, Notifications, turn on. If you use it in Chrome instead of the installed app: Chrome menu, Settings, Site settings, Notifications, allow this site.")); }
      }
    } catch (e) { toast("Could not turn on notifications."); setPushErr(pushWhy(e)); }
    setPushBusy(false);
  }
  const [curPhone, setCurPhone] = useState(null);
  const [newPhone, setNewPhone] = useState("");
  const [phStep, setPhStep] = useState("idle");
  const [phCode, setPhCode] = useState("");
  const [phBusy, setPhBusy] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const photoInput = useRef(null);
  async function pickPhoto(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setPhotoBusy(true);
    let path = null;
    try {
      const blob = await shrink(file, 700);
      path = me.id + "/avatar-" + (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now()) + ".jpg";
      const up = await sb.storage.from("photos").upload(path, blob, { contentType: "image/jpeg" });
      if (up.error) throw up.error;
      const r = await sb.from("profiles").update({ avatar_path: path }).eq("id", me.id);
      if (r.error) throw r.error;
      if (me.avatar_path) sb.storage.from("photos").remove([me.avatar_path]);
      toast("Profile photo updated");
      await reloadMe();
      reloadProfiles();
    } catch (err) {
      if (path) sb.storage.from("photos").remove([path]);
      toast((err && err.message) || "Could not update your photo.");
    }
    setPhotoBusy(false);
  }
  async function removePhoto() {
    if (!me.avatar_path) return;
    setPhotoBusy(true);
    const r = await sb.from("profiles").update({ avatar_path: null }).eq("id", me.id);
    if (!r.error) { sb.storage.from("photos").remove([me.avatar_path]); await reloadMe(); reloadProfiles(); toast("Photo removed"); }
    else toast(r.error.message);
    setPhotoBusy(false);
  }
  useEffect(function () {
    sb.auth.getUser().then(function (r) { setCurPhone((r.data && r.data.user && r.data.user.phone) || ""); }).catch(function () { setCurPhone(""); });
  }, []);
  async function sendPhoneCode() {
    const p = toE164(newPhone);
    if (!p) { toast("Please type your mobile number with area code, like 404 555 0123."); return; }
    setPhBusy(true);
    const r = await sb.auth.updateUser({ phone: p });
    setPhBusy(false);
    if (r.error) { toast(friendlyAuthError(r.error)); return; }
    setPhStep("code");
    toast("We texted you a code.");
  }
  async function confirmPhone() {
    setPhBusy(true);
    const r = await sb.auth.verifyOtp({ phone: toE164(newPhone), token: phCode.trim(), type: "phone_change" });
    setPhBusy(false);
    if (r.error) { toast("That code did not work. Check the text and try again."); return; }
    setCurPhone(toE164(newPhone));
    setPhStep("idle");
    setPhCode("");
    toast("Done. You can now sign in with a text code.");
  }
  async function doArchive() {
    try {
      const c = await downloadArchive(me, {}, setArch);
      toast(c ? "Saved " + c + (c === 1 ? " moment" : " moments") + " to your downloads" : "You have not shared anything yet.");
    } catch (e) { toast((e && e.message) || "Could not make the archive. Try again."); }
    setArch("");
  }

  async function save() {
    const n = name.trim();
    if (!n) { toast("Your name cannot be empty."); return; }
    if ((bm && !bd) || (!bm && bd)) { toast("Pick both the month and the day for your birthday."); return; }
    setBusy(true);
    const r = await sb.from("profiles").update({ display_name: n, relation: relation.trim(), bio: bio.trim() }).eq("id", me.id);
    if (!r.error && bm && bd && (bm !== me.birth_month || bd !== me.birth_day)) {
      const b = await sb.rpc("set_birthday", { target: me.id, m: bm, d: Math.min(bd, DIM[bm - 1]) });
      if (b.error) { setBusy(false); toast(b.error.message); return; }
    }
    setBusy(false);
    if (r.error) { toast(r.error.message); return; }
    toast("Profile saved");
    await reloadMe();
    reloadProfiles();
  }

  return html`
    <div>
      <${TopBar} title="Edit profile" back=${back} right=${html`<button className="tbtn" onClick=${save} disabled=${busy}>Save</button>`} />
      <div className="center" style=${{ padding: "1.2rem 1rem .2rem" }}>
        <input ref=${photoInput} type="file" accept="image/*" onChange=${pickPhoto} style=${{ display: "none" }} />
        <button aria-label="Change profile photo" onClick=${function () { photoInput.current.click(); }} disabled=${photoBusy} style=${{ background: "none", border: 0, padding: 0, cursor: "pointer", position: "relative" }}>
          <${Avatar} id=${me.id} name=${me.display_name} size=${96} />
          <span className="camera" aria-hidden="true"><${Icon} n="camera" s=${16} sw=${2} color="#fff" /></span>
        </button>
        <div style=${{ marginTop: ".4rem" }}>
          <button className="linkbtn" disabled=${photoBusy} onClick=${function () { photoInput.current.click(); }}>${photoBusy ? "Saving..." : me.avatar_path ? "Change photo" : "Add a profile photo"}</button>
          ${me.avatar_path && html`<button className="linkbtn" style=${{ color: "var(--muted)", fontWeight: 500 }} disabled=${photoBusy} onClick=${removePhoto}>Remove</button>`}
        </div>
      </div>
      <div style=${{ padding: "1rem" }}>
        <label htmlFor="s-name" className="flabel">Name</label>
        <input id="s-name" className="field" value=${name} onChange=${function (e) { setName(e.target.value); }} maxLength="60" autoComplete="name" />
        <label htmlFor="s-rel" className="flabel">How you are related</label>
        <input id="s-rel" className="field" value=${relation} onChange=${function (e) { setRelation(e.target.value); }} maxLength="60" placeholder="Example: Troy's mom, or Troy's old friend" />
        <div className="muted" style=${{ fontSize: ".75rem", marginTop: ".3rem" }}>Everyone sees this next to your name, so people know who you are.</div>
        <label htmlFor="s-bio" className="flabel">About you</label>
        <textarea id="s-bio" className="field" rows="3" maxLength="300" value=${bio} onChange=${function (e) { setBio(e.target.value); }} placeholder="Where you live, what you love, how to say hello..."></textarea>
        <div className="flabel">Birthday (no year, so family can celebrate you)</div>
        <${MonthDay} idp="s-bd" m=${bm} d=${bd} onM=${setBm} onD=${setBd} />
      </div>
      <button className="listrow" style=${{ borderTop: "1px solid var(--soft)" }} onClick=${function () { push({ name: "prefs" }); }}>
        <div className="grow"><div style=${{ fontWeight: 600 }}>Get to know me</div><div className="muted" style=${{ fontSize: ".8rem" }}>Favorites, loves and this-or-that picks</div></div>
        <${Icon} n="chev" s=${20} sw=${2} color="#6b6b6b" />
      </button>
      <div style=${{ padding: "1rem", borderTop: "1px solid var(--soft)" }}>
        <div style=${{ fontWeight: 600 }}>Sign in with your phone</div>
        ${curPhone ? html`<div className="muted" style=${{ fontSize: ".85rem", marginTop: ".2rem" }}>Texts go to ${curPhone}. Use "Text me a code" on the sign-in screen.</div>`
          : curPhone === null ? html`<div className="muted" style=${{ fontSize: ".85rem" }}>Checking...</div>`
          : html`<div>
            <div className="muted" style=${{ fontSize: ".85rem", margin: ".2rem 0 .5rem" }}>Add your mobile number to sign in with a texted code.</div>
            ${phStep === "idle" ? html`<div className="row">
                <label className="sr" htmlFor="s-phone">Mobile number</label>
                <input id="s-phone" className="field" type="tel" inputMode="tel" autoComplete="tel" placeholder="Mobile number" value=${newPhone} onChange=${function (e) { setNewPhone(e.target.value); }} />
                <button className="btn" disabled=${phBusy || !newPhone.trim()} onClick=${sendPhoneCode}>Text me</button></div>`
              : html`<div className="row">
                <label className="sr" htmlFor="s-code">Code from the text</label>
                <input id="s-code" className="field" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength="8" placeholder="123456" value=${phCode} onChange=${function (e) { setPhCode(e.target.value); }} />
                <button className="btn" disabled=${phBusy || !phCode.trim()} onClick=${confirmPhone}>Confirm</button></div>
                <div style=${{ marginTop: ".3rem" }}><button className="linkbtn" style=${{ fontWeight: 500 }} onClick=${function () { setPhStep("idle"); }}>Wrong number?</button></div>`}
          </div>`}
      </div>
      ${pushCanWork() && html`<div className="opt" style=${{ borderTop: "1px solid var(--soft)" }}>
        <div className="grow"><div style=${{ fontWeight: 600 }}>Notifications</div>
          <div className="muted" style=${{ fontSize: ".8rem" }}>${pushNeedsInstall() ? "On iPhone, first add Inner Circle to your home screen (Share, then Add to Home Screen), open it from there, then come back here." : pushOn ? "On. You will be told when family shares, comments or says hello." : "Get a buzz when family shares, comments or says hello."}</div></div>
        <button role="switch" aria-checked=${pushOn} aria-label="Notifications" disabled=${pushBusy || pushNeedsInstall()} className=${"switch " + (pushOn ? "on" : "")} onClick=${togglePush}><i></i></button>
      </div>
      ${pushErr && html`<div role="alert" style=${{ margin: "0 1rem .8rem", padding: ".7rem .9rem", borderRadius: ".7rem", background: "#ffe1d8", color: "#7a2a10", fontSize: ".85rem" }}>${pushErr}</div>`}`}
      <div className="opt" style=${{ borderTop: "1px solid var(--soft)" }}>
        <div className="grow"><div style=${{ fontWeight: 600 }}>Larger text</div><div className="muted" style=${{ fontSize: ".8rem" }}>Bigger words and buttons</div></div>
        <button role="switch" aria-checked=${easy} aria-label="Larger text" className=${"switch " + (easy ? "on" : "")} onClick=${function () { setEasy(!easy); }}><i></i></button>
      </div>
      ${!isStandalone() && html`<div className="opt">
        <div className="grow"><div style=${{ fontWeight: 600 }}>Put it on your home screen</div>
          <div className="muted" style=${{ fontSize: ".8rem" }}>${installable ? "One tap to install." : isIOS() ? "In Safari tap Share, then Add to Home Screen. Then open it from there and sign in once more." : "In Chrome tap the three dots, then Install app."}</div></div>
        ${installable && html`<button className="btn sm" onClick=${runInstall}>Install</button>`}
      </div>`}
      <div className="opt">
        <div className="grow"><div style=${{ fontWeight: 600 }}>Download my moments</div>
          <div className="muted" style=${{ fontSize: ".8rem" }}>${arch || "Your photos and words, saved as one file on your phone."}</div></div>
        <button className="btn sm grey" disabled=${!!arch} onClick=${doArchive}>Download</button>
      </div>
      <div className="promise">
        <h3 className="serif" style=${{ color: "#0879a0" }}>Our promises</h3>
        <ul>
          <li>Only invited family and friends. Never the public.</li>
          <li>Newest first. No algorithm deciding what you see.</li>
          <li>No ads, no tracking, no selling anything.</li>
          <li>Your photos stay in a private vault that only your Inner Circle can open.</li>
        </ul>
      </div>
      <div style=${{ padding: "1rem" }}><button className="btn grey block" onClick=${signOutClean}>Sign out</button></div>
    </div>`;
}

/* =====================  groups, notes, prompts, news, albums  ===================== */
function Check({ on, label, sub, onClick }) {
  return html`<button type="button" className=${"check" + (on ? " on" : "")} role="checkbox" aria-checked=${on} onClick=${onClick}>
    <span className="box" aria-hidden="true">${on ? "✓" : ""}</span><span className="grow"><b style=${{ fontWeight: 600 }}>${label}</b>${sub ? html`<span className="muted" style=${{ fontSize: ".8rem", display: "block" }}>${sub}</span>` : ""}</span></button>`;
}
function approvedOthers(profiles, me) {
  return Object.keys(profiles).map(function (k) { return profiles[k]; }).filter(function (p) { return p.status === "approved" && p.id !== me.id; })
    .sort(function (a, b) { return nm(a).localeCompare(nm(b)); });
}

function AudienceSheet({ value, onChange, onClose }) {
  const { me, profiles } = useApp();
  const [groups, setGroups] = useState(null);
  const [mode, setMode] = useState(value.mode);
  const [gid, setGid] = useState(value.groupId);
  const [ex, setEx] = useState(value.except);
  useEffect(function () {
    sb.from("groups").select("*, group_members(user_id)").eq("owner_id", me.id).order("created_at").then(function (r) { setGroups(r.data || []); }).catch(function () { setGroups([]); });
  }, []);
  const people = approvedOthers(profiles, me);
  function done() {
    const g = (groups || []).find(function (x) { return x.id === gid; });
    if (mode === "group" && g) onChange({ mode: "group", groupId: g.id, groupName: g.name, except: [] });
    else if (mode === "except" && ex.length) onChange({ mode: "except", groupId: null, groupName: "", except: ex });
    else onChange({ mode: "all", groupId: null, groupName: "", except: [] });
    onClose();
  }
  return html`<${Sheet} title="Who can see this?" onClose=${onClose}>
    <${Check} on=${mode === "all"} label="Everyone in your Inner Circle" onClick=${function () { setMode("all"); }} />
    ${(groups || []).map(function (g) {
      return html`<${Check} key=${g.id} on=${mode === "group" && gid === g.id} label=${g.name + " only"} sub=${g.group_members.length + " " + (g.group_members.length === 1 ? "person" : "people")} onClick=${function () { setMode("group"); setGid(g.id); }} />`;
    })}
    ${groups && groups.length === 0 && html`<div className="muted" style=${{ fontSize: ".85rem", padding: ".4rem .2rem" }}>You have no groups yet. Make one under People, then My groups.</div>`}
    <${Check} on=${mode === "except"} label="Everyone except..." sub="Good for surprises" onClick=${function () { setMode("except"); }} />
    ${mode === "except" && html`<div className="plist">${people.map(function (p) {
      const on = ex.indexOf(p.id) >= 0;
      return html`<${Check} key=${p.id} on=${on} label=${nm(p)} onClick=${function () { setEx(on ? ex.filter(function (x) { return x !== p.id; }) : ex.concat([p.id])); }} />`;
    })}</div>`}
    <button className="btn block" style=${{ marginTop: ".8rem" }} disabled=${mode === "group" && !gid} onClick=${done}>Done</button>
  </${Sheet}>`;
}

function GroupsScreen() {
  const { me, profiles, toast, back, bump } = useApp();
  const [groups, setGroups] = useState(null);
  const [err, setErr] = useState(false);
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async function () {
    const r = await sb.from("groups").select("*, group_members(user_id)").eq("owner_id", me.id).order("created_at");
    if (r.error) { setErr(true); return; }
    setErr(false); setGroups(r.data || []);
  }, []);
  useEffect(function () { load(); }, [load]);
  const people = approvedOthers(profiles, me);

  async function save() {
    const name = edit.name.trim();
    if (!name) { toast("Give the group a name."); return; }
    setBusy(true);
    try {
      let id = edit.id;
      if (id) {
        const u = await sb.from("groups").update({ name: name }).eq("id", id);
        if (u.error) throw u.error;
        const gone = (edit.orig || []).filter(function (u) { return edit.members.indexOf(u) < 0; });
        for (let i = 0; i < gone.length; i++) {
          const d = await sb.from("group_members").delete().match({ group_id: id, user_id: gone[i] });
          if (d.error) throw d.error;
        }
      } else {
        id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now());
        const c = await sb.from("groups").insert({ id: id, owner_id: me.id, name: name });
        if (c.error) throw c.error;
      }
      const added = edit.members.filter(function (u) { return (edit.orig || []).indexOf(u) < 0; });
      if (added.length) {
        const m = await sb.from("group_members").insert(added.map(function (u) { return { group_id: id, user_id: u }; }));
        if (m.error) throw m.error;
      }
      setEdit(null); toast("Group saved"); await load(); bump();
    } catch (e) { toast((e && e.message) || "Could not save the group."); }
    setBusy(false);
  }
  async function del(g) {
    if (!confirm("Delete the group " + g.name + "? Posts shared only with it stay hidden from everyone but you.")) return;
    const r = await sb.from("groups").delete().eq("id", g.id);
    toast(r.error ? r.error.message : "Group deleted"); load(); bump();
  }
  return html`<div><${TopBar} title="My groups" back=${back} />
    <div style=${{ padding: "1rem" }}>
      <p className="muted" style=${{ marginTop: 0, fontSize: ".9rem" }}>Make a small group, like Siblings or Grandkids, and choose it when you share a post. Only you can see your groups and who is in them.</p>
      <button className="btn block" onClick=${function () { setEdit({ id: null, name: "", members: [] }); }}>Make a new group</button>
      ${err && !groups && html`<${Failed} what="your groups" onRetry=${load} />`}
      ${(groups || []).map(function (g) {
        return html`<div className="row" key=${g.id} style=${{ margin: ".8rem 0" }}>
          <div className="grow"><div style=${{ fontWeight: 600 }}>${g.name}</div><div className="muted" style=${{ fontSize: ".8rem" }}>${g.group_members.map(function (m) { return nm(profiles[m.user_id]); }).join(", ") || "No one yet"}</div></div>
          <button className="btn sm grey" onClick=${function () { const cur = g.group_members.map(function (m) { return m.user_id; }); setEdit({ id: g.id, name: g.name, members: cur, orig: cur }); }}>Edit</button>
          <button className="btn sm danger" onClick=${function () { del(g); }}>Delete</button></div>`;
      })}
    </div>
    ${edit && html`<${Sheet} title=${edit.id ? "Edit group" : "New group"} onClose=${function () { setEdit(null); }}>
      <label className="sr" htmlFor="g-name">Group name</label>
      <input id="g-name" className="field" maxLength="40" placeholder="Example: Siblings" value=${edit.name} onChange=${function (e) { const v = e.target.value; setEdit(function (o) { return Object.assign({}, o, { name: v }); }); }} />
      <div style=${{ fontWeight: 600, margin: ".8rem 0 .2rem" }}>Who is in it?</div>
      <div className="plist">${people.map(function (p) {
        const on = edit.members.indexOf(p.id) >= 0;
        return html`<${Check} key=${p.id} on=${on} label=${nm(p)} sub=${p.relation} onClick=${function () { setEdit(function (o) { return Object.assign({}, o, { members: on ? o.members.filter(function (x) { return x !== p.id; }) : o.members.concat([p.id]) }); }); }} />`;
      })}</div>
      <div className="row" style=${{ marginTop: ".8rem" }}><button className="btn grey grow" onClick=${function () { setEdit(null); }}>Cancel</button><button className="btn grow" disabled=${busy} onClick=${save}>Save</button></div>
    </${Sheet}>`}
  </div>`;
}

/* ---- Notes ---- */
function NoteSheet({ target, onClose, onDone }) {
  const { me, profiles, toast } = useApp();
  const n = target.note;
  const [text, setText] = useState(target.own && n ? n.body : "");
  const [busy, setBusy] = useState(false);
  async function saveNote() {
    const b = text.trim();
    if (!b) return;
    setBusy(true);
    const r = await sb.from("notes").upsert({ user_id: me.id, body: b, created_at: new Date().toISOString() });
    setBusy(false);
    if (r.error) { toast(r.error.message); return; }
    toast("Note shared for 24 hours"); await onDone(); onClose();
  }
  async function delNote() {
    const r = await sb.from("notes").delete().eq("user_id", me.id);
    toast(r.error ? r.error.message : "Note removed"); await onDone(); onClose();
  }
  async function reply(msg) {
    setBusy(true);
    const r = await sb.from("hellos").insert({ from_id: me.id, to_id: n.user_id, message: msg });
    setBusy(false);
    if (r.error) { toast(r.error.message); return; }
    toast("Sent to " + nm(profiles[n.user_id])); onClose();
  }
  if (target.own) {
    return html`<${Sheet} title="Your note" onClose=${onClose}>
      <p className="muted" style=${{ marginTop: 0, fontSize: ".9rem" }}>A short thought everyone can see for 24 hours.</p>
      <label className="sr" htmlFor="note-in">Your note</label>
      <input id="note-in" className="field" maxLength="60" placeholder="What is on your mind?" value=${text} onChange=${function (e) { setText(e.target.value); }} />
      <div className="muted" style=${{ fontSize: ".75rem", textAlign: "right" }}>${text.length}/60</div>
      <div className="row" style=${{ marginTop: ".6rem" }}>${n && html`<button className="btn danger" onClick=${delNote}>Remove</button>`}<button className="btn grow" disabled=${busy || !text.trim()} onClick=${saveNote}>Share note</button></div>
    </${Sheet}>`;
  }
  return html`<${Sheet} title=${nm(profiles[n.user_id])} onClose=${onClose}>
    <div className="bigbub">${n.body}</div>
    <div className="muted" style=${{ fontSize: ".75rem", margin: ".3rem 0 .8rem" }}>${agoLong(n.created_at)}</div>
    <button className="sheetbtn" disabled=${busy} onClick=${function () { reply("Loved your note: " + n.body); }}>Send a heart</button>
    <div className="row" style=${{ marginTop: ".6rem" }}>
      <label className="sr" htmlFor="note-reply">Reply</label>
      <input id="note-reply" className="field" maxLength="120" placeholder="Reply..." value=${text} onChange=${function (e) { setText(e.target.value); }} />
      <button className="btn" disabled=${busy || !text.trim()} onClick=${function () { reply("Re: your note “" + n.body + "”. " + text.trim()); }}>Send</button></div>
  </${Sheet}>`;
}

/* ---- Family prompts ("Add yours") ---- */
function PromptCard({ prompt, answers }) {
  const { me, push } = useApp();
  const done = answers.some(function (a) { return a.author_id === me.id; });
  return html`<div className=${"pcard slim" + (done ? " tiny" : "")}>
    <div className="grow"><div className="pk">${done ? "Family question" : "Add yours"}${answers.length > 0 ? " · " + answers.length + (answers.length === 1 ? " answer" : " answers") : ""}</div>
      <div className="pt"><${Linkify} text=${prompt.body} /></div></div>
    ${done ? html`<button className="btn sm grey" onClick=${function () { push({ name: "prompt", id: prompt.id }); }}>See ${answers.length}</button>`
      : html`<button className="btn sm" onClick=${function () { push({ name: "new", promptId: prompt.id, promptText: prompt.body }); }}>Add yours</button>`}
  </div>`;
}

function PromptScreen({ id }) {
  const { me, profiles, back, push, tick } = useApp();
  const [prompt, setPrompt] = useState(undefined);
  const [posts, setPosts] = useState(null);
  const [err, setErr] = useState(false);
  const load = useCallback(async function () {
    const res = await Promise.all([
      sb.from("prompts").select("*").eq("id", id).maybeSingle(),
      sb.from("posts").select("*, comments(id), hearts(user_id)").eq("prompt_id", id).order("created_at", { ascending: true })
    ]);
    if (res[1].error) { setErr(true); return; }
    setErr(false); setPrompt(res[0].data || null); setPosts(res[1].data || []);
  }, [id]);
  useEffect(function () { load(); }, [load, tick]);
  const done = (posts || []).some(function (p) { return p.author_id === me.id; });
  const waiting = me.role === "admin" && posts ? approvedOthers(profiles, me).concat([me]).filter(function (p) { return !posts.some(function (x) { return x.author_id === p.id; }); }) : [];
  return html`<div><${TopBar} title="Add yours" back=${back} />
    ${err && !posts && html`<${Failed} what="this prompt" onRetry=${load} />`}
    ${prompt && html`<div className="pcard" style=${{ margin: "1rem" }}><div className="pk">Family prompt</div><div className="pt">${prompt.body}</div>
      ${!done && html`<button className="btn block" style=${{ marginTop: ".8rem" }} onClick=${function () { push({ name: "new", promptId: prompt.id, promptText: prompt.body }); }}>Add yours</button>`}</div>`}
    ${prompt === null && html`<div className="center muted" style=${{ padding: "3rem 1rem" }}>This prompt is no longer here.</div>`}
    ${waiting.length > 0 && html`<div className="muted" style=${{ padding: "0 1rem .8rem", fontSize: ".85rem" }}>Still to share (only you see this): ${waiting.map(nm).join(", ")}</div>`}
    ${posts && posts.length === 0 && prompt && html`<div className="center muted" style=${{ padding: "2rem 1rem" }}>No answers yet. Be the first.</div>`}
    ${(posts || []).map(function (p) { return html`<${PostCard} key=${p.id} post=${p} onChange=${load} />`; })}
  </div>`;
}

/* ---- Family news (text and/or voice memo) ---- */
function VoiceRecorder({ value, onChange }) {
  const { toast } = useApp();
  const [recording, setRecording] = useState(false);
  const [sec, setSec] = useState(0);
  const rec = useRef(null);
  const timer = useRef(null);
  const chunks = useRef([]);
  const started = useRef(0);
  const stream = useRef(null);
  useEffect(function () {
    return function () {
      clearInterval(timer.current);
      try { if (rec.current && rec.current.state !== "inactive") { rec.current.onstop = null; rec.current.stop(); } } catch (e) {}
      try { if (stream.current) stream.current.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    };
  }, []);
  async function start() {
    if (!navigator.mediaDevices || !window.MediaRecorder) { toast("This phone cannot record voice here."); return; }
    try { stream.current = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { toast("Please allow the microphone to record."); return; }
    const types = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"];
    const mime = types.find(function (t) { return MediaRecorder.isTypeSupported(t); }) || "";
    const r = new MediaRecorder(stream.current, Object.assign({ audioBitsPerSecond: 48000 }, mime ? { mimeType: mime } : {}));
    chunks.current = [];
    r.ondataavailable = function (e) { if (e.data && e.data.size) chunks.current.push(e.data); };
    r.onstop = function () {
      const type = (r.mimeType || mime || "audio/webm").split(";")[0];
      const blob = new Blob(chunks.current, { type: type });
      const seconds = Math.max(1, Math.round((Date.now() - started.current) / 1000));
      stream.current.getTracks().forEach(function (t) { t.stop(); });
      setRecording(false);
      onChange({ blob: blob, seconds: seconds, url: URL.createObjectURL(blob) });
    };
    rec.current = r;
    started.current = Date.now();
    r.start();
    setRecording(true); setSec(0);
    timer.current = setInterval(function () {
      const s = Math.round((Date.now() - started.current) / 1000);
      setSec(s);
      if (s >= MAX_VOICE_S) stop();
    }, 500);
  }
  function stop() { clearInterval(timer.current); if (rec.current && rec.current.state !== "inactive") rec.current.stop(); }
  if (recording) {
    return html`<div className="voice rec"><span className="dot"></span><span className="grow">Recording ${fmtTime(sec)} (up to ${fmtTime(MAX_VOICE_S)})</span><button className="btn sm" onClick=${stop}>Stop</button></div>`;
  }
  if (value) {
    return html`<div className="voice"><audio controls src=${value.url} style=${{ width: "100%" }}></audio>
      <div className="row"><span className="muted grow" style=${{ fontSize: ".8rem" }}>${fmtTime(value.seconds)}, ${fmtSize(value.blob.size)}</span>
      <button className="linkbtn" onClick=${start}>Record again</button><button className="linkbtn" style=${{ color: "var(--muted)", fontWeight: 500 }} onClick=${function () { onChange(null); }}>Remove</button></div></div>`;
  }
  return html`<button className="btn grey block" onClick=${start}><${Icon} n="mic" s=${18} sw=${2} /> Record a voice memo</button>`;
}

function NewsItem({ item, onDeleted }) {
  const { me, profiles, toast } = useApp();
  const urls = useUrls(item.audio_path ? [item.audio_path] : []);
  const a = profiles[item.author_id] || {};
  async function del() {
    if (!confirm("Delete this news post?")) return;
    if (item.audio_path) await sb.storage.from("photos").remove([item.audio_path]);
    const r = await sb.from("news").delete().eq("id", item.id);
    if (r.error) toast(r.error.message); else onDeleted();
  }
  return html`<div className="newsitem">
    <div className="row" style=${{ marginBottom: ".4rem" }}><${Avatar} id=${item.author_id} name=${a.display_name} size=${36} />
      <div className="grow"><b style=${{ fontWeight: 600 }}>${nm(a)}</b><div className="muted" style=${{ fontSize: ".75rem" }}>${agoLong(item.created_at)}</div></div>
      ${me.role === "admin" && html`<button className="linkbtn" style=${{ color: "var(--red)", fontWeight: 500 }} onClick=${del}>Delete</button>`}</div>
    ${item.body && html`<div style=${{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}><${Linkify} text=${item.body} /></div>`}
    ${item.audio_path && html`<div style=${{ marginTop: ".5rem" }}>${urls(item.audio_path) ? html`<audio controls preload="none" src=${urls(item.audio_path)} style=${{ width: "100%" }} aria-label=${"Voice memo from " + nm(a)}></audio>` : html`<div className="muted" style=${{ fontSize: ".85rem" }}>Loading voice memo...</div>`}
      <div className="muted" style=${{ fontSize: ".75rem" }}>Voice memo, ${fmtTime(item.audio_seconds || 0)}</div></div>`}
  </div>`;
}

function NewsCard({ item }) {
  const { push } = useApp();
  const fresh = lsGet("ic-news-seen", "") !== item.id;
  if (!fresh) return html`<button className="newscard tiny" onClick=${function () { push({ name: "news" }); }}>
    <span className="row"><${Icon} n="news" s=${16} sw=${2} color="#0879a0" /><b className="grow" style=${{ color: "#0879a0", fontSize: ".9rem" }}>Family news</b><span className="muted" style=${{ fontSize: ".8rem" }}>Read again</span><${Icon} n="chev" s=${16} sw=${2} color="#6b6b6b" /></span></button>`;
  return html`<button className="newscard" onClick=${function () { push({ name: "news" }); }}>
    <span className="row"><${Icon} n="news" s=${18} sw=${2} color="#0879a0" /><b className="grow" style=${{ color: "#0879a0" }}>Family news</b>${fresh && html`<span className="pill">New</span>`}<${Icon} n="chev" s=${18} sw=${2} color="#6b6b6b" /></span>
    ${item.body && html`<span className="clamp">${item.body}</span>`}
    ${item.audio_path && html`<span className="muted" style=${{ fontSize: ".8rem", display: "block", marginTop: ".2rem" }}>Includes a voice memo</span>`}
  </button>`;
}

function NewsScreen() {
  const { me, toast, back, bump, tick } = useApp();
  const [items, setItems] = useState(null);
  const [err, setErr] = useState(false);
  const [text, setText] = useState("");
  const [voice, setVoice] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async function () {
    const r = await sb.from("news").select("*").order("created_at", { ascending: false }).limit(50);
    if (r.error) { setErr(true); return; }
    setErr(false); setItems(r.data || []);
    if (r.data && r.data[0]) lsSet("ic-news-seen", r.data[0].id);
  }, []);
  useEffect(function () { load(); }, [load, tick]);
  async function post() {
    if (!text.trim() && !voice) { toast("Write something or record a voice memo."); return; }
    setBusy(true);
    let path = null;
    try {
      if (voice) {
        const ext = /mp4/.test(voice.blob.type) ? "m4a" : "webm";
        path = me.id + "/" + ((window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now())) + "." + ext;
        const up = await sb.storage.from("photos").upload(path, voice.blob, { contentType: voice.blob.type || "audio/webm" });
        if (up.error) throw up.error;
      }
      const r = await sb.from("news").insert({ author_id: me.id, body: text.trim(), audio_path: path, audio_seconds: voice ? voice.seconds : null });
      if (r.error) throw r.error;
      setText(""); setVoice(null); toast("Posted to the whole family"); await load(); bump();
    } catch (e) {
      if (path) sb.storage.from("photos").remove([path]);
      toast((e && e.message) || "Could not post.");
    }
    setBusy(false);
  }
  return html`<div><${TopBar} title="Family news" back=${back} />
    ${me.role === "admin" && html`<div style=${{ padding: "1rem", borderBottom: "1px solid var(--soft)" }}>
      <label className="sr" htmlFor="news-text">News</label>
      <textarea id="news-text" className="field" rows="3" maxLength="2000" placeholder="Share news with the whole family..." value=${text} onChange=${function (e) { setText(e.target.value); }}></textarea>
      <div style=${{ margin: ".6rem 0" }}><${VoiceRecorder} value=${voice} onChange=${setVoice} /></div>
      <button className="btn block" disabled=${busy || (!text.trim() && !voice)} onClick=${post}>${busy ? "Posting..." : "Post to the family"}</button></div>`}
    ${err && !items && html`<${Failed} what="the news" onRetry=${load} />`}
    ${items && items.length === 0 && html`<div className="center muted" style=${{ padding: "3rem 1.5rem" }}>No family news yet.${me.role === "admin" ? "" : " The organizer will post updates here."}</div>`}
    ${(items || []).map(function (it) { return html`<${NewsItem} key=${it.id} item=${it} onDeleted=${function () { load(); bump(); }} />`; })}
  </div>`;
}

/* ---- Shared albums ---- */
function AlbumsList() {
  const { me, push, toast, tick, bump } = useApp();
  const [albums, setAlbums] = useState(null);
  const [covers, setCovers] = useState({});
  const [err, setErr] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const load = useCallback(async function () {
    const r = await sb.from("albums").select("*, album_posts(post_id, created_at)").order("created_at", { ascending: false });
    if (r.error) { setErr(true); return; }
    setErr(false); setAlbums(r.data || []);
    const ids = [];
    (r.data || []).forEach(function (a) {
      const last = (a.album_posts || []).slice().sort(function (x, y) { return new Date(y.created_at) - new Date(x.created_at); })[0];
      if (last) ids.push(last.post_id);
    });
    if (ids.length) {
      const p = await sb.from("posts").select("id,image_path").in("id", ids);
      const m = {};
      (p.data || []).forEach(function (x) { m[x.id] = x.image_path; });
      setCovers(m);
    }
  }, []);
  useEffect(function () { load(); }, [load, tick]);
  const paths = (albums || []).map(function (a) {
    const last = (a.album_posts || []).slice().sort(function (x, y) { return new Date(y.created_at) - new Date(x.created_at); })[0];
    return last ? covers[last.post_id] : null;
  });
  const urls = useUrls(paths);
  async function create() {
    const n = name.trim();
    if (!n) return;
    const r = await sb.from("albums").insert({ owner_id: me.id, name: n });
    if (r.error) { toast(r.error.message); return; }
    setName(""); setCreating(false); toast("Album created. Add posts from the ⋯ menu on any post."); load(); bump();
  }
  if (err && !albums) return html`<${Failed} what="the albums" onRetry=${load} />`;
  return html`<div style=${{ padding: "0 1rem 1rem" }}>
    <p className="muted" style=${{ margin: "0 0 .8rem", fontSize: ".85rem" }}>Albums everyone in the family can add to, like a trip, a recipe box or a wedding. Add any post with its ⋯ menu.</p>
    <button className="btn block" onClick=${function () { setCreating(true); }}>New album</button>
    ${!albums && html`<div className="center muted" style=${{ padding: "2rem" }}>Loading...</div>`}
    ${albums && albums.length === 0 && html`<div className="center muted" style=${{ padding: "2rem 1rem" }}>No albums yet. Start one for your next family trip.</div>`}
    <div className="albumgrid">${(albums || []).map(function (a, i) {
      const u = urls(paths[i]);
      return html`<button className="albumcard" key=${a.id} onClick=${function () { push({ name: "album", id: a.id }); }}>
        <div className="cover">${u ? html`<img src=${u} alt="" />` : html`<${Icon} n="album" s=${34} sw=${1.5} color="#6b6b6b" />`}</div>
        <div className="aname">${a.name}</div><div className="muted" style=${{ fontSize: ".75rem" }}>${(a.album_posts || []).length} ${(a.album_posts || []).length === 1 ? "post" : "posts"}</div></button>`;
    })}</div>
    ${creating && html`<${Sheet} title="New album" onClose=${function () { setCreating(false); }}>
      <label className="sr" htmlFor="alb-name">Album name</label>
      <input id="alb-name" className="field" maxLength="60" placeholder="Example: Lake house 2026" value=${name} onChange=${function (e) { setName(e.target.value); }} />
      <div className="row" style=${{ marginTop: ".8rem" }}><button className="btn grey grow" onClick=${function () { setCreating(false); }}>Cancel</button><button className="btn grow" disabled=${!name.trim()} onClick=${create}>Create</button></div>
    </${Sheet}>`}
  </div>`;
}

function AlbumScreen({ id }) {
  const { me, back, toast, tick, bump } = useApp();
  const [album, setAlbum] = useState(undefined);
  const [posts, setPosts] = useState(null);
  const [err, setErr] = useState(false);
  const load = useCallback(async function () {
    const a = await sb.from("albums").select("*").eq("id", id).maybeSingle();
    const ap = await sb.from("album_posts").select("post_id").eq("album_id", id);
    if (a.error || ap.error) { setErr(true); return; }
    setErr(false); setAlbum(a.data || null);
    const ids = (ap.data || []).map(function (x) { return x.post_id; });
    if (!ids.length) { setPosts([]); return; }
    const p = await sb.from("posts").select("*, comments(id), hearts(user_id)").in("id", ids).order("created_at", { ascending: false });
    setPosts(p.data || []);
  }, [id]);
  useEffect(function () { load(); }, [load, tick]);
  async function del() {
    if (!confirm("Delete this album? The posts stay in the feed.")) return;
    const r = await sb.from("albums").delete().eq("id", id);
    if (r.error) { toast(r.error.message); return; }
    toast("Album deleted"); bump(); back();
  }
  return html`<div><${TopBar} title=${album ? album.name : "Album"} back=${back} />
    ${err && !posts && html`<${Failed} what="this album" onRetry=${load} />`}
    ${album === null && html`<div className="center muted" style=${{ padding: "3rem 1rem" }}>This album is no longer here.</div>`}
    ${posts && posts.length === 0 && album && html`<div className="center muted" style=${{ padding: "3rem 1.5rem" }}>Nothing in this album yet. Open the ⋯ menu on any post and choose Add to a shared album.</div>`}
    ${(posts || []).map(function (p) { return html`<${PostCard} key=${p.id} post=${p} albumId=${id} onChange=${load} />`; })}
    ${album && (album.owner_id === me.id || me.role === "admin") && html`<div style=${{ padding: "1rem" }}><button className="btn danger block" onClick=${del}>Delete album</button></div>`}
  </div>`;
}

function AlbumPickSheet({ postId, onClose }) {
  const { me, toast, bump } = useApp();
  const [albums, setAlbums] = useState(null);
  const [name, setName] = useState("");
  useEffect(function () {
    sb.from("albums").select("*, album_posts(post_id)").order("created_at", { ascending: false }).then(function (r) { setAlbums(r.data || []); }).catch(function () { setAlbums([]); });
  }, []);
  async function add(aid, label) {
    const r = await sb.from("album_posts").insert({ album_id: aid, post_id: postId, added_by: me.id });
    if (r.error) toast(/duplicate|already/i.test(r.error.message) ? "Already in " + label : r.error.message);
    else { toast("Added to " + label); bump(); }
    onClose();
  }
  async function createAndAdd() {
    const n = name.trim();
    if (!n) return;
    const aid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now());
    const c = await sb.from("albums").insert({ id: aid, owner_id: me.id, name: n });
    if (c.error) { toast(c.error.message); return; }
    await add(aid, n);
  }
  return html`<${Sheet} title="Add to a shared album" onClose=${onClose}>
    ${!albums && html`<div className="muted" style=${{ padding: ".6rem" }}>Loading...</div>`}
    ${(albums || []).map(function (a) { return html`<button key=${a.id} className="sheetbtn" onClick=${function () { add(a.id, a.name); }}>${a.name}<span className="muted"> · ${(a.album_posts || []).length}</span></button>`; })}
    <div style=${{ fontWeight: 600, margin: ".8rem 0 .3rem" }}>Or start a new album</div>
    <div className="row"><label className="sr" htmlFor="alb-new">New album name</label>
      <input id="alb-new" className="field" maxLength="60" placeholder="Album name" value=${name} onChange=${function (e) { setName(e.target.value); }} />
      <button className="btn" disabled=${!name.trim()} onClick=${createAndAdd}>Add</button></div>
  </${Sheet}>`;
}

/* =====================  shell (tabs, history, data)  ===================== */
function Shell({ me, toast, reloadMe, easy, setEasy }) {
  const [stack, setStack] = useState([{ name: "home" }]);
  const [profiles, setProfiles] = useState({});
  const [tick, setTick] = useState(0);
  const [unread, setUnread] = useState(false);
  const [sheet, setSheet] = useState(null);
  const [welcome, setWelcome] = useState(lsGet("ic-welcomed", "0") !== "1");
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const stackRef = useRef(stack);
  stackRef.current = stack;
  const savedScroll = useRef(null);

  const loadProfiles = useCallback(async function () {
    const r = await sb.from("profiles").select("id,display_name,bio,relation,role,status,created_at,avatar_path,birth_month,birth_day");
    const m = {};
    (r.data || []).forEach(function (x) { m[x.id] = x; });
    setProfiles(m);
  }, []);
  useEffect(function () { loadProfiles(); }, [loadProfiles, tick]);

  const bump = useCallback(function () { setTick(function (t) { return t + 1; }); }, []);
  useEffect(function () {   /* keep this phone's notification address fresh */
    if (!pushCanWork() || Notification.permission !== "granted" || lsGet("ic-push", "") !== "1") return;
    navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); })
      .then(function (sub) { if (sub) return pushSave(sub); }).catch(function () {});
  }, [me.id]);
  const [groupNames, setGroupNames] = useState({});
  useEffect(function () {
    sb.from("groups").select("id,name").then(function (r) {
      const m = {};
      (r.data || []).forEach(function (g) { m[g.id] = g.name; });
      setGroupNames(m);
    }).catch(function () {});
  }, [tick]);

  const checkUnread = useCallback(async function () {
    try {
      const items = await fetchActivity(me);
      const seenAt = Number(lsGet("ic-activity-seen", "0"));
      setUnread(items.some(function (a) { return new Date(a.at).getTime() > seenAt; }));
    } catch (e) {}
  }, [me.id]);
  useEffect(function () { checkUnread(); }, [checkUnread, tick]);

  const push = useCallback(function (r) {
    if (stackRef.current.length === 1) savedScroll.current = window.scrollY;
    try { history.pushState({ ic: 1 }, ""); } catch (e) {}
    setStack(function (s) { return s.concat([r]); });
  }, []);
  const back = useCallback(function () {
    if (stackRef.current.length > 1) {
      let ok = true;
      try { history.back(); } catch (e) { ok = false; }
      if (!ok) setStack(function (s) { return s.slice(0, -1); });
    }
  }, []);
  useEffect(function () {
    function onPop() { setStack(function (s) { return s.length > 1 ? s.slice(0, -1) : s; }); }
    window.addEventListener("popstate", onPop);
    return function () { window.removeEventListener("popstate", onPop); };
  }, []);

  /* open a shared event link (?event=...) once signed in */
  useEffect(function () {
    try {
      const id = new URLSearchParams(location.search).get("event");
      if (id && /^[0-9a-f-]{36}$/i.test(id)) {
        history.replaceState({}, "", location.pathname);
        push({ name: "event", id: id });
      }
    } catch (e) {}
  }, []);

  /* keep the feed where you left it */
  const deep = stack.length > 1;
  useLayoutEffect(function () {
    if (deep) window.scrollTo(0, 0);
    else if (savedScroll.current !== null) { window.scrollTo(0, savedScroll.current); savedScroll.current = null; }
  }, [deep, stack.length]);

  /* refresh when you come back to the app, and every minute while it is open */
  useEffect(function () {
    function vis() { if (document.visibilityState === "visible") bump(); }
    document.addEventListener("visibilitychange", vis);
    const t = setInterval(function () { if (document.visibilityState === "visible" && stackRef.current.length === 1) bump(); }, 60000);
    return function () { document.removeEventListener("visibilitychange", vis); clearInterval(t); };
  }, [bump]);

  /* pull down at the top of the screen to refresh */
  useEffect(function () {
    let startY = null;
    let dist = 0;
    function ts(e) { startY = (window.scrollY <= 0 && stackRef.current.length === 1 && e.touches.length === 1) ? e.touches[0].clientY : null; dist = 0; }
    function tm(e) {
      if (startY === null) return;
      dist = e.touches[0].clientY - startY;
      if (dist > 0) setPull(Math.min(dist, 110)); else { startY = null; setPull(0); }
    }
    function te() {
      if (startY !== null && dist >= 80) { setRefreshing(true); bump(); setTimeout(function () { setRefreshing(false); }, 1000); }
      startY = null; dist = 0; setPull(0);
    }
    document.addEventListener("touchstart", ts, { passive: true });
    document.addEventListener("touchmove", tm, { passive: true });
    document.addEventListener("touchend", te);
    return function () { document.removeEventListener("touchstart", ts); document.removeEventListener("touchmove", tm); document.removeEventListener("touchend", te); };
  }, [bump]);

  const tab = useCallback(function (name) {
    const cur = stackRef.current;
    if (cur.length === 1 && cur[0].name === name) { window.scrollTo({ top: 0, behavior: "smooth" }); bump(); return; }
    setStack([{ name: name }]);
    window.scrollTo(0, 0);
  }, [bump]);

  const members = Object.keys(profiles).map(function (k) { return profiles[k]; });
  const memberCount = members.filter(function (x) { return x.status === "approved"; }).length;
  const pendingCount = me.role === "admin" ? members.filter(function (x) { return x.status === "pending"; }).length : 0;

  const ctx = {
    me: me, profiles: profiles, toast: toast, push: push, back: back, tab: tab, tick: tick, bump: bump,
    reloadMe: reloadMe, reloadProfiles: loadProfiles, easy: easy, setEasy: setEasy, groupNames: groupNames,
    clearUnread: function () { setUnread(false); }, unread: unread, memberCount: memberCount, pendingCount: pendingCount,
    openInvite: function (existing) { setSheet({ kind: "invite", existing: existing }); },
    openHello: function (id) { setSheet({ kind: "hello", id: id }); },
    offerNudge: function () {
      const today = new Date().toDateString();
      if (lsGet("ic-nudge-day", "") === today) return;
      lsSet("ic-nudge-day", today);
      setTimeout(function () { setSheet({ kind: "nudge" }); }, 600);
    }
  };

  function renderRoute(route) {
    switch (route.name) {
      case "home": return html`<${Home} />`;
      case "people": return html`<${People} />`;
      case "memories": return html`<${Memories} />`;
      case "me": return html`<${Profile} userId=${me.id} root=${true} />`;
      case "profile": return html`<${Profile} userId=${route.userId} root=${false} />`;
      case "post": return html`<${SinglePost} id=${route.id} />`;
      case "comments": return html`<${Comments} postId=${route.postId} />`;
      case "new": return html`<${NewPost} day=${route.day} promptId=${route.promptId} promptText=${route.promptText} albumId=${route.albumId} albumName=${route.albumName} />`;
      case "groups": return html`<${GroupsScreen} />`;
      case "prompt": return html`<${PromptScreen} id=${route.id} />`;
      case "news": return html`<${NewsScreen} />`;
      case "album": return html`<${AlbumScreen} id=${route.id} />`;
      case "celebrations": return html`<${Celebrations} />`;
      case "events": return html`<${Events} />`;
      case "event": return html`<${EventScreen} id=${route.id} />`;
      case "wall": return html`<${PhotoWall} id=${route.id} />`;
      case "story": return html`<${StoryViewer} authorId=${route.authorId} />`;
      case "settings": return html`<${Settings} />`;
      case "prefs": return html`<${PrefsEditor} />`;
      case "organizer": return html`<${Organizer} />`;
      case "activity": return html`<${Activity} />`;
      default: return html`<${Home} />`;
    }
  }

  const root = stack[0];
  const top = stack[stack.length - 1];
  const hasNav = ["home", "people", "memories", "me", "profile", "post", "activity", "organizer", "groups", "prompt", "news", "album", "celebrations", "events", "event"].indexOf(top.name) >= 0;
  const topKey = stack.length + ":" + top.name + (top.userId || top.postId || top.id || top.authorId || "");

  const tabs = [
    ["home", "Home", html`<${Icon} n="home" s=${26} fill=${root.name === "home" ? "currentColor" : "none"} sw=${root.name === "home" ? 2 : 1.8} />`],
    ["people", "People", html`<${Icon} n="people" s=${26} fill=${root.name === "people" ? "currentColor" : "none"} />${pendingCount > 0 && html`<span className="badge" style=${{ top: ".15rem", right: "calc(50% - 1.5rem)" }}></span>`}`],
    ["new", "Share", html`<${Icon} n="plus" s=${26} />`],
    ["memories", "Memories", html`<${Icon} n="clock" s=${26} sw=${root.name === "memories" ? 2.6 : 1.8} />`],
    ["me", "Me", html`<span style=${{ display: "flex", borderRadius: "50%", outline: root.name === "me" ? "2px solid #111" : "none", outlineOffset: "2px", marginBottom: "2px" }}><${Avatar} id=${me.id} name=${me.display_name} size=${26} /></span>`]
  ];

  return html`
    <${Ctx.Provider} value=${ctx}>
      ${(pull > 10 || refreshing) && html`<div className="ptr" style=${{ height: (refreshing ? 44 : Math.round(pull * 0.5)) + "px" }}>${refreshing ? "Refreshing..." : pull >= 80 ? "Let go to refresh" : "Pull to refresh"}</div>`}
      <div className=${hasNav ? "page" : ""}>
        <div key=${"root-" + root.name} style=${{ display: deep ? "none" : "block" }}>${renderRoute(root)}</div>
        ${deep && html`<div key=${topKey}>${renderRoute(top)}</div>`}
      </div>
      ${hasNav && html`<nav className="nav" aria-label="Main">${tabs.map(function (t) {
        return html`<button key=${t[0]} aria-label=${t[1]} onClick=${function () { t[0] === "new" ? push({ name: "new" }) : tab(t[0]); }}>${t[2]}<span className="lbl">${t[1]}</span></button>`;
      })}</nav>`}
      ${sheet && sheet.kind === "invite" && html`<${InviteSheet} existing=${sheet.existing} onClose=${function () { setSheet(null); }} />`}
      ${sheet && sheet.kind === "nudge" && html`<${NudgeSheet} onClose=${function () { setSheet(null); }} />`}
      ${sheet && sheet.kind === "hello" && html`<${HelloSheet} userId=${sheet.id} onClose=${function () { setSheet(null); }} />`}
      ${welcome && !sheet && html`<${Welcome} onDone=${function () { setWelcome(false); }} />`}
    </${Ctx.Provider}>`;
}

/* =====================  app root  ===================== */
function NotConfigured() {
  return html`<div className="authwrap" style=${{ justifyContent: "center" }}>
    <h1 className="serif" style=${{ color: "#0879a0" }}>Almost there</h1>
    <p>Inner Circle is installed, but it is not connected to your private database yet.</p>
    <p>Open <b>config.js</b> and paste in your two Supabase values. Step 6 in SETUP.md shows exactly where to find them.</p></div>`;
}

function App() {
  const [session, setSession] = useState(undefined);
  const [me, setMe] = useState(null);
  const [msg, setMsg] = useState("");
  const [online, setOnline] = useState(navigator.onLine !== false);
  const [easy, setEasyState] = useState(function () { return lsGet("ic-easy", "0") === "1"; });

  const toast = useCallback(function (m) {
    setMsg(m);
    setTimeout(function () { setMsg(""); }, 4500);
  }, []);
  function setEasy(v) { setEasyState(v); lsSet("ic-easy", v ? "1" : "0"); }
  useEffect(function () { document.documentElement.classList.toggle("easy", easy); }, [easy]);
  useEffect(function () {
    const on = function () { setOnline(true); };
    const off = function () { setOnline(false); };
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return function () { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);

  useEffect(function () {
    if (!configured) return;
    sb.auth.getSession().then(function (r) { setSession(r.data.session); });
    const res = sb.auth.onAuthStateChange(function (event, s) {
      setSession(s);
    });
    return function () { res.data.subscription.unsubscribe(); };
  }, []);

  const loadMe = useCallback(async function () {
    if (!session) { setMe(null); return; }
    const r = await sb.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
    setMe(r.data || { id: session.user.id, status: "pending", display_name: "" });
  }, [session && session.user && session.user.id]);
  useEffect(function () { loadMe(); }, [loadMe]);

  /* someone waiting for approval is checked again every 20 seconds */
  useEffect(function () {
    if (!me || me.status !== "pending") return;
    const t = setInterval(loadMe, 20000);
    return function () { clearInterval(t); };
  }, [me && me.status, loadMe]);

  let body;
  if (!configured) body = html`<${NotConfigured} />`;
  else if (session === undefined) body = html`<div className="center muted" style=${{ padding: "5rem 1rem" }}>Loading...</div>`;
  else if (!session) body = html`<${AuthScreen} toast=${toast} easy=${easy} setEasy=${setEasy} />`;
  else if (!me) body = html`<div className="center muted" style=${{ padding: "5rem 1rem" }}>Loading...</div>`;
  else if (me.status !== "approved") body = html`<${Waiting} me=${me} reloadMe=${loadMe} />`;
  else body = html`<${Shell} me=${me} toast=${toast} reloadMe=${loadMe} easy=${easy} setEasy=${setEasy} />`;

  return html`<div>${!online && html`<div className="offline" role="status">You are offline. Posting and refreshing will work again when you reconnect.</div>`}${body}${msg && html`<div className="toast" role="status">${msg}</div>`}</div>`;
}

createRoot(document.getElementById("root")).render(html`<${App} />`);
