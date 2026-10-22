import React, { useState, useEffect, useCallback, useRef, useContext } from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";
import htm from "https://esm.sh/htm@3.1.1";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const html = htm.bind(React.createElement);
const cfg = window.APP_CONFIG || {};
const configured = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);
const sb = configured ? createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;

const Ctx = React.createContext(null);
const useApp = function () { return useContext(Ctx); };

/* =====================  helpers  ===================== */
const PALETTE = ["#2f5d50", "#5b7aa6", "#8a5a7a", "#b5651d", "#6b8f5e", "#7a6a4f", "#4f6f8f"];
function colorFor(key) {
  const s = String(key || "?");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
function initial(name) { return (name || "?").trim().charAt(0).toUpperCase(); }
function first(name) { return (name || "Someone").trim().split(" ")[0]; }

function agoLong(d) {
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) { const m = Math.floor(s / 60); return m + (m === 1 ? " minute ago" : " minutes ago"); }
  if (s < 86400) { const h = Math.floor(s / 3600); return h + (h === 1 ? " hour ago" : " hours ago"); }
  const days = Math.floor(s / 86400);
  if (days < 7) return days + (days === 1 ? " day ago" : " days ago");
  return new Date(d).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}
function agoShort(d) {
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  if (s < 604800) return Math.floor(s / 86400) + "d";
  return Math.floor(s / 604800) + "w";
}
function daysSince(d) { return Math.floor((Date.now() - new Date(d).getTime()) / 86400000); }

function likedBy(names) {
  if (!names.length) return "";
  if (names.length === 1) return "Liked by " + names[0];
  if (names.length === 2) return "Liked by " + names[0] + " and " + names[1];
  const n = names.length - 2;
  return "Liked by " + names[0] + ", " + names[1] + " and " + n + (n === 1 ? " other" : " others");
}

function tenure(created) {
  const days = daysSince(created);
  if (days >= 365) { const y = Math.floor(days / 365); return [String(y), y === 1 ? "year here" : "years here"]; }
  if (days >= 30) { const m = Math.floor(days / 30); return [String(m), m === 1 ? "month here" : "months here"]; }
  return [String(Math.max(days, 0)), days === 1 ? "day here" : "days here"];
}

function lsGet(k, fallback) { try { const v = localStorage.getItem(k); return v === null ? fallback : v; } catch (e) { return fallback; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function getSeen() {
  try { return new Set(JSON.parse(lsGet("ic-seen", "[]"))); } catch (e) { return new Set(); }
}
function markSeen(id) {
  const s = getSeen();
  s.add(id);
  lsSet("ic-seen", JSON.stringify(Array.from(s).slice(-300)));
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

/* Photos live in a private vault; each one gets a short-lived link. */
const urlCache = new Map();
async function ensureUrls(paths) {
  const now = Date.now();
  const need = Array.from(new Set(paths.filter(Boolean))).filter(function (p) {
    const c = urlCache.get(p);
    return !c || c.exp - now < 600000;
  });
  if (!need.length) return;
  const r = await sb.storage.from("photos").createSignedUrls(need, 3600);
  (r.data || []).forEach(function (d) {
    if (d.signedUrl) urlCache.set(d.path, { url: d.signedUrl, exp: now + 3600000 });
  });
}
function useUrls(items) {
  const st = useState(0);
  const bump = st[1];
  const key = items.map(function (i) { return i.image_path || ""; }).join("|");
  useEffect(function () {
    let live = true;
    ensureUrls(items.map(function (i) { return i.image_path; })).then(function () { if (live) bump(function (v) { return v + 1; }); });
    return function () { live = false; };
  }, [key]);
  return function (path) { const c = path && urlCache.get(path); return c ? c.url : null; };
}

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
  chevron: '<path d="M9 5l7 7-7 7"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  grid: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M4 10.5h16M4 15.5h16M9.5 4v16M14.5 4v16"/>'
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
  return html`<div className="av" style=${{ width: s + "px", height: s + "px", fontSize: Math.round(s * 0.42) + "px", background: colorFor(id || name) }}>${initial(name)}</div>`;
}
function TopBar({ title, back, right }) {
  return html`<div className="top back line">
    <button className="ibtn" aria-label="Back" onClick=${back}><${Icon} n="back" s=${26} sw=${2} /></button>
    <h1>${title}</h1>
    <div style=${{ minWidth: "2.75rem", display: "flex", justifyContent: "flex-end" }}>${right}</div>
  </div>`;
}

/* =====================  sign in / join / reset  ===================== */
function AuthScreen({ toast }) {
  const [mode, setMode] = useState("in");
  const [f, setF] = useState({ name: "", email: "", password: "", code: "" });
  const [busy, setBusy] = useState(false);
  const set = function (k) { return function (e) { const v = e.target.value; setF(function (o) { return Object.assign({}, o, { [k]: v }); }); }; };

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "in") {
        const r = await sb.auth.signInWithPassword({ email: f.email.trim(), password: f.password });
        if (r.error) throw r.error;
      } else if (mode === "up") {
        if (!f.name.trim()) throw new Error("Please tell us your name so the family knows who you are.");
        if (f.password.length < 8) throw new Error("Please choose a password with at least 8 characters.");
        const r = await sb.auth.signUp({
          email: f.email.trim(), password: f.password,
          options: { data: { display_name: f.name.trim(), invite_code: f.code.trim() } }
        });
        if (r.error) throw r.error;
        if (!r.data.session) toast("Check your email to confirm your address, then sign in.");
      } else {
        if (!f.email.trim()) throw new Error("Type your email first.");
        const r = await sb.auth.resetPasswordForEmail(f.email.trim(), { redirectTo: location.origin + location.pathname });
        if (r.error) throw r.error;
        toast("If that email is in Inner Circle, a reset link is on its way.");
        setMode("in");
      }
    } catch (err) {
      toast(err.message || "Something went wrong.");
    }
    setBusy(false);
  }

  const title = mode === "in" ? "Sign in" : mode === "up" ? "Join Inner Circle" : "Send reset link";
  return html`
    <div className="authwrap">
      <div className="center">
        <${Logo} s=${64} />
        <h1 className="serif" style=${{ fontSize: "2.4rem", letterSpacing: "-.02em", color: "#2f5d50", margin: ".4rem 0 .2rem" }}>Inner Circle</h1>
        <p className="muted" style=${{ margin: 0 }}>Your people. Nobody else.</p>
      </div>
      <form className="stack" onSubmit=${submit} style=${{ marginTop: "2rem" }}>
        ${mode === "up" && html`
          <label className="sr" htmlFor="a-name">Your name</label>
          <input id="a-name" className="field" type="text" placeholder="Your name (how family knows you)" value=${f.name} onChange=${set("name")} autoComplete="name" />`}
        <label className="sr" htmlFor="a-email">Email</label>
        <input id="a-email" className="field" type="email" placeholder="Email" value=${f.email} onChange=${set("email")} autoComplete="email" autoCapitalize="none" required />
        ${mode !== "forgot" && html`
          <label className="sr" htmlFor="a-pw">Password</label>
          <input id="a-pw" className="field" type="password" placeholder="Password" value=${f.password} onChange=${set("password")}
            autoComplete=${mode === "in" ? "current-password" : "new-password"} required />`}
        ${mode === "up" && html`
          <label className="sr" htmlFor="a-code">Invite code</label>
          <input id="a-code" className="field" type="text" placeholder="Family invite code" value=${f.code} onChange=${set("code")} autoCapitalize="characters" autoComplete="off" />
          <div className="muted" style=${{ fontSize: ".8rem" }}>No code yet? Leave it blank and the family organizer can welcome you in.</div>`}
        <button className="btn block" style=${{ height: "3.1rem" }} disabled=${busy}>${busy ? "One moment..." : title}</button>
        ${mode === "in" && html`<div className="center"><button type="button" className="linkbtn" style=${{ fontWeight: 500 }} onClick=${function () { setMode("forgot"); }}>Forgot password?</button></div>`}
      </form>
      <div style=${{ flex: 1 }}></div>
      <div className="center" style=${{ borderTop: "1px solid var(--line)", paddingTop: "1rem" }}>
        ${mode === "in"
          ? html`<span>New here? <button className="linkbtn" onClick=${function () { setMode("up"); }}>Join with an invite code</button></span>`
          : html`<button className="linkbtn" onClick=${function () { setMode("in"); }}>Back to sign in</button>`}
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
    <div className="authwrap center" style=${{ justifyContent: "center" }}>
      <${Logo} s=${56} />
      <h1 className="serif" style=${{ color: "#2f5d50", margin: ".6rem 0" }}>${removed ? "Access ended" : "Almost in" + (me.display_name ? ", " + first(me.display_name) : "")}</h1>
      <p className="muted">${removed ? "The family organizer has ended your access to Inner Circle." : "The family organizer needs to welcome you in. As soon as they do, everything opens up."}</p>
      ${!removed && html`<div><button className="btn" onClick=${reloadMe}>Check again</button></div>`}
      <button className="linkbtn" onClick=${function () { sb.auth.signOut(); }}>Sign out</button>
    </div>`;
}

