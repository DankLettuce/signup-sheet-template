# Class sign-up page (template)

A phone-first "who's bringing what" sign-up page for a class party or any small event. Parents tap the
items they can bring, type their name once, and they're done. The organizer manages everything from the
page itself (Organizer mode). No accounts, no app.

Built on **Cloudflare Pages + Pages Functions + D1** (free plan is plenty). One copy of this repo = one
sign-up page. Everything event-specific lives in **`site.config.json`**. You don't need to change any code.

> All names, emails and places in this repo are made up (Ms. Rivera, Jamie Example, Maple Grove
> Elementary, `example.com`). Never commit real parents' names, the class code, or any key.

---

## What parents see

- Event header: teacher + class + event name, school, date and time, a short message, and the banner
  (moving, still, or none).
- The item list. Open items come first, and covered ones fold to one line ("— covered ✓"). Each item
  shows "2 of 3 spots open".
- **Add your own** goes below the list by default, after the fixed items and the ones already signed up.
- One "Sign me up" step: **"Your name (shown on the list)"** plus an optional note. The name is remembered
  on that phone.
- "Already signed up" summary, "Add to calendar" (.ics), tap any name to edit or remove it, and
  "Recently removed" with Put back.
- **Class code (optional).** When it's on, the page asks for the code from the organizer's email before
  it shows anything (names are private). It asks once per phone; a cookie remembers it for 120 days.

## What the organizer can do (Organizer mode)

Tap **Organizer** at the bottom of the page. This turns on Organizer mode for that phone only.

| Button | What it does |
|---|---|
| **Event details** (or the pencil next to the date) | Edit the event name, teacher, class, school, date, time, the message at the top, organizer name and contact, the banner (moving / still / none), and where "Add your own" goes (below / above the list). |
| **Add an item** | New item at the end of the list, with how many people. |
| Under each item: **Spots**, **Rename / remove**, **↑ ↓** | Change how many people, rename, remove (it goes to "Recently removed" with its sign-ups and can be put back), or move it up or down. In Organizer mode the list shows its true order. |
| **Back up the list** | Downloads a spreadsheet file (CSV: Item, Spots, Person, Note, Signed up, including open spots). |
| **Full backup file** | Downloads everything as JSON, including removed sign-ups (no visitor hashes, no IPs). |
| **Copy this event** | Downloads the event details and items (no names, no sign-ups, no code) to start a new sign-up page: `node scripts/configure.mjs --from <file>`. |
| "Class code: on/off" | Shows whether the page is protected by a class code. |

Organizer mode has no password. Anyone who has the link (and the class code, if one is on) can turn it on.
This matches the original page: parents can already edit any sign-up. It's fine for a class party, but don't
use this for anything sensitive.

---

## Files

| Path | What |
|---|---|
| `site.config.json` | **The only file you edit for a new page.** Project name, D1 database, time zone, theme, event details, organizer, class code on/off (never the code itself), "Add your own" position, starting items. |
| `scripts/configure.mjs` | Validates the config and writes `seed.sql`, `wrangler.toml`, `worker-backup/wrangler.toml` and the theme paths in `public/index.html`. Never talks to Cloudflare. |
| `schema.sql` | Database tables (safe to re-run). No data. |
| `seed.sql` | Generated. Event details and starting items. Only fills an **empty** database, so it never overwrites the organizer's edits. |
| `functions/api/[[path]].js` | The API (state, sign-ups, items, settings, unlock, exports, calendar). |
| `lib/` | `settings.js` (editable event fields and their limits), `gate.js` (class code), `ics.js` (calendar file), `visitor.js` (hashed visitor ids), `snapshot.js`. |
| `public/` | The page (`index.html`, `app.js`, `styles.css`) and `themes/` (`vintage-poster` is complete; `halloween` is an older look without the banner art). |
| `worker-backup/` | Optional cron Worker: a daily snapshot of the data into the same D1 database. |
| `scripts/dev.sh` | Local server (local D1 copy, nothing remote). |
| `scripts/test.mjs`, `scripts/test-admin.mjs`, `scripts/ui-check.mjs` | API tests, recovery-tool tests, and a phone-width browser check. |
| `scripts/snapshot.mjs`, `scripts/revert-visitor.mjs` | Recovery tools (take/restore snapshots; undo everything one visitor changed). `--remote` for the live database. Times are typed in US Eastern. |
| `deploy.sh` | Backs up the database, applies schema + seed, and deploys. It refuses to run with a dirty git tree or a placeholder database id. |

Requirements: Node 22+, `npm ci` (installs wrangler). Chrome plus `puppeteer-core` only for the browser check.

