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
const SHORT_VIDEO_S = 30;        // anyone can post clips this long, any time
const MAX_VIDEO_S = 180;         // one longer clip (up to 3 minutes) per person per 24 hours
const VIDEO_BUDGET_BYTES = 18 * 1048576;  // long clips are squeezed to fit about this much
const MAX_VIDEO_BYTES = 12 * 1048576;  // clips bigger than this are re-encoded smaller

/* =====================  helpers  ===================== */
const PALETTE = ["#2f5d50", "#5b7aa6", "#8a5a7a", "#b5651d", "#6b8f5e", "#7a6a4f", "#4f6f8f"];
function colorFor(key) {
  const s = String(key || "?");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
function initial(name) { return (name || "?").trim().charAt(0).toUpperCase(); }
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
    " Inner Circle, a private space for family and close friends. Tap the link to join (your invite code is filled in for you). It works once and expires in " + (days || 7) + " days. If it asks, the code is " + code + ".";
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
function postPaths(p) { return [p.image_path].concat(p.extra_paths || []).filter(Boolean); }
function allPaths(p) { return postPaths(p).concat(p.video_path ? [p.video_path] : []); }

/* =====================  icons & small pieces  ===================== */
const ICONS = {
  heart: '<path d="M12 20s-7-4.4-9-9c-1.2-3 .6-6.5 4-6.5 2 0 3.5 1 5 3 1.5-2 3-3 5-3 3.4 0 5.2 3.5 4 6.5-2 4.6-9 9-9 9z"/>',
  comment: '<path d="M21 12a8.5 8.5 0 0 1-12.6 7.4L3 21l1.6-5.2A8.5 8.5 0 1 1 21 12z"/>',
  home: '<path d="M3 11l9-8 9 8v10h-6v-6H9v6H3z"/>',
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><circle cx="17" cy="9" r="2.5"/><path d="M17 14c2.6 0 4.5 1.7 4.5 4.5"/>',
  plus: '<rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><path d="M12 8v8M8 12h8"/>',
  plusSmall: '<path d="M12 5v14M5 12h14"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  more: '<circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  grid: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M4 10.5h16M4 15.5h16M9.5 4v16M14.5 4v16"/>',
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
  return html`<svg width=${z} height=${z} viewBox="0 0 24 24" fill="none" stroke="#2f5d50" strokeWidth="2" aria-hidden="true">
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
function Sheet({ title, onClose, children }) {
  useEffect(function () {
    function k(e) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", k);
    return function () { window.removeEventListener("keydown", k); };
  }, []);
  return html`<div className="scrim" onClick=${onClose}>
    <div className="sheet" role="dialog" aria-modal="true" aria-label=${title || "Menu"} onClick=${function (e) { e.stopPropagation(); }}>
      <div className="grab"></div>
      ${title && html`<h2 className="sheet-title">${title}</h2>`}
      ${children}
    </div></div>`;
}

/* =====================  sign in / join (text-message code) / email fallback  ===================== */
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
  const [mode, setMode] = useState(urlCode ? "up" : "in");   // in | up | email | forgot
  const [step, setStep] = useState("details");                // details | code
  const [f, setF] = useState({ name: "", phone: "", email: "", password: "", code: urlCode, token: "" });
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  const [wait, setWait] = useState(0);
  const set = function (k) { return function (e) { const v = e.target.value; setF(function (o) { return Object.assign({}, o, { [k]: v }); }); }; };

  useEffect(function () {
    if (wait <= 0) return;
    const t = setTimeout(function () { setWait(wait - 1); }, 1000);
    return function () { clearTimeout(t); };
  }, [wait]);

  function go(m) { setMode(m); setStep("details"); }

  async function sendCode() {
    const phone = toE164(f.phone);
    if (!phone) throw new Error("Please type your mobile number with area code, like 404 555 0123. For another country start with + and the country code.");
    if (mode === "up") {
      if (!f.name.trim()) throw new Error("Please tell us your name so the family knows who you are.");
      const r = await sb.auth.signInWithOtp({ phone: phone, options: { data: { display_name: f.name.trim(), invite_code: f.code.trim() } } });
      if (r.error) throw r.error;
    } else {
      const r = await sb.auth.signInWithOtp({ phone: phone, options: { shouldCreateUser: false } });
      if (r.error) {
        if (/signup|not allowed|not found/i.test(r.error.message || "")) throw new Error("We do not see that number yet. Tap Join with an invite below.");
        throw r.error;
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
      if (mode === "in" || mode === "up") {
        if (step === "details") await sendCode();
        else {
          const r = await sb.auth.verifyOtp({ phone: toE164(f.phone), token: f.token.trim(), type: "sms" });
          if (r.error) throw new Error("That code did not work. Check the text and try again, or ask for a new one.");
        }
      } else if (mode === "email") {
        const r = await sb.auth.signInWithPassword({ email: f.email.trim(), password: f.password });
        if (r.error) throw r.error;
      } else {
        if (!f.email.trim()) throw new Error("Type your email first.");
        const r = await sb.auth.resetPasswordForEmail(f.email.trim(), { redirectTo: location.origin + location.pathname });
        if (r.error) throw r.error;
        toast("If that email is in Inner Circle, a reset link is on its way.");
        go("email");
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

  const phoneMode = mode === "in" || mode === "up";
  const title = phoneMode
    ? (step === "code" ? "Sign in" : mode === "up" ? "Text me a code to join" : "Text me a code")
    : mode === "email" ? "Sign in" : "Send reset link";
  return html`
    <div className="authwrap">
      <button className="aa" aria-label=${easy ? "Switch to standard text" : "Switch to larger text"} aria-pressed=${easy} onClick=${function () { setEasy(!easy); }}>Aa</button>
      <div className="center">
        <${Logo} s=${64} />
        <h1 className="serif" style=${{ fontSize: "2.4rem", letterSpacing: "-.02em", color: "#2f5d50", margin: ".4rem 0 .2rem" }}>Inner Circle</h1>
        <p className="muted" style=${{ margin: 0 }}>Your people. Nobody else.</p>
      </div>
      <form className="stack" onSubmit=${submit} style=${{ marginTop: "2rem" }}>
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
        ${!phoneMode && html`
          <label className="sr" htmlFor="a-email">Email</label>
          <input id="a-email" className="field" type="email" placeholder="Email" value=${f.email} onChange=${set("email")} autoComplete="email" autoCapitalize="none" required />
          ${mode === "email" && html`
            <label className="sr" htmlFor="a-pw">Password</label>
            <input id="a-pw" className="field" type=${show ? "text" : "password"} placeholder="Password" value=${f.password} onChange=${set("password")} autoComplete="current-password" required />
            <div style=${{ textAlign: "right" }}><button type="button" className="linkbtn" style=${{ fontWeight: 500 }} onClick=${function () { setShow(!show); }}>${show ? "Hide password" : "Show password"}</button></div>`}`}
        <button className="btn block" style=${{ height: "3.1rem" }} disabled=${busy}>${busy ? "One moment..." : phoneMode && step === "code" ? "Sign in" : title}</button>
        ${mode === "email" && html`<div className="center"><button type="button" className="linkbtn" style=${{ fontWeight: 500 }} onClick=${function () { go("forgot"); }}>Forgot password?</button></div>`}
      </form>
      <div style=${{ flex: 1 }}></div>
      <div className="center" style=${{ borderTop: "1px solid var(--line)", paddingTop: "1rem" }}>
        ${mode === "in" && html`<span>New here? <button className="linkbtn" onClick=${function () { go("up"); }}>Join with an invite</button></span>`}
        ${mode === "up" && html`<span>Already a member? <button className="linkbtn" onClick=${function () { go("in"); }}>Sign in</button></span>`}
        ${(mode === "email" || mode === "forgot") && html`<button className="linkbtn" onClick=${function () { go("in"); }}>Sign in with a text code instead</button>`}
        ${phoneMode && step === "details" && html`<div><button className="linkbtn" style=${{ fontWeight: 500, fontSize: ".85rem" }} onClick=${function () { go("email"); }}>Sign in with email instead</button></div>`}
        <div className="muted" style=${{ fontSize: ".75rem", marginTop: ".3rem" }}>Private. No ads. No algorithm. No strangers.</div>
      </div>
    </div>`;
}

function NewPassword({ toast, done }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    if (pw.length < 8) { toast("Please choose at least 8 characters."); return; }
    setBusy(true);
    const r = await sb.auth.updateUser({ password: pw });
    setBusy(false);
    if (r.error) { toast(r.error.message); return; }
    toast("Password updated");
    done();
  }
  return html`
    <div className="authwrap">
      <div className="center"><${Logo} s=${56} /><h1 className="serif" style=${{ color: "#2f5d50", margin: ".4rem 0" }}>Choose a new password</h1></div>
      <form className="stack" onSubmit=${submit} style=${{ marginTop: "1.5rem" }}>
        <label className="sr" htmlFor="np">New password</label>
        <input id="np" className="field" type="password" placeholder="New password" value=${pw} onChange=${function (e) { setPw(e.target.value); }} autoComplete="new-password" />
        <button className="btn block" style=${{ height: "3.1rem" }} disabled=${busy}>Save password</button>
      </form>
    </div>`;
}

function Waiting({ me, reloadMe }) {
  const removed = me.status === "removed";
  return html`
    <div className="authwrap center" style=${{ justifyContent: "center", alignItems: "center" }}>
      <${Logo} s=${56} />
      <h1 className="serif" style=${{ color: "#2f5d50", margin: ".6rem 0" }}>${removed ? "Access ended" : "Almost in" + (me.display_name ? ", " + me.display_name : "")}</h1>
      <p className="muted">${removed ? "The family organizer has ended your access to Inner Circle." : "The family organizer has been asked to welcome you. This screen updates when they do, or tap the button to check."}</p>
      ${!removed && html`<div><button className="btn" onClick=${reloadMe}>Check again</button></div>`}
      <button className="linkbtn" onClick=${function () { sb.auth.signOut(); }}>Sign out</button>
    </div>`;
}

/* =====================  one post  ===================== */
function PostCard({ post, onChange }) {
  const { me, profiles, toast, push } = useApp();
  const [busy, setBusy] = useState(false);
  const [burst, setBurst] = useState(false);
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(post.caption || "");
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
    if (gone.length) await sb.storage.from("photos").remove(gone);
    const r = await sb.from("posts").delete().eq("id", post.id);
    if (r.error) toast(r.error.message);
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
      ${paths.length > 1 && html`
        <div style=${{ position: "relative" }}>
          <div className="carousel" onScroll=${onScroll} onClick=${photoTap}>
            ${paths.map(function (p, k) {
              return html`<div className="slide" key=${p}>${urls(p) ? html`<img className="photo" src=${urls(p)} alt=${"Photo " + (k + 1) + " of " + paths.length + " shared by " + authorName} draggable="false" />` : html`<div className="photo ph"></div>`}</div>`;
            })}
          </div>
          <div className="count" aria-hidden="true">${idx + 1}/${paths.length}</div>
          ${burst && html`<div className="pop"><${Icon} n="heart" s=${90} fill="#fff" color="#fff" sw=${1} /></div>`}
        </div>
        <div className="dots" aria-hidden="true">${paths.map(function (p, k) { return html`<i key=${p} className=${k === idx ? "on" : ""}></i>`; })}</div>`}
      ${paths.length === 0 && !vp && post.caption && html`<div className="textpost" onClick=${photoTap}>${post.caption}</div>`}
      <div className="acts">
        <button className="ibtn" aria-label=${hearted ? "Remove your heart" : "Send a heart"} onClick=${function () { setHeart(!hearted); }}>
          <${Icon} n="heart" s=${28} fill=${hearted ? "#d1352b" : "none"} color=${hearted ? "#d1352b" : "currentColor"} />
        </button>
        <button className="ibtn" aria-label="Comments" onClick=${function () { push({ name: "comments", postId: post.id }); }}>
          <${Icon} n="comment" s=${26} />
        </button>
      </div>
      ${names.length > 0 && html`<div className="likes">${lovedBy(names)}</div>`}
      ${(paths.length > 0 || vp) && post.caption && html`<div className="cap"><b style=${{ fontWeight: 600 }}>${authorName}</b> ${post.caption}</div>`}
      <button className="linkish" onClick=${function () { push({ name: "comments", postId: post.id }); }}>${nComments === 0 ? "Add a comment" : nComments === 1 ? "View 1 comment" : "View all " + nComments + " comments"}</button>
      <div className="time">${agoLong(post.created_at)}${post.edited_at ? " · edited" : ""}</div>
      ${menu && html`<${Sheet} onClose=${function () { setMenu(false); }}>
        ${paths.length > 0 && html`<button className="sheetbtn" onClick=${function () { setMenu(false); const u = urls(paths[idx] || paths[0]); if (u) savePhoto(u, toast); }}>Save photo to my phone</button>`}
        ${vp && html`<button className="sheetbtn" onClick=${function () { setMenu(false); const u = urls(vp); if (u) savePhoto(u, toast); }}>Save video to my phone</button>`}
        ${post.author_id === me.id && html`<button className="sheetbtn" onClick=${function () { setMenu(false); setDraft(post.caption || ""); setEditing(true); }}>Edit caption</button>`}
        ${mineOrAdmin && html`<button className="sheetbtn danger" onClick=${remove}>Delete post</button>`}
        <button className="sheetbtn" onClick=${function () { setMenu(false); }}>Cancel</button>
      </${Sheet}>`}
      ${editing && html`<${Sheet} title="Edit caption" onClose=${function () { setEditing(false); }}>
        <label className="sr" htmlFor=${"ec-" + post.id}>Caption</label>
        <textarea id=${"ec-" + post.id} className="field" rows="4" maxLength="3000" value=${draft} onChange=${function (e) { setDraft(e.target.value); }}></textarea>
        <div className="row" style=${{ marginTop: ".8rem" }}><button className="btn grey grow" onClick=${function () { setEditing(false); }}>Cancel</button><button className="btn grow" onClick=${saveCaption}>Save</button></div>
      </${Sheet}>`}
    </article>`;
}

/* =====================  home (stories + feed)  ===================== */
function GettingStarted() {
  const { me, push, openInvite } = useApp();
  return html`<div className="welcomecard">
    <h2 className="serif" style=${{ color: "#2f5d50", margin: 0 }}>Welcome, ${me.display_name}</h2>
    <p style=${{ margin: ".4rem 0 .9rem" }}>Inner Circle is only as good as the people in it. Start by inviting the family, then share your first moment.</p>
    <div className="row">
      <button className="btn grow" onClick=${function () { openInvite(); }}>Invite your family</button>
      <button className="btn grey grow" onClick=${function () { push({ name: "new" }); }}>Share a moment</button>
    </div></div>`;
}

function Home() {
  const { me, profiles, toast, push, tick, unread, memberCount } = useApp();
  const [posts, setPosts] = useState(null);
  const [stories, setStories] = useState([]);
  const [limit, setLimit] = useState(15);
  const [err, setErr] = useState(false);

  const load = useCallback(async function () {
    const since = new Date(Date.now() - 86400000).toISOString();
    const res = await Promise.all([
      sb.from("posts").select("*, comments(id), hearts(user_id)").order("created_at", { ascending: false }).limit(limit),
      sb.from("posts").select("id,author_id,created_at").eq("also_day", true).gte("created_at", since).order("created_at")
    ]);
    if (res[0].error) { setErr(true); return; }
    setErr(false);
    setPosts(res[0].data);
    setStories(res[1].data || []);
  }, [limit]);
  useEffect(function () { load(); }, [load, tick]);

  const seen = getSeen();
  const groups = {};
  stories.forEach(function (s) { (groups[s.author_id] = groups[s.author_id] || []).push(s.id); });
  const others = Object.keys(groups).filter(function (id) { return id !== me.id; }).map(function (id) {
    return { id: id, allSeen: groups[id].every(function (x) { return seen.has(x); }) };
  }).sort(function (a, b) { return (a.allSeen ? 1 : 0) - (b.allSeen ? 1 : 0); });
  const mine = groups[me.id];
  const mineSeen = mine ? mine.every(function (x) { return seen.has(x); }) : false;

  const header = html`<div className="top"><div className="brand"><${Logo} />Inner Circle</div>
    <button className="ibtn" aria-label=${unread ? "Activity, new" : "Activity"} onClick=${function () { push({ name: "activity" }); }}><${Icon} n="heart" s=${26} />${unread && html`<span className="badge"></span>`}</button></div>`;

  if (err && !posts) return html`<div>${header}<${Failed} what="your feed" onRetry=${load} /></div>`;
  if (!posts) return html`<div>${header}<div className="center muted" style=${{ padding: "4rem 1rem" }}>Loading your Inner Circle...</div></div>`;
  return html`
    <div>
      ${header}
      <div className="stories">
        <button className="story" aria-label=${mine ? "View your day" : "Add to your day"}
          onClick=${function () { mine ? push({ name: "story", authorId: me.id }) : push({ name: "new", day: true }); }}>
          <div style=${{ position: "relative", width: "4.25rem", margin: "0 auto" }}>
            <div className=${"ring " + (mine ? (mineSeen ? "seen" : "") : "none")}><${Avatar} id=${me.id} name=${me.display_name} size=${60} /></div>
            <div className="plus"><${Icon} n="plusSmall" s=${12} sw=${3.5} color="#fff" /></div>
          </div>
          <div className="slabel">Your day</div>
        </button>
        ${others.map(function (g) {
          const p = profiles[g.id] || {};
          return html`<button className="story" key=${g.id} aria-label=${"View " + nm(p) + "'s day"} onClick=${function () { push({ name: "story", authorId: g.id }); }}>
            <div className=${"ring " + (g.allSeen ? "seen" : "")}><${Avatar} id=${g.id} name=${p.display_name} size=${60} /></div>
            <div className="slabel" style=${{ color: g.allSeen ? "var(--muted)" : "inherit" }}>${nm(p)}</div>
          </button>`;
        })}
      </div>
      ${me.role === "admin" && memberCount <= 1 && html`<${GettingStarted} />`}
      ${posts.length === 0 && !(me.role === "admin" && memberCount <= 1) && html`
        <div className="center" style=${{ padding: "3rem 1.5rem" }}>
          <h2 className="serif" style=${{ color: "#2f5d50" }}>It is quiet in here</h2>
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
  const kb = useKeyboardInset();

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

  async function send(e) {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    setBusy(true);
    const r = await sb.from("comments").insert({ post_id: postId, author_id: me.id, body: body, parent_id: replyTo ? replyTo.id : null });
    if (r.error) toast(r.error.message); else { setText(""); setReplyTo(null); }
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
    await sb.from("comments").delete().eq("id", c.id);
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
  const all = list || [];
  const tops = all.filter(function (c) { return !c.parent_id; });
  const repliesOf = function (id) { return all.filter(function (c) { return c.parent_id === id; }); };

  function row(c, reply) {
    const hearted = c.comment_hearts.some(function (h) { return h.user_id === me.id; });
    const n = c.comment_hearts.length;
    return html`<div key=${c.id} className=${"cmt " + (reply ? "reply" : "")}>
      <${Avatar} id=${c.author_id} name=${authorOf(c.author_id)} size=${reply ? 28 : 36} />
      <div className="grow" style=${{ fontSize: ".9rem" }}>
        <div style=${{ overflowWrap: "anywhere" }}><b style=${{ fontWeight: 600 }}>${authorOf(c.author_id)}</b> ${c.body}</div>
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
      ${post && html`<div className="cmt" style=${{ borderBottom: "1px solid var(--soft)", paddingBottom: ".9rem" }}>
        <${Avatar} id=${post.author_id} name=${authorOf(post.author_id)} size=${36} />
        <div className="grow" style=${{ fontSize: ".9rem" }}>
          <div style=${{ overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}><b style=${{ fontWeight: 600 }}>${authorOf(post.author_id)}</b> ${post.caption || "Shared a photo"}</div>
          <div className="meta">${agoShort(post.created_at)}</div>
        </div></div>`}
      ${list && tops.length === 0 && html`<div className="center muted" style=${{ padding: "2rem 1rem" }}>No comments yet. Say something kind.</div>`}
      ${tops.map(function (c) {
        return html`<div key=${c.id}>${row(c, false)}${repliesOf(c.id).map(function (r) { return row(r, true); })}</div>`;
      })}
      <div style=${{ height: "6rem" }}></div>
      <form className="composer" onSubmit=${send} style=${{ bottom: kb + "px", paddingBottom: kb > 0 ? ".6rem" : "calc(env(safe-area-inset-bottom, 0px) + .6rem)" }}>
        <${Avatar} id=${me.id} name=${me.display_name} size=${36} />
        <label className="sr" htmlFor="cm-in">Add a comment</label>
        <input id="cm-in" ref=${input} type="text" value=${text} maxLength="2000"
          placeholder=${replyTo ? "Write a reply..." : "Add a comment..."}
          onChange=${function (e) { setText(e.target.value); }} />
        <button className="tbtn" disabled=${busy || !text.trim()}>Post</button>
      </form>
    </div>`;
}

/* =====================  new post (one or many photos)  ===================== */
function NewPost({ day }) {
  const { me, toast, back, bump } = useApp();
  const [files, setFiles] = useState([]);
  const [caption, setCaption] = useState("");
  const [place, setPlace] = useState("");
  const [alsoDay, setAlsoDay] = useState(!!day);
  const [busy, setBusy] = useState("");
  const [video, setVideo] = useState(null);
  const [longAt, setLongAt] = useState(null);   // when the next long video is allowed (null = allowed now)
  const input = useRef(null);
  const vinput = useRef(null);
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
    const chosen = Array.from(e.target.files || []);
    if (!chosen.length) return;
    if (video) setVideo(null);
    setFiles(function (cur) {
      const room = MAX_PHOTOS - cur.length;
      if (chosen.length > room) toast("You can add up to " + MAX_PHOTOS + " photos to one post.");
      return cur.concat(chosen.slice(0, Math.max(0, room)).map(function (f) { return { file: f, url: URL.createObjectURL(f) }; }));
    });
    e.target.value = "";
  }
  function drop(k) { setFiles(function (cur) { return cur.filter(function (_, i) { return i !== k; }); }); }

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
        const rv = await sb.from("posts").insert({ author_id: me.id, caption: caption.trim(), image_path: ppath, video_path: vpath, video_seconds: Math.round(res.seconds), extra_paths: [], place: place.trim(), also_day: alsoDay });
        if (rv.error) throw rv.error;
        toast("Shared with your Inner Circle");
        back();
        bump();
        return;
      }
      for (let k = 0; k < files.length; k++) {
        setBusy(files.length > 1 ? "Uploading " + (k + 1) + " of " + files.length + "..." : "Uploading...");
        const blob = await shrink(files[k].file);
        const path = me.id + "/" + (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + k) + ".jpg";
        const up = await sb.storage.from("photos").upload(path, blob, { contentType: "image/jpeg" });
        if (up.error) throw up.error;
        uploaded.push(path);
      }
      const r = await sb.from("posts").insert({
        author_id: me.id, caption: caption.trim(), image_path: uploaded[0] || null, extra_paths: uploaded.slice(1),
        place: place.trim(), also_day: alsoDay
      });
      if (r.error) throw r.error;
      toast("Shared with your Inner Circle");
      back();
      bump();
    } catch (err) {
      if (uploaded.length) sb.storage.from("photos").remove(uploaded);
      toast((err && err.message) || "Could not share. Please try again.");
      setBusy("");
    }
  }

  return html`
    <div>
      <${TopBar} title="New post" back=${back} right=${html`<button className="tbtn" onClick=${submit} disabled=${!!busy}>${busy ? "..." : "Share"}</button>`} />
      <input ref=${input} type="file" accept="image/*" multiple onChange=${pick} style=${{ display: "none" }} />
      <input ref=${vinput} type="file" accept="video/*" onChange=${pickVideo} style=${{ display: "none" }} />
      <div className="row" style=${{ alignItems: "flex-start", padding: "1rem", borderBottom: "1px solid var(--soft)" }}>
        <button onClick=${function () { input.current.click(); }} aria-label=${files.length ? "Add more photos" : "Choose photos"}
          style=${{ flex: "none", width: "5.5rem", height: "5.5rem", borderRadius: ".4rem", border: files.length ? 0 : "1px dashed #b9b9b9", background: "#f4f4f4", padding: 0, overflow: "hidden", cursor: "pointer", color: "var(--muted)", fontSize: ".8rem", position: "relative" }}>
          ${video ? (video.posterUrl ? html`<img src=${video.posterUrl} alt="Video preview" style=${{ width: "100%", height: "100%", objectFit: "cover" }} /><span className="addmore">Video</span>` : html`<span>Preparing...</span>`)
            : files.length ? html`<img src=${files[0].url} alt="Your first chosen photo" style=${{ width: "100%", height: "100%", objectFit: "cover" }} />
            <span className="addmore">${files.length < MAX_PHOTOS ? "+ Add more" : files.length + " photos"}</span>` : html`<span>Add photos</span>`}
        </button>
        <label className="sr" htmlFor="np-cap">Caption</label>
        <textarea id="np-cap" className="field" style=${{ border: 0, background: "#fff", height: "5.5rem" }} maxLength="3000"
          placeholder="Tell them what is happening, who is in it, how it felt..." value=${caption} onChange=${function (e) { setCaption(e.target.value); }}></textarea>
      </div>
      ${files.length > 1 && html`<div className="thumbs">${files.map(function (f, k) {
        return html`<div className="thumb" key=${f.url}><img src=${f.url} alt=${"Photo " + (k + 1)} />
          <button aria-label=${"Remove photo " + (k + 1)} onClick=${function () { drop(k); }}><${Icon} n="close" s=${14} sw=${3} color="#fff" /></button></div>`;
      })}</div>`}
      ${video ? html`<div style=${{ padding: ".6rem 1rem 0" }}>
          <div style=${{ fontSize: ".9rem" }}>${video.status === "working" ? "Getting your video ready... " + Math.round(video.pct * 100) + "%" : "Video ready: " + fmtTime(video.seconds) + ", " + fmtSize(video.outSize) + (video.outSize < video.size ? " (shrunk from " + fmtSize(video.size) + ")" : "")}</div>
          ${video.status === "working" && html`<div className="meter" style=${{ marginTop: ".3rem" }}><i style=${{ width: Math.round(video.pct * 100) + "%" }}></i></div>`}
          ${video.status === "working" && html`<div className="muted" style=${{ fontSize: ".8rem", marginTop: ".2rem" }}>Keep this screen open. Longer clips take about as long to prepare as they last.</div>`}
          ${video.trimmed && html`<div className="muted" style=${{ fontSize: ".8rem", marginTop: ".2rem" }}>${video.longOk ? "Videos can be up to 3 minutes, so we kept the first 3 minutes." : "Only one video longer than 30 seconds can be shared per day, so we kept the first 30 seconds."}</div>`}
          ${video.status === "ready" && video.seconds > SHORT_VIDEO_S && html`<div className="muted" style=${{ fontSize: ".8rem", marginTop: ".2rem" }}>This is your long video for today.</div>`}
          <button className="linkbtn" onClick=${function () { setVideo(null); }}>Remove video</button>
        </div>`
        : !files.length && html`<div style=${{ padding: ".4rem 1rem 0" }}><button className="linkbtn" onClick=${function () { vinput.current.click(); }}>Or add a video</button>
          <div className="muted" style=${{ fontSize: ".8rem" }}>${longAt ? "Up to 30 seconds now. Your next longer video (up to 3 minutes) opens at " + longAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) + "." : "Up to 30 seconds any time, plus one video up to 3 minutes per day."}</div></div>`}
      ${files.length === 1 && html`<div style=${{ padding: ".4rem 1rem 0" }}><button className="linkbtn" onClick=${function () { drop(0); }}>Remove photo</button></div>`}
      <div className="opt">
        <label className="sr" htmlFor="np-place">Add a place</label>
        <input id="np-place" className="field" style=${{ border: 0, background: "#fff", padding: 0, height: "2.75rem" }} placeholder="Add a place" maxLength="80" value=${place} onChange=${function (e) { setPlace(e.target.value); }} />
      </div>
      <div className="opt">
        <div className="grow"><div>Also add to Your day</div><div className="muted" style=${{ fontSize: ".75rem" }}>Shows at the top for 24 hours</div></div>
        <button role="switch" aria-checked=${alsoDay} aria-label="Also add to Your day" className=${"switch " + (alsoDay ? "on" : "")} onClick=${function () { setAlsoDay(!alsoDay); }}><i></i></button>
      </div>
      <div className="opt">
        <${Logo} s=${22} />
        <div className="grow"><div style=${{ fontWeight: 600 }}>Visible to your Inner Circle only</div><div className="muted" style=${{ fontSize: ".75rem" }}>Never public. Never searchable.</div></div>
      </div>
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

/* =====================  welcome (first time in)  ===================== */
function Welcome({ onDone }) {
  const { me, easy, setEasy, reloadMe, reloadProfiles } = useApp();
  const installable = useInstallable();
  const [relation, setRelation] = useState(me.relation || "");
  const standalone = isStandalone();
  async function done() {
    lsSet("ic-welcomed", "1");
    if (relation.trim() && relation.trim() !== (me.relation || "")) {
      await sb.from("profiles").update({ relation: relation.trim() }).eq("id", me.id);
      reloadMe(); reloadProfiles();
    }
    onDone();
  }
  return html`<${Sheet} title=${"Welcome to Inner Circle, " + (me.display_name || "friend")} onClose=${done}>
    <p className="muted" style=${{ marginTop: 0 }}>Two quick things so it feels right for you.</p>
    <div style=${{ fontWeight: 600 }}>Text size</div>
    <div className="row" style=${{ margin: ".4rem 0 1rem" }}>
      <button className=${"btn grow " + (easy ? "grey" : "")} aria-pressed=${!easy} onClick=${function () { setEasy(false); }}>Standard</button>
      <button className=${"btn grow " + (easy ? "" : "grey")} aria-pressed=${easy} style=${{ fontSize: "1.1rem" }} onClick=${function () { setEasy(true); }}>Larger</button>
    </div>
    <label htmlFor="w-rel" style=${{ fontWeight: 600 }}>How are you related to the family? (optional)</label>
    <input id="w-rel" className="field" style=${{ marginTop: ".3rem" }} placeholder="Example: Troy's mom, or Troy's old friend" maxLength="60" value=${relation} onChange=${function (e) { setRelation(e.target.value); }} />
    ${!standalone && html`<div className="installbox">
      <b>Put Inner Circle on your home screen</b>
      ${installable
        ? html`<div><button className="btn" style=${{ marginTop: ".5rem" }} onClick=${runInstall}>Install app</button></div>`
        : isIOS()
          ? html`<div className="muted" style=${{ fontSize: ".85rem", marginTop: ".3rem" }}>In Safari tap the Share button, then Add to Home Screen. After that, open Inner Circle from your home screen and sign in once more.</div>`
          : html`<div className="muted" style=${{ fontSize: ".85rem", marginTop: ".3rem" }}>Tap the three dots in Chrome, then Install app (or Add to Home screen).</div>`}
    </div>`}
    <button className="btn block" style=${{ marginTop: "1rem", height: "3.1rem" }} onClick=${done}>Done</button>
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
  const p = profiles[userId] || {};
  const mine = userId === me.id;
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
        ${p.bio ? html`<div style=${{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>${p.bio}</div>` : mine ? html`<div className="muted">Add a few words about yourself in Edit profile.</div>` : null}
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
function People() {
  const { me, profiles, push, tick, openHello, pendingCount } = useApp();
  const [last, setLast] = useState(null);
  const [err, setErr] = useState(false);

  const load = useCallback(async function () {
    const r = await sb.from("posts").select("author_id,created_at").order("created_at", { ascending: false }).limit(1000);
    if (r.error) { setErr(true); return; }
    setErr(false);
    const m = {};
    (r.data || []).forEach(function (x) { if (!m[x.author_id]) m[x.author_id] = x.created_at; });
    setLast(m);
  }, []);
  useEffect(function () { load(); }, [load, tick]);

  const members = Object.keys(profiles).map(function (k) { return profiles[k]; }).filter(function (x) { return x.status === "approved"; })
    .sort(function (a, b) { return nm(a).localeCompare(nm(b)); });
  const admin = me.role === "admin";

  const header = html`<div className="top"><div><h1 className="serif" style=${{ color: "#2f5d50", fontSize: "1.7rem" }}>Your Inner Circle</h1></div>
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
      <div className="muted" style=${{ padding: "0 1rem .4rem", fontSize: ".85rem" }}>${members.length} ${members.length === 1 ? "person" : "people"}. Everyone here was invited by family.</div>
      ${active.map(function (m) { return row(m, false); })}
      ${quiet.length > 0 && html`<div className="hdr">Quiet lately (only you can see this)</div>`}
      ${quiet.map(function (m) { return row(m, true); })}
    </div>`;
}