/* =====================  one post  ===================== */
function PostCard({ post, onChange }) {
  const { me, profiles, toast, push } = useApp();
  const [busy, setBusy] = useState(false);
  const [burst, setBurst] = useState(false);
  const lastTap = useRef(0);
  const urls = useUrls([post]);
  const url = urls(post.image_path);
  const author = profiles[post.author_id] || {};
  const authorName = author.display_name || "Someone";
  const hearted = post.hearts.some(function (h) { return h.user_id === me.id; });
  const names = post.hearts.slice().sort(function (a) { return a.user_id === me.id ? -1 : 1; }).map(function (h) {
    return h.user_id === me.id ? "you" : first((profiles[h.user_id] || {}).display_name);
  });
  const canDelete = post.author_id === me.id || me.role === "admin";
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
    } else {
      lastTap.current = now;
    }
  }

  async function remove() {
    if (!confirm("Delete this post for everyone? This cannot be undone.")) return;
    if (post.image_path) await sb.storage.from("photos").remove([post.image_path]);
    const r = await sb.from("posts").delete().eq("id", post.id);
    if (r.error) toast(r.error.message);
    await onChange();
  }

  return html`
    <article className="post">
      <div className="phead">
        <button style=${{ background: "none", border: 0, padding: 0, display: "flex", gap: ".65rem", alignItems: "center", textAlign: "left", cursor: "pointer", flex: 1, minWidth: 0 }}
          onClick=${function () { push({ name: "profile", userId: post.author_id }); }}>
          <${Avatar} id=${post.author_id} name=${authorName} size=${36} />
          <div style=${{ minWidth: 0 }}>
            <div className="pname">${authorName}</div>
            ${post.place && html`<div className="psub">${post.place}</div>`}
          </div>
        </button>
        ${canDelete && html`<button className="ibtn" aria-label="Delete post" onClick=${remove}><${Icon} n="more" s=${22} fill="currentColor" sw=${0} /></button>`}
      </div>
      ${post.image_path && html`
        <div style=${{ position: "relative" }} onClick=${photoTap}>
          ${url ? html`<img className="photo" src=${url} alt=${"Photo shared by " + authorName} draggable="false" />` : html`<div className="photo ph"></div>`}
          ${burst && html`<div className="pop"><${Icon} n="heart" s=${90} fill="#fff" color="#fff" sw=${1} /></div>`}
        </div>`}
      ${!post.image_path && post.caption && html`<div className="textpost" onClick=${photoTap}>${post.caption}</div>`}
      <div className="acts">
        <button className="ibtn" aria-label=${hearted ? "Remove your heart" : "Send a heart"} onClick=${function () { setHeart(!hearted); }}>
          <${Icon} n="heart" s=${28} fill=${hearted ? "#d1352b" : "none"} color=${hearted ? "#d1352b" : "currentColor"} />
        </button>
        <button className="ibtn" aria-label="Comments" onClick=${function () { push({ name: "comments", postId: post.id }); }}>
          <${Icon} n="comment" s=${26} />
        </button>
      </div>
      ${names.length > 0 && html`<div className="likes">${likedBy(names)}</div>`}
      ${post.image_path && post.caption && html`<div className="cap"><b style=${{ fontWeight: 600 }}>${authorName}</b> ${post.caption}</div>`}
      ${nComments > 0 && html`<button className="linkish" onClick=${function () { push({ name: "comments", postId: post.id }); }}>View ${nComments === 1 ? "1 comment" : "all " + nComments + " comments"}</button>`}
      ${nComments === 0 && html`<button className="linkish" onClick=${function () { push({ name: "comments", postId: post.id }); }}>Add a comment</button>`}
      <div className="time">${agoLong(post.created_at)}</div>
    </article>`;
}