---

## Make a new sign-up page (step by step)

1. **Copy the repo**: use it as a GitHub template, or `git clone` it, then `npm ci`.
2. **Edit `site.config.json`**:
   - `site.project_name`: becomes `https://<project_name>.pages.dev`. Use lowercase, numbers and dashes.
   - `site.database_name`: usually the same as the project name.
   - `site.database_id`: leave the zeros until step 5.
   - `site.timezone`: `America/New_York` gets a real time zone in calendar files; any other zone uses
     "local time" in the calendar file.
   - `site.theme`: a folder in `public/themes/`.
   - `event.*`:
     - `event_name` (≤60 characters); `teacher`, `class_name` and `school` (≤60 each, may be blank).
     - `party_date` and `party_time` (≤60, free text; "TBD" is fine). Write dates like
       `Friday, October 30, 2026` or `10/30/2026` so "Add to calendar" works.
     - `intro` (≤300) and `banner` (`animated` / `still` / `none`).
   - `organizer.name` / `organizer.contact` (shown at the bottom; may be blank).
   - `class_code.use_code`: `true` or `false`. **Put the code itself only in the secret (step 6).**
   - `add_your_own`: `bottom` (default) or `top`.
   - `items`: `[{ "name": "...", "spots": 1-99 }]`, at most 40, with no duplicate names.
   - Starting from an older event? Use `node scripts/configure.mjs --from my-event-copy.json` (the
     "Copy this event" file). It merges that file into the config. Then change the date.
3. **Generate**: `node scripts/configure.mjs` (or `--check` to only validate).
4. **Try it locally** (see "Local testing" below).
5. **Create the database**: `npx wrangler login`, then `npx wrangler d1 create <database_name>`. Put the
   printed `database_id` into `site.config.json`, run `node scripts/configure.mjs` again, and commit.
