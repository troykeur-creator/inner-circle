# Inner Circle

A private, invite-only space for family and close friends to share moments, plan events and stay close. Think of a small family version of Instagram that you own, with no ads, no algorithm and no strangers.

**Live app:** https://troykeur-creator.github.io/inner-circle/

Everything is approved by an organizer. Nobody sees anything until they are welcomed in.

## What it does

**Sharing**
- Photos (up to 10) and a video in the same post, voice memos, GIFs, and an emoji picker
- "Your day" stories, short notes, comments, hearts, albums and an On this day memories page
- Share with everyone or just a group, and hide a post from specific people
- A weekly Friday family question, plus organizer-posted prompts and family news

**Getting to know each other**
- Profiles with favorites, finish-the-sentence answers, "Me in emoji", two truths and a lie, and this-or-that picks
- Profile themes: cover photo, colors, fonts, a song, and a Top 8
- Guess who?, a family game built from everyone's answers
- A gentle profile nudge that walks each person through the next step

**Family life**
- Events with RSVPs, bring-lists, a photo wall for a TV, and messages
- Birthdays and anniversaries, with well wishes
- Video chat rooms for up to 4 people, phone to phone, with an "X is calling" notification

**Joining and running it**
- One-time invite links that expire in 7 days
- Members can invite someone, and the organizer still approves every person
- Organizer tools: approve or remove people, family code, storage meter, backup, and switches for member invites and the Friday question
- Phone notifications (Web Push), installable to the home screen on iPhone and Android

## How it is built

No build step and no server of its own. The app is a handful of static files served by GitHub Pages.

| Part | Technology |
|---|---|
| App | React 18 and htm, loaded from esm.sh (no bundler) |
| Database and rules | Supabase Postgres with Row Level Security |
| Sign-in | Phone one-time codes (Twilio Verify through Supabase Auth) |
| Photos, video, audio | Supabase Storage, private bucket with signed links |
| Notifications | Supabase Edge Function `send-push` plus Web Push |
| Video chat | WebRTC, with Supabase Realtime private channels for signaling |
| Hosting | GitHub Pages |

### Files

| File | What it is |
|---|---|
| `index.html` | Page shell and all styles |
| `app.js` | The whole app |
| `config.js` | Your two public Supabase values (URL and anon key) |
| `sw.js` | Service worker (offline shell, notification taps). Bump the cache number on every release |
| `manifest.json`, `icon-*.png`, `icon.svg`, `apple-touch-icon.png` | Home-screen install |
| `schema.sql` | The entire database: tables, privacy rules, triggers. Safe to run again |
| `fix-phone-login.sql` | One-off sign-in repair, only if needed |
| `SETUP.md` | Step-by-step setup and a section for each release |

Two files are kept **private and are not in this repo**, because they contain keys:

- `push.sql` (notification triggers and schedules)
- `send-push.ts` (the notification Edge Function)

## Setting it up

Full click-by-click steps are in [`SETUP.md`](SETUP.md). In short:

1. Create a free Supabase project.
2. In the SQL Editor, run `schema.sql`.
3. Set up phone sign-in (Authentication, Providers, Phone) with Twilio Verify.
4. Put your Supabase URL and anon key in `config.js`. The anon key is meant to be public; the privacy rules in `schema.sql` protect the data.
5. Turn on GitHub Pages for this repo (Settings, Pages, deploy from the main branch).
6. Open the site and sign up. The first person to join becomes the organizer.
7. Optional: set up notifications by deploying the `send-push` Edge Function and running `push.sql`.

## Privacy and security model

- Every table has Row Level Security. Only approved members can read anything, and the browser can only change the columns it is explicitly granted.
- Photos and videos are in a private bucket and only shown through short-lived signed links.
- New people are held as "pending" until the organizer approves them, even if a member invited them.
- Invite links work once and expire. Members are limited to 5 waiting invites each.
- No analytics, ads or third-party trackers. Video chat uses Google's public STUN servers only to help phones find each other; the picture and sound go phone to phone and are never recorded.
- Never commit `push.sql`, `send-push.ts` or any service-role key.

## Known limits

- Video chat rooms hold 4 people (each phone sends to every other phone). Some networks block direct video; a free TURN relay can be added in `config.js` (see `SETUP.md`).
- On iPhone, notifications only work from the installed home-screen app, and video chat needs iOS 16 or newer.
- A phone that locks its screen will drop out of a video call.
- The free Supabase plan includes 1 GB of storage. The organizer screen shows usage.

## Releasing an update

1. Run any new SQL first (`schema.sql` is safe to run repeatedly).
2. Upload the changed files to GitHub.
3. Bump the cache number in `sw.js` so phones pick up the new version.
4. Close and reopen the app twice on each phone.

## License

Private family project. All rights reserved.