/* =====================  home (stories + feed)  ===================== */
function Home() {
  const { me, profiles, toast, push, tick } = useApp();
  const [posts, setPosts] = useState(null);
  const [stories, setStories] = useState([]);
  const [limit, setLimit] = useState(15);

  const load = useCallback(async function () {
    const since = new Date(Date.now() - 86400000).toISOString();
    const res = await Promise.all([
      sb.from("posts").select("*, comments(id), hearts(user_id)").order("created_at", { ascending: false }).limit(limit),
      sb.from("posts").select("id,author_id,created_at").eq("also_day", true).gte("created_at", since).order("created_at")
    ]);
    if (res[0].error) { toast(res[0].error.message); return; }
    setPosts(res[0].data);
    setStories(res[1].data || []);
  }, [limit]);
  useEffect(function () { load(); }, [load, tick]);

  const seen = getSeen();
  const groups = {};
  stories.forEach(function (s) {
    if (!groups[s.author_id]) groups[s.author_id] = [];
    groups[s.author_id].push(s.id);
  });
  const others = Object.keys(groups).filter(function (id) { return id !== me.id; }).map(function (id) {
    return { id: id, allSeen: groups[id].every(function (x) { return seen.has(x); }) };
  }).sort(function (a, b) { return (a.allSeen ? 1 : 0) - (b.allSeen ? 1 : 0); });
  const mine = groups[me.id];
  const mineSeen = mine ? mine.every(function (x) { return seen.has(x); }) : false;

  if (!posts) return html`<div className="center muted" style=${{ padding: "4rem 1rem" }}>Loading your Inner Circle...</div>`;
  return html`
    <div>
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
          return html`<button className="story" key=${g.id} aria-label=${"View " + (p.display_name || "their") + " day"} onClick=${function () { push({ name: "story", authorId: g.id }); }}>
            <div className=${"ring " + (g.allSeen ? "seen" : "")}><${Avatar} id=${g.id} name=${p.display_name} size=${60} /></div>
            <div className="slabel" style=${{ color: g.allSeen ? "var(--muted)" : "inherit" }}>${first(p.display_name)}</div>
          </button>`;
        })}
      </div>
      ${posts.length === 0 && html`
        <div className="center" style=${{ padding: "3rem 1.5rem" }}>
          <h2 className="serif" style=${{ color: "#2f5d50" }}>It is quiet in here</h2>
          <p className="muted">Be the first to share a moment with your Inner Circle.</p>
          <button className="btn" onClick=${function () { push({ name: "new" }); }}>Share something</button>
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
  const urls = useUrls(items || []);
  const author = profiles[authorId] || {};

  useEffect(function () {
    (async function () {
      const since = new Date(Date.now() - 86400000).toISOString();
      const r = await sb.from("posts").select("*").eq("author_id", authorId).eq("also_day", true).gte("created_at", since).order("created_at");
      setItems(r.data || []);
    })();
  }, [authorId]);

  const cur = items && items[i];
  useEffect(function () {
    if (!cur) return;
    markSeen(cur.id);
    const t = setTimeout(function () { if (i + 1 < items.length) setI(i + 1); else back(); }, 6000);
    return function () { clearTimeout(t); };
  }, [cur && cur.id]);

  if (!items) return html`<div className="viewer"></div>`;
  if (!items.length) {
    return html`<div className="viewer"><div className="vh"><button className="ibtn" style=${{ color: "#fff" }} aria-label="Close" onClick=${back}><${Icon} n="close" /></button></div>
      <div className="vimg center" style=${{ padding: "2rem" }}>Nothing to see right now. Moments in Your day disappear after 24 hours.</div></div>`;
  }
  const url = urls(cur.image_path);
  return html`
    <div className="viewer">
      <div className="bars">${items.map(function (s, k) { return html`<div key=${s.id}><i style=${{ width: k < i ? "100%" : k === i ? "100%" : "0%" }}></i></div>`; })}</div>
      <div className="vh">
        <${Avatar} id=${authorId} name=${author.display_name} size=${34} />
        <div className="grow"><b>${authorId === me.id ? "Your day" : author.display_name}</b> <span style=${{ opacity: .7, fontSize: ".85rem" }}>${agoShort(cur.created_at)}</span></div>
        <button className="ibtn" style=${{ color: "#fff" }} aria-label="Close" onClick=${back}><${Icon} n="close" /></button>
      </div>
      <div className="vimg">
        <button className="tap" style=${{ left: 0 }} aria-label="Previous" onClick=${function () { if (i > 0) setI(i - 1); }}></button>
        <button className="tap" style=${{ right: 0 }} aria-label="Next" onClick=${function () { if (i + 1 < items.length) setI(i + 1); else back(); }}></button>
        ${cur.image_path
          ? (url ? html`<img src=${url} alt=${"Moment from " + (author.display_name || "family")} />` : html`<div className="muted">Loading...</div>`)
          : html`<div className="serif center" style=${{ padding: "2rem", fontSize: "1.6rem" }}>${cur.caption}</div>`}
      </div>
      ${cur.image_path && cur.caption && html`<div className="vcap">${cur.caption}</div>`}
    </div>`;
}