/* =====================  organizer (admin)  ===================== */
function Organizer() {
  const { me, toast, back, openInvite, reloadProfiles, bump } = useApp();
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
  const [posts, setPosts] = useState(null);
  const [err, setErr] = useState(false);
  const load = useCallback(async function () {
    const r = await sb.from("posts").select("*, comments(id), hearts(user_id)").order("created_at", { ascending: false }).limit(1000);
    if (r.error) { setErr(true); return; }
    setErr(false);
    const now = new Date();
    setPosts((r.data || []).filter(function (p) {
      const d = new Date(p.created_at);
      return d.getMonth() === now.getMonth() && d.getDate() === now.getDate() && d.getFullYear() < now.getFullYear();
    }));
  }, []);
  useEffect(function () { load(); }, [load, tick]);
  const header = html`<div className="top"><div><h1 className="serif" style=${{ color: "#2f5d50", fontSize: "1.7rem" }}>On this day</h1></div></div>`;
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
  (res[0].data || []).forEach(function (c) { items.push({ k: "c" + c.id, kind: "comment", who: c.author_id, post: c.post_id, img: c.posts && c.posts.image_path, text: c.body, at: c.created_at }); });
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
  const [busy, setBusy] = useState(false);
  const [arch, setArch] = useState("");
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
    if (r.error) { toast(r.error.message); return; }
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
    setBusy(true);
    const r = await sb.from("profiles").update({ display_name: n, relation: relation.trim(), bio: bio.trim() }).eq("id", me.id);
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
            <div className="muted" style=${{ fontSize: ".85rem", margin: ".2rem 0 .5rem" }}>Add your mobile number to sign in with a texted code instead of email.</div>
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
        <h3 className="serif" style=${{ color: "#2f5d50" }}>Our promises</h3>
        <ul>
          <li>Only invited family and friends. Never the public.</li>
          <li>Newest first. No algorithm deciding what you see.</li>
          <li>No ads, no tracking, no selling anything.</li>
          <li>Your photos stay in a private vault that only your Inner Circle can open.</li>
        </ul>
      </div>
      <div style=${{ padding: "1rem" }}><button className="btn grey block" onClick=${function () { sb.auth.signOut(); }}>Sign out</button></div>
    </div>`;
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
    const r = await sb.from("profiles").select("*");
    const m = {};
    (r.data || []).forEach(function (x) { m[x.id] = x; });
    setProfiles(m);
  }, []);
  useEffect(function () { loadProfiles(); }, [loadProfiles, tick]);

  const bump = useCallback(function () { setTick(function (t) { return t + 1; }); }, []);

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
    reloadMe: reloadMe, reloadProfiles: loadProfiles, easy: easy, setEasy: setEasy,
    clearUnread: function () { setUnread(false); }, unread: unread, memberCount: memberCount, pendingCount: pendingCount,
    openInvite: function (existing) { setSheet({ kind: "invite", existing: existing }); },
    openHello: function (id) { setSheet({ kind: "hello", id: id }); }
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
      case "new": return html`<${NewPost} day=${route.day} />`;
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
  const hasNav = ["home", "people", "memories", "me", "profile", "post", "activity", "organizer"].indexOf(top.name) >= 0;
  const topKey = stack.length + ":" + top.name + (top.userId || top.postId || top.id || top.authorId || "");

  const tabs = [
    ["home", "Home", html`<${Icon} n="home" s=${26} fill=${root.name === "home" ? "currentColor" : "none"} sw=${root.name === "home" ? 2 : 1.8} />`],
    ["people", "People", html`<${Icon} n="people" s=${26} fill=${root.name === "people" ? "currentColor" : "none"} />${pendingCount > 0 && html`<span className="badge" style=${{ top: ".15rem", right: "calc(50% - 1.5rem)" }}></span>`}`],
    ["new", "Share", html`<${Icon} n="plus" s=${26} />`],
    ["memories", "Memories", html`<${Icon} n="clock" s=${26} sw=${root.name === "memories" ? 2.6 : 1.8} />`],
    ["me", "Me", html`<span style=${{ display: "flex", borderRadius: "50%", outline: root.name === "me" ? "2px solid #111" : "none", outlineOffset: "2px" }}><${Avatar} id=${me.id} name=${me.display_name} size=${26} /></span>`]
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
      ${sheet && sheet.kind === "hello" && html`<${HelloSheet} userId=${sheet.id} onClose=${function () { setSheet(null); }} />`}
      ${welcome && !sheet && html`<${Welcome} onDone=${function () { setWelcome(false); }} />`}
    </${Ctx.Provider}>`;
}