6. **Class code (if `use_code` is true)**: pick a short code (for example `BOO-123`; case, spaces and
   dashes don't matter).
   - First deploy creates the Pages project: `npx wrangler pages project create <project_name> --production-branch main`.
   - Then: `npx wrangler pages secret put CLASS_CODE --project-name <project_name>`.
   - Optional extra secret: `npx wrangler pages secret put VISITOR_SALT --project-name <project_name>`
     (any random text). It makes visitor hashes and pass cookies unique to this site.
   - Send the code **in the same email as the link**. Changing the code later logs everyone out; they
     type the new one once.
   - To turn the code off, delete the secret: `npx wrangler pages secret delete CLASS_CODE --project-name <project_name>`.
7. **Deploy**: `./deploy.sh` (add `--worker` for the daily snapshot Worker). It backs up the database
   first (into `backups/`, gitignored).

---

## Local testing (QA)

Everything runs on your machine: a local D1 copy under `.wrangler/state` (or `$PERSIST`). It never
touches Cloudflare.

```bash
cd signup-template
npm ci
node scripts/configure.mjs                    # writes seed.sql etc. from site.config.json

# Server WITH a class code (made-up code for testing), fresh local database:
rm -rf /tmp/signup-qa
PERSIST=/tmp/signup-qa CLASS_CODE=BOO-123 scripts/dev.sh
#   -> open http://127.0.0.1:8788  (wrong code is refused; BOO-123 / boo 123 gets in)

# In a second terminal, with the SAME PERSIST and CLASS_CODE:
PERSIST=/tmp/signup-qa CLASS_CODE=BOO-123 node scripts/test.mjs          # API + class code tests (~3-4 min: it waits out rate-limit windows)
PERSIST=/tmp/signup-qa CLASS_CODE=BOO-123 node scripts/test-admin.mjs    # revert / snapshot / backup-worker tools

# Phone-width browser check (390 px). Needs Chrome + puppeteer-core (not a project dependency):
npm i --no-save puppeteer-core               # or PPTR_DIR=/path/with/node_modules
CLASS_CODE=BOO-123 node scripts/ui-check.mjs  # screenshots: /tmp/ui-check-*.png
```

- Run the API tests on a **fresh** database (a new `PERSIST` folder). They add test items, and the list
  holds at most 40.
- The class code allows 10 tries per 10 minutes per visitor, and locally every browser run is the same visitor (127.0.0.1). Re-running `ui-check.mjs` more than about 4 times on one database hits that limit ("Too many tries"). Use a new `PERSIST` folder, or wait 10 minutes.
- `ui-check.mjs` also writes a sign-up. For a clean look afterwards, restart with a new `PERSIST`.
- No class code: start `scripts/dev.sh` without `CLASS_CODE` and run the tests without it too. The gate
  tests are then skipped, and the tests check that `state.code` is false.
- `.dev.vars` (gitignored) also works for local secrets: `CLASS_CODE=BOO-123`.
- `TEST_HOOKS=1` is set only by `dev.sh`. It enables the rollback test headers and must never be set on
  the live site.

---

## How it's built (for maintainers)

- **API** (`/api/...`, all JSON):
  - `GET state` returns `{settings, items[{id,name,needed,sort,is_custom,entries}], removed, removed_items, calendar, code, limits}`.
  - `POST unlock {code}`.
  - `POST entries`, `PUT/DELETE entries/:id`, `POST entries/:id/restore`.
  - `POST batch {name, note, rows, others}` is the all-or-nothing sign-up.
  - `POST items`, `PUT items/:id {name?, needed?}` or `{move:-1|1}`, `DELETE items/:id`, `POST items/:id/restore`.
  - `PUT settings {key,value}` or `{values:{...}}`.
  - `GET export.csv`, `GET export.json`, `GET event-copy.json`, `GET calendar.ics?name=&item=`.
- **Class code**:
  - On when `CLASS_CODE` is non-empty.
  - `POST /api/unlock` allows 10 tries per 10 minutes per visitor. On success it sets an `HttpOnly;
    SameSite=Lax` cookie `signup_pass` (a salted SHA-256 of the normalized code, never the code). The cookie
    is `Secure` on https.
  - Without a valid pass, every other `/api` route answers `401 {gate:true}`. `GET /api/state` adds
    only `event_name`.
- **Safety**:
  - Prepared statements only, length limits everywhere, JSON-only writes, same-origin check.
  - Per-visitor rate limits (burst + 10-minute) and a per-visitor cap.
  - Soft delete + full history; Undo / Put back re-check spots inside the transaction.
  - CSP without `unsafe-inline`, and `noindex`.
  - Visitor ids are salted hashes, never raw IPs.
  - User text is rendered with `textContent` only.
- **Limits**: free D1 allows 50 queries per request. The batch sign-up stays well under that (max 15 rows +
  8 new items).

---

## Setup-bot guide (for dr eggbot: designing the shareable setup bot)

The setup bot only has to **fill in `site.config.json`, then run the commands above**. Suggested
conversation, in plain words, one question at a time:

1. "What's the event?" → `event.event_name` (≤60). Offer examples: Halloween Party, Winter Party,
   Field Day.
2. "Teacher's name and class?" → `event.teacher`, `event.class_name` (each ≤60, optional).
   "School?" → `event.school` (optional).
3. "Date and time?" → `event.party_date`, `event.party_time` (free text ≤60; "TBD" is fine). Prefer
   `Friday, October 30, 2026` so "Add to calendar" works. Warn if the date can't be read.
4. "A short message for parents at the top?" → `event.intro` (≤300, optional).
5. "What should people bring, and how many people for each?" → `items` (1–40, name ≤60, spots 1–99, no
   duplicates). Offer the default list from this repo as a starting point. Or: "Do you have a 'Copy this
   event' file from last time?" → `configure.mjs --from`.
6. "Do you want a class code?" (Explain: parents type a short code from your email before they can see
   the list or names.) → `class_code.use_code`. If yes, have them pick a code but **never write it into
   the config or chat logs**. It goes only into `wrangler pages secret put CLASS_CODE`. Remind them to put
   it in the email with the link.
7. "Your name and an email or phone for questions?" → `organizer.name`, `organizer.contact` (optional,
   shown on the page).
8. "Where should 'Add your own' go: below the list (recommended) or above?" → `add_your_own`.
9. "Moving banner, still picture, or none?" → `event.banner`. Theme → `site.theme` (default
   `vintage-poster`).
10. Pick a web address → `site.project_name` (validate: lowercase, numbers, dashes; it becomes
    `<name>.pages.dev`). Set `site.database_name` to the same.
11. Run `node scripts/configure.mjs --check`. Show any errors in plain words, as the script prints them.
12. Then:
    1. `npm ci`
    2. `node scripts/configure.mjs`
    3. `npx wrangler login`
    4. `npx wrangler d1 create <name>`
    5. Write the id into the config, run `configure.mjs` again, and commit.
    6. Create the Pages project and set the secret (if there's a code).
    7. Run `./deploy.sh`.
    8. Send the link (and the code) to parents.

Everything the organizer might want to change later (details, items, order, spots, banner, "Add your own")
can be changed on the page in Organizer mode. The setup bot doesn't need to be re-run for edits.