/* =====================  comments (with replies)  ===================== */
function Comments({ postId }) {
  const { me, profiles, toast, back } = useApp();
  const [post, setPost] = useState(null);
  const [list, setList] = useState([]);
  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState(null);
  const [busy, setBusy] = useState(false);
  const input = useRef(null);

  const load = useCallback(async function () {
    const res = await Promise.all([
      sb.from("posts").select("*").eq("id", postId).maybeSingle(),
      sb.from("comments").select("*, comment_hearts(user_id)").eq("post_id", postId).order("created_at")
    ]);
    if (res[1].error) { toast(res[1].error.message); return; }
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
    const top = c.parent_id ? list.find(function (x) { return x.id === c.parent_id; }) || c : c;
    setReplyTo(top);
    setText("@" + first((profiles[c.author_id] || {}).display_name) + " ");
    if (input.current) input.current.focus();
  }

  const authorOf = function (id) { return (profiles[id] || {}).display_name || "Someone"; };
  const tops = list.filter(function (c) { return !c.parent_id; });
  const repliesOf = function (id) { return list.filter(function (c) { return c.parent_id === id; }); };

  function Row({ c, reply }) {
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
      <button className="ibtn" style=${{ width: "2.4rem", height: "2.4rem" }} aria-label=${hearted ? "Remove heart" : "Heart this comment"} onClick=${function () { toggleHeart(c); }}>
        <${Icon} n="heart" s=${18} fill=${hearted ? "#d1352b" : "none"} color=${hearted ? "#d1352b" : "#6b6b6b"} sw=${2} />
      </button>
    </div>`;
  }

  return html`
    <div style=${{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <${TopBar} title="Comments" back=${back} />
      <div style=${{ flex: 1 }}>
        ${post && html`<div className="cmt" style=${{ borderBottom: "1px solid var(--soft)", paddingBottom: ".9rem" }}>
          <${Avatar} id=${post.author_id} name=${authorOf(post.author_id)} size=${36} />
          <div className="grow" style=${{ fontSize: ".9rem" }}>
            <div style=${{ overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}><b style=${{ fontWeight: 600 }}>${authorOf(post.author_id)}</b> ${post.caption || "Shared a photo"}</div>
            <div className="meta">${agoShort(post.created_at)}</div>
          </div></div>`}
        ${tops.length === 0 && html`<div className="center muted" style=${{ padding: "2rem 1rem" }}>No comments yet. Say something kind.</div>`}
        ${tops.map(function (c) {
          return html`<div key=${c.id}>${Row({ c: c, reply: false })}${repliesOf(c.id).map(function (r) { return Row({ c: r, reply: true }); })}</div>`;
        })}
      </div>
      <form className="composer" onSubmit=${send}>
        <${Avatar} id=${me.id} name=${me.display_name} size=${36} />
        <label className="sr" htmlFor="cm-in">Add a comment</label>
        <input id="cm-in" ref=${input} type="text" value=${text} maxLength="2000"
          placeholder=${replyTo ? "Reply to " + first(authorOf(replyTo.author_id)) + "..." : "Add a comment" + (post ? " for " + first(authorOf(post.author_id)) : "") + "..."}
          onChange=${function (e) { setText(e.target.value); }} />
        <button className="tbtn" disabled=${busy || !text.trim()}>Post</button>
      </form>
    </div>`;
}

/* =====================  new post  ===================== */
function NewPost({ day }) {
  const { me, toast, back, bump } = useApp();
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState("");
  const [caption, setCaption] = useState("");
  const [place, setPlace] = useState("");
  const [alsoDay, setAlsoDay] = useState(!!day);
  const [busy, setBusy] = useState(false);
  const input = useRef(null);

  function pick(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    setFile(f);
    setPreview(URL.createObjectURL(f));
  }

  async function submit() {
    if (!file && !caption.trim()) { toast("Add a photo or write a few words first."); return; }
    setBusy(true);
    try {
      let path = null;
      if (file) {
        const blob = await shrink(file);
        path = me.id + "/" + (window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now())) + ".jpg";
        const up = await sb.storage.from("photos").upload(path, blob, { contentType: "image/jpeg" });
        if (up.error) throw up.error;
      }
      const r = await sb.from("posts").insert({ author_id: me.id, caption: caption.trim(), image_path: path, place: place.trim(), also_day: alsoDay });
      if (r.error) throw r.error;
      toast("Shared with your Inner Circle");
      back();
      bump();
    } catch (err) {
      toast(err.message || "Could not share. Please try again.");
      setBusy(false);
    }
  }

  return html`
    <div>
      <${TopBar} title="New post" back=${back} right=${html`<button className="tbtn" onClick=${submit} disabled=${busy}>${busy ? "..." : "Share"}</button>`} />
      <input ref=${input} type="file" accept="image/*" onChange=${pick} style=${{ display: "none" }} />
      <div className="row" style=${{ alignItems: "flex-start", padding: "1rem", borderBottom: "1px solid var(--soft)" }}>
        <button onClick=${function () { input.current.click(); }} aria-label=${file ? "Choose a different photo" : "Choose a photo"}
          style=${{ flex: "none", width: "5.5rem", height: "5.5rem", borderRadius: ".4rem", border: preview ? 0 : "1px dashed #b9b9b9", background: "#f4f4f4", padding: 0, overflow: "hidden", cursor: "pointer", color: "var(--muted)", fontSize: ".75rem" }}>
          ${preview ? html`<img src=${preview} alt="Your chosen photo" style=${{ width: "100%", height: "100%", objectFit: "cover" }} />` : html`<span>Add photo</span>`}
        </button>
        <label className="sr" htmlFor="np-cap">Caption</label>
        <textarea id="np-cap" className="field" style=${{ border: 0, background: "#fff", height: "5.5rem" }} maxLength="3000"
          placeholder="Tell them what is happening, who is in it, how it felt..." value=${caption} onChange=${function (e) { setCaption(e.target.value); }}></textarea>
      </div>
      <div className="opt">
        <label className="sr" htmlFor="np-place">Add a place</label>
        <input id="np-place" className="field" style=${{ border: 0, background: "#fff", padding: 0, height: "2.5rem" }} placeholder="Add a place" maxLength="80" value=${place} onChange=${function (e) { setPlace(e.target.value); }} />
      </div>
      <div className="opt">
        <div className="grow"><div>Also add to Your day</div><div className="muted" style=${{ fontSize: ".75rem" }}>Shows at the top for 24 hours</div></div>
        <button role="switch" aria-checked=${alsoDay} aria-label="Also add to Your day" className=${"switch " + (alsoDay ? "on" : "")} onClick=${function () { setAlsoDay(!alsoDay); }}><i></i></button>
      </div>
      <div className="opt">
        <${Logo} s=${22} />
        <div className="grow"><div style=${{ fontWeight: 600 }}>Visible to your Inner Circle only</div><div className="muted" style=${{ fontSize: ".75rem" }}>Never public. Never searchable.</div></div>
      </div>
      <div style=${{ padding: "1rem" }}><button className="btn block" style=${{ height: "3.1rem" }} onClick=${submit} disabled=${busy}>${busy ? "Sharing..." : "Share with your Inner Circle"}</button></div>
    </div>`;
}

/* =====================  profile  ===================== */
function Profile({ userId, root }) {
  const { me, profiles, toast, push, back, tick } = useApp();
  const [posts, setPosts] = useState(null);
  const [hellos, setHellos] = useState(0);
  const p = profiles[userId] || {};
  const mine = userId === me.id;
  const urls = useUrls(posts || []);

  useEffect(function () {
    (async function () {
      const res = await Promise.all([
        sb.from("posts").select("id,caption,image_path,created_at").eq("author_id", userId).order("created_at", { ascending: false }).limit(90),
        sb.from("hellos").select("id", { count: "exact", head: true }).eq("to_id", userId)
      ]);
      setPosts(res[0].data || []);
      setHellos(res[1].count || 0);
    })();
  }, [userId, tick]);

  async function hello() {
    const r = await sb.from("hellos").insert({ from_id: me.id, to_id: userId });
    if (r.error) { toast(r.error.message); return; }
    toast("Hello sent to " + first(p.display_name));
    setHellos(function (n) { return n + 1; });
  }

  const t = p.created_at ? tenure(p.created_at) : ["0", "days here"];
  const gear = mine ? html`<button className="ibtn" aria-label="Settings" onClick=${function () { push({ name: "settings" }); }}><${Icon} n="gear" s=${24} /></button>` : null;
  return html`
    <div>
      ${root
        ? html`<div className="top"><div className="brand" style=${{ fontSize: "1.3rem" }}>${p.display_name || "You"}</div>${gear}</div>`
        : html`<${TopBar} title=${p.display_name || "Profile"} back=${back} />`}
      <div className="row" style=${{ padding: ".6rem 1.1rem", gap: "1.4rem" }}>
        <div className="ring" style=${{ width: "5.5rem", height: "5.5rem", flex: "none", margin: 0, borderColor: "var(--amber)" }}><${Avatar} id=${userId} name=${p.display_name} size=${72} /></div>
        <div className="row" style=${{ flex: 1, justifyContent: "space-around" }}>
          <div className="stat"><b>${posts ? posts.length : "-"}</b><span>moments</span></div>
          <div className="stat"><b>${t[0]}</b><span>${t[1]}</span></div>
          <div className="stat"><b>${hellos}</b><span>${hellos === 1 ? "hello" : "hellos"}</span></div>
        </div>
      </div>
      <div style=${{ padding: "0 1.1rem .8rem", fontSize: ".9rem" }}>
        <div style=${{ fontWeight: 600 }}>${p.display_name}</div>
        ${p.bio ? html`<div style=${{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>${p.bio}</div>` : mine ? html`<div className="muted">Add a few words about yourself in Edit profile.</div>` : null}
      </div>
      <div className="row" style=${{ padding: "0 1.1rem 1rem" }}>
        ${mine
          ? html`<button className="btn grey grow" onClick=${function () { push({ name: "settings" }); }}>Edit profile</button>`
          : html`<button className="btn grow" onClick=${hello}>Say hello</button>`}
      </div>
      <div className="tabline"><div className="on"><${Icon} n="grid" s=${24} sw=${2} /></div></div>
      ${posts && posts.length === 0 && html`<div className="center muted" style=${{ padding: "2.5rem 1rem" }}>${mine ? "Share your first moment with your Inner Circle." : "Nothing shared yet."}</div>`}
      <div className="grid">
        ${(posts || []).map(function (x) {
          const u = urls(x.image_path);
          return html`<button className="cell" key=${x.id} aria-label="Open post" onClick=${function () { push({ name: "post", id: x.id }); }}>
            ${x.image_path ? (u ? html`<img src=${u} alt="" loading="lazy" />` : null) : html`<div className="t">${x.caption}</div>`}
          </button>`;
        })}
      </div>
    </div>`;
}

function SinglePost({ id }) {
  const { toast, back, tick } = useApp();
  const [post, setPost] = useState(undefined);
  const load = useCallback(async function () {
    const r = await sb.from("posts").select("*, comments(id), hearts(user_id)").eq("id", id).maybeSingle();
    if (r.error) toast(r.error.message);
    setPost(r.data || null);
  }, [id]);
  useEffect(function () { load(); }, [load, tick]);
  return html`<div><${TopBar} title="Post" back=${back} />
    ${post === undefined ? html`<div className="center muted" style=${{ padding: "3rem" }}>Loading...</div>` : post === null ? html`<div className="center muted" style=${{ padding: "3rem" }}>This post is no longer here.</div>` : html`<${PostCard} post=${post} onChange=${load} />`}</div>`;
}

/* =====================  people  ===================== */
function People() {
  const { me, profiles, toast, push, tick } = useApp();
  const [last, setLast] = useState(null);
  const [code, setCode] = useState("");

  useEffect(function () {
    (async function () {
      const r = await sb.from("posts").select("author_id,created_at").order("created_at", { ascending: false }).limit(1000);
      const m = {};
      (r.data || []).forEach(function (x) { if (!m[x.author_id]) m[x.author_id] = x.created_at; });
      setLast(m);
      if (me.role === "admin") {
        const s = await sb.from("settings").select("invite_code").eq("id", 1).maybeSingle();
        setCode((s.data || {}).invite_code || "");
      }
    })();
  }, [tick]);

  const members = Object.keys(profiles).map(function (k) { return profiles[k]; }).filter(function (x) { return x.status === "approved"; })
    .sort(function (a, b) { return (a.display_name || "").localeCompare(b.display_name || ""); });

  async function hello(m) {
    const r = await sb.from("hellos").insert({ from_id: me.id, to_id: m.id });
    toast(r.error ? r.error.message : "Hello sent to " + first(m.display_name));
  }

  if (!last) return html`<div className="center muted" style=${{ padding: "4rem 1rem" }}>Loading...</div>`;
  const quietOf = function (m) { return m.id !== me.id && (!last[m.id] || daysSince(last[m.id]) >= 14); };
  const active = members.filter(function (m) { return !quietOf(m); });
  const quiet = members.filter(quietOf);

  function Row({ m }) {
    const l = last[m.id];
    return html`<div className="listrow" style=${{ cursor: "default" }}>
      <button style=${{ background: "none", border: 0, padding: 0, display: "flex", gap: ".75rem", alignItems: "center", textAlign: "left", flex: 1, minWidth: 0, cursor: "pointer" }} onClick=${function () { push({ name: "profile", userId: m.id }); }}>
        <${Avatar} id=${m.id} name=${m.display_name} size=${52} />
        <div style=${{ minWidth: 0 }}>
          <div style=${{ fontWeight: 600 }}>${m.display_name}${m.id === me.id ? " (you)" : ""}</div>
          <div className="muted" style=${{ fontSize: ".8rem" }}>${l ? "Shared " + agoLong(l) : "Has not shared yet"}</div>
        </div>
      </button>
      ${quietOf(m) && html`<button className="btn sm" onClick=${function () { hello(m); }}>Say hello</button>`}
    </div>`;
  }

  return html`
    <div>
      <div className="top"><div><h1 className="serif" style=${{ color: "#2f5d50", fontSize: "1.7rem" }}>Your Inner Circle</h1></div></div>
      <div className="muted" style=${{ padding: "0 1rem .4rem", fontSize: ".85rem" }}>${members.length} ${members.length === 1 ? "person" : "people"}. Everyone here was invited by family.</div>
      ${active.map(function (m) { return html`<${Row} key=${m.id} m=${m} />`; })}
      ${quiet.length > 0 && html`<div className="hdr">It has been a while. Maybe say hello.</div>`}
      ${quiet.map(function (m) { return html`<${Row} key=${m.id} m=${m} />`; })}
      ${me.role === "admin" && html`<div className="card row"><${Icon} n="plusSmall" s=${26} sw=${2} color="#2f5d50" />
        <div className="grow"><div style=${{ fontWeight: 600 }}>Invite someone you trust</div><div className="muted" style=${{ fontSize: ".8rem" }}>Share the app address and this code: <b>${code}</b></div></div></div>`}
    </div>`;
}

/* =====================  memories  ===================== */
function Memories() {
  const { toast, tick } = useApp();
  const [posts, setPosts] = useState(null);
  const load = useCallback(async function () {
    const r = await sb.from("posts").select("*, comments(id), hearts(user_id)").order("created_at", { ascending: false }).limit(1000);
    if (r.error) { toast(r.error.message); return; }
    const now = new Date();
    setPosts((r.data || []).filter(function (p) {
      const d = new Date(p.created_at);
      return d.getMonth() === now.getMonth() && d.getDate() === now.getDate() && d.getFullYear() < now.getFullYear();
    }));
  }, []);
  useEffect(function () { load(); }, [load, tick]);
  return html`
    <div>
      <div className="top"><div><h1 className="serif" style=${{ color: "#2f5d50", fontSize: "1.7rem" }}>On this day</h1></div></div>
      <div className="muted" style=${{ padding: "0 1rem .6rem", fontSize: ".85rem" }}>Moments your Inner Circle shared on this date in years past.</div>
      ${!posts && html`<div className="center muted" style=${{ padding: "3rem" }}>Looking back...</div>`}
      ${posts && posts.length === 0 && html`<div className="center muted" style=${{ padding: "3rem 1.5rem" }}>Nothing from this date yet. Keep sharing and this page will fill with memories.</div>`}
      ${(posts || []).map(function (p) { return html`<${PostCard} key=${p.id} post=${p} onChange=${load} />`; })}
    </div>`;
}

/* =====================  activity  ===================== */
async function fetchActivity(me) {
  const res = await Promise.all([
    sb.from("comments").select("id,post_id,author_id,body,created_at,posts!inner(author_id)").eq("posts.author_id", me.id).neq("author_id", me.id).order("created_at", { ascending: false }).limit(30),
    sb.from("hearts").select("post_id,user_id,created_at,posts!inner(author_id)").eq("posts.author_id", me.id).neq("user_id", me.id).order("created_at", { ascending: false }).limit(30),
    sb.from("hellos").select("id,from_id,created_at").eq("to_id", me.id).order("created_at", { ascending: false }).limit(30)
  ]);
  const items = [];
  (res[0].data || []).forEach(function (c) { items.push({ k: "c" + c.id, kind: "comment", who: c.author_id, post: c.post_id, text: c.body, at: c.created_at }); });
  (res[1].data || []).forEach(function (h) { items.push({ k: "h" + h.post_id + h.user_id, kind: "heart", who: h.user_id, post: h.post_id, at: h.created_at }); });
  (res[2].data || []).forEach(function (h) { items.push({ k: "x" + h.id, kind: "hello", who: h.from_id, at: h.created_at }); });
  items.sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
  return items.slice(0, 40);
}

function Activity() {
  const { me, profiles, push, back, clearUnread } = useApp();
  const [items, setItems] = useState(null);
  useEffect(function () {
    fetchActivity(me).then(function (r) { setItems(r); lsSet("ic-activity-seen", String(Date.now())); clearUnread(); });
  }, []);
  return html`<div><${TopBar} title="Activity" back=${back} />
    ${!items && html`<div className="center muted" style=${{ padding: "3rem" }}>Loading...</div>`}
    ${items && items.length === 0 && html`<div className="center muted" style=${{ padding: "3rem 1.5rem" }}>Hearts, comments and hellos from your Inner Circle will show up here.</div>`}
    ${(items || []).map(function (a) {
      const name = (profiles[a.who] || {}).display_name || "Someone";
      const line = a.kind === "hello" ? " says hello." : a.kind === "heart" ? " loved your post." : " commented: " + a.text;
      return html`<button className="listrow" key=${a.k} onClick=${function () { a.post ? push({ name: "comments", postId: a.post }) : push({ name: "profile", userId: a.who }); }}>
        <${Avatar} id=${a.who} name=${name} size=${44} />
        <div className="grow" style=${{ fontSize: ".9rem", overflowWrap: "anywhere" }}><b style=${{ fontWeight: 600 }}>${name}</b>${line} <span className="muted">${agoShort(a.at)}</span></div>
      </button>`;
    })}</div>`;
}

/* =====================  settings / edit profile / organizer  ===================== */
function Admin() {
  const { me, toast } = useApp();
  const [list, setList] = useState([]);
  const [code, setCode] = useState("");
  const load = useCallback(async function () {
    const res = await Promise.all([
      sb.from("profiles").select("*").order("created_at"),
      sb.from("settings").select("invite_code").eq("id", 1).maybeSingle()
    ]);
    setList(res[0].data || []);
    setCode((res[1].data || {}).invite_code || "");
  }, []);
  useEffect(function () { load(); }, [load]);

  async function setStatus(id, status) {
    const r = await sb.rpc("set_member_status", { target: id, new_status: status });
    toast(r.error ? r.error.message : "Done");
    load();
  }
  async function saveCode() {
    const c = code.trim();
    if (c.length < 6) { toast("Please use at least 6 characters."); return; }
    const r = await sb.from("settings").update({ invite_code: c }).eq("id", 1);
    toast(r.error ? r.error.message : "New invite code saved");
  }
  const pending = list.filter(function (p) { return p.status === "pending"; });
  const approved = list.filter(function (p) { return p.status === "approved" && p.id !== me.id; });
  return html`
    <div style=${{ padding: "1rem", borderTop: "8px solid var(--soft)" }}>
      <h2 className="serif" style=${{ color: "#2f5d50", fontSize: "1.3rem" }}>Family organizer</h2>
      <div style=${{ fontWeight: 600, margin: ".9rem 0 .2rem" }}>Invite code</div>
      <div className="muted" style=${{ fontSize: ".8rem", marginBottom: ".5rem" }}>Anyone who joins with this code is let in right away. Change it any time to close the door.</div>
      <div className="row"><input className="field" value=${code} onChange=${function (e) { setCode(e.target.value); }} aria-label="Invite code" autoCapitalize="characters" /><button className="btn" onClick=${saveCode}>Save</button></div>
      <div style=${{ fontWeight: 600, margin: "1.2rem 0 .3rem" }}>Waiting to be welcomed (${pending.length})</div>
      ${!pending.length && html`<div className="muted" style=${{ fontSize: ".85rem" }}>Nobody is waiting.</div>`}
      ${pending.map(function (p) {
        return html`<div className="row" key=${p.id} style=${{ margin: ".5rem 0" }}><div className="grow" style=${{ fontWeight: 600 }}>${p.display_name}</div>
          <button className="btn sm" onClick=${function () { setStatus(p.id, "approved"); }}>Welcome</button>
          <button className="btn sm danger" onClick=${function () { setStatus(p.id, "removed"); }}>No</button></div>`;
      })}
      <div style=${{ fontWeight: 600, margin: "1.2rem 0 .3rem" }}>Members</div>
      ${!approved.length && html`<div className="muted" style=${{ fontSize: ".85rem" }}>Just you so far.</div>`}
      ${approved.map(function (p) {
        return html`<div className="row" key=${p.id} style=${{ margin: ".5rem 0" }}><div className="grow">${p.display_name}</div>
          <button className="btn sm danger" onClick=${function () { if (confirm("Remove " + p.display_name + " from Inner Circle?")) setStatus(p.id, "removed"); }}>Remove</button></div>`;
      })}
    </div>`;
}

function Settings() {
  const { me, toast, back, reloadProfiles, reloadMe, easy, setEasy } = useApp();
  const [name, setName] = useState(me.display_name || "");
  const [bio, setBio] = useState(me.bio || "");
  const [busy, setBusy] = useState(false);

  async function save() {
    const n = name.trim();
    if (!n) { toast("Your name cannot be empty."); return; }
    setBusy(true);
    const r = await sb.from("profiles").update({ display_name: n, bio: bio.trim() }).eq("id", me.id);
    setBusy(false);
    if (r.error) { toast(r.error.message); return; }
    toast("Profile saved");
    await reloadMe();
    reloadProfiles();
  }

  return html`
    <div>
      <${TopBar} title="Edit profile" back=${back} right=${html`<button className="tbtn" onClick=${save} disabled=${busy}>Save</button>`} />
      <div style=${{ padding: "1rem" }} className="stack">
        <label htmlFor="s-name" style=${{ fontWeight: 600 }}>Name</label>
        <input id="s-name" className="field" value=${name} onChange=${function (e) { setName(e.target.value); }} maxLength="60" />
        <label htmlFor="s-bio" style=${{ fontWeight: 600 }}>About you</label>
        <textarea id="s-bio" className="field" rows="3" maxLength="300" value=${bio} onChange=${function (e) { setBio(e.target.value); }} placeholder="Where you live, what you love, how to say hello..."></textarea>
      </div>
      <div className="opt" style=${{ borderTop: "1px solid var(--soft)" }}>
        <div className="grow"><div style=${{ fontWeight: 600 }}>Easy reading</div><div className="muted" style=${{ fontSize: ".8rem" }}>Bigger text and labeled buttons</div></div>
        <button role="switch" aria-checked=${easy} aria-label="Easy reading" className=${"switch " + (easy ? "on" : "")} onClick=${function () { setEasy(!easy); }}><i></i></button>
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
      <div style=${{ padding: "0 1rem 1rem", fontSize: ".85rem" }} className="muted">
        <b style=${{ color: "var(--ink)" }}>Put it on your home screen.</b><br />
        iPhone (Safari): tap Share, then Add to Home Screen.<br />
        Android (Chrome): tap the three dots, then Install app.
      </div>
      ${me.role === "admin" && html`<${Admin} />`}
      <div style=${{ padding: "1rem" }}><button className="btn grey block" onClick=${function () { sb.auth.signOut(); }}>Sign out</button></div>
    </div>`;
}

/* =====================  shell (tabs, history, data)  ===================== */
function Shell({ me, toast, reloadMe, easy, setEasy }) {
  const [stack, setStack] = useState([{ name: "home" }]);
  const [profiles, setProfiles] = useState({});
  const [tick, setTick] = useState(0);
  const [unread, setUnread] = useState(false);
  const stackRef = useRef(stack);
  stackRef.current = stack;

  const loadProfiles = useCallback(async function () {
    const r = await sb.from("profiles").select("id,display_name,bio,status,role,created_at");
    const m = {};
    (r.data || []).forEach(function (x) { m[x.id] = x; });
    setProfiles(m);
  }, []);
  useEffect(function () { loadProfiles(); }, [loadProfiles]);

  const bump = useCallback(function () { setTick(function (t) { return t + 1; }); }, []);

  const checkUnread = useCallback(async function () {
    const items = await fetchActivity(me);
    const seenAt = Number(lsGet("ic-activity-seen", "0"));
    setUnread(items.some(function (a) { return new Date(a.at).getTime() > seenAt; }));
  }, [me.id]);
  useEffect(function () { checkUnread(); }, [checkUnread, tick]);

  const push = useCallback(function (r) {
    try { history.pushState({ ic: 1 }, ""); } catch (e) {}
    setStack(function (s) { return s.concat([r]); });
    window.scrollTo(0, 0);
  }, []);
  const back = useCallback(function () {
    if (stackRef.current.length > 1) {
      let pushed = true;
      try { history.back(); } catch (e) { pushed = false; }
      if (!pushed) setStack(function (s) { return s.slice(0, -1); });
    }
  }, []);
  useEffect(function () {
    function onPop() { setStack(function (s) { return s.length > 1 ? s.slice(0, -1) : s; }); }
    window.addEventListener("popstate", onPop);
    return function () { window.removeEventListener("popstate", onPop); };
  }, []);
  useEffect(function () {
    function vis() { if (document.visibilityState === "visible") bump(); }
    document.addEventListener("visibilitychange", vis);
    return function () { document.removeEventListener("visibilitychange", vis); };
  }, [bump]);

  const tab = useCallback(function (name) {
    setStack(function (s) {
      if (s.length === 1 && s[0].name === name) { return s; }
      return [{ name: name }];
    });
    if (stackRef.current.length === 1 && stackRef.current[0].name === name) bump();
    window.scrollTo(0, 0);
  }, [bump]);

  const ctx = {
    me: me, profiles: profiles, toast: toast, push: push, back: back, tab: tab, tick: tick, bump: bump,
    reloadMe: reloadMe, reloadProfiles: loadProfiles, easy: easy, setEasy: setEasy,
    clearUnread: function () { setUnread(false); }
  };

  const route = stack[stack.length - 1];
  const rootName = stack[0].name;
  const hasNav = ["home", "people", "memories", "me", "profile", "post", "activity"].indexOf(route.name) >= 0;
  const key = stack.length + ":" + route.name + (route.userId || route.postId || route.id || route.authorId || "");

  let screen;
  switch (route.name) {
    case "home": screen = html`<${Home} />`; break;
    case "people": screen = html`<${People} />`; break;
    case "memories": screen = html`<${Memories} />`; break;
    case "me": screen = html`<${Profile} userId=${me.id} root=${true} />`; break;
    case "profile": screen = html`<${Profile} userId=${route.userId} root=${false} />`; break;
    case "post": screen = html`<${SinglePost} id=${route.id} />`; break;
    case "comments": screen = html`<${Comments} postId=${route.postId} />`; break;
    case "new": screen = html`<${NewPost} day=${route.day} />`; break;
    case "story": screen = html`<${StoryViewer} authorId=${route.authorId} />`; break;
    case "settings": screen = html`<${Settings} />`; break;
    case "activity": screen = html`<${Activity} />`; break;
    default: screen = html`<${Home} />`;
  }

  const tabs = [
    ["home", "Home", html`<${Icon} n="home" s=${28} fill=${rootName === "home" ? "currentColor" : "none"} sw=${rootName === "home" ? 2 : 1.8} />`],
    ["people", "People", html`<${Icon} n="people" s=${28} fill=${rootName === "people" ? "currentColor" : "none"} />`],
    ["new", "Share", html`<${Icon} n="plus" s=${28} />`],
    ["memories", "Memories", html`<${Icon} n="clock" s=${28} sw=${rootName === "memories" ? 2.6 : 1.8} />`],
    ["me", "Me", html`<div className="av" style=${{ width: "28px", height: "28px", fontSize: "13px", background: colorFor(me.id), outline: rootName === "me" ? "2px solid #111" : "none", outlineOffset: "2px" }}>${initial(me.display_name)}</div>`]
  ];

  return html`
    <${Ctx.Provider} value=${ctx}>
      <div className=${hasNav ? "page" : ""}>
        ${route.name === "home" && html`<div className="top"><div className="brand"><${Logo} />Inner Circle</div>
          <button className="ibtn" aria-label=${unread ? "Activity, new" : "Activity"} onClick=${function () { push({ name: "activity" }); }}><${Icon} n="heart" s=${26} />${unread && html`<span className="badge"></span>`}</button></div>`}
        <div key=${key}>${screen}</div>
      </div>
      ${hasNav && html`<nav className="nav" aria-label="Main">${tabs.map(function (t) {
        return html`<button key=${t[0]} aria-label=${t[1]} onClick=${function () { t[0] === "new" ? push({ name: "new" }) : tab(t[0]); }}>${t[2]}<span className="lbl">${t[1]}</span></button>`;
      })}</nav>`}
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
  const [easy, setEasyState] = useState(function () { return lsGet("ic-easy", "0") === "1"; });

  const toast = useCallback(function (m) {
    setMsg(m);
    setTimeout(function () { setMsg(""); }, 4500);
  }, []);
  function setEasy(v) { setEasyState(v); lsSet("ic-easy", v ? "1" : "0"); }
  useEffect(function () { document.documentElement.classList.toggle("easy", easy); }, [easy]);

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

  let body;
  if (!configured) body = html`<${NotConfigured} />`;
  else if (session === undefined) body = html`<div className="center muted" style=${{ padding: "5rem 1rem" }}>Loading...</div>`;
  else if (!session) body = html`<${AuthScreen} toast=${toast} />`;
  else if (recovery) body = html`<${NewPassword} toast=${toast} done=${function () { setRecovery(false); }} />`;
  else if (!me) body = html`<div className="center muted" style=${{ padding: "5rem 1rem" }}>Loading...</div>`;
  else if (me.status !== "approved") body = html`<${Waiting} me=${me} reloadMe=${loadMe} />`;
  else body = html`<${Shell} me=${me} toast=${toast} reloadMe=${loadMe} easy=${easy} setEasy=${setEasy} />`;

  return html`<div>${body}${msg && html`<div className="toast" role="status">${msg}</div>`}</div>`;
}

createRoot(document.getElementById("root")).render(html`<${App} />`);