/* =====================  app root  ===================== */
function NotConfigured() {
  return html`<div className="authwrap" style=${{ justifyContent: "center" }}>
    <h1 className="serif" style=${{ color: "#2f5d50" }}>Almost there</h1>
    <p>Inner Circle is installed, but it is not connected to your private database yet.</p>
    <p>Open <b>config.js</b> and paste in your two Supabase values. Step 6 in SETUP.md shows exactly where to find them.</p></div>`;
}

function App() {
  const [session, setSession] = useState(undefined);
  const [me, setMe] = useState(null);
  const [msg, setMsg] = useState("");
  const [recovery, setRecovery] = useState(false);
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
      if (event === "PASSWORD_RECOVERY") setRecovery(true);
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
  else if (recovery) body = html`<${NewPassword} toast=${toast} done=${function () { setRecovery(false); }} />`;
  else if (!me) body = html`<div className="center muted" style=${{ padding: "5rem 1rem" }}>Loading...</div>`;
  else if (me.status !== "approved") body = html`<${Waiting} me=${me} reloadMe=${loadMe} />`;
  else body = html`<${Shell} me=${me} toast=${toast} reloadMe=${loadMe} easy=${easy} setEasy=${setEasy} />`;

  return html`<div>${!online && html`<div className="offline" role="status">You are offline. Posting and refreshing will work again when you reconnect.</div>`}${body}${msg && html`<div className="toast" role="status">${msg}</div>`}</div>`;
}

createRoot(document.getElementById("root")).render(html`<${App} />`);
