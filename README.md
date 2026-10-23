# Class sign-up page (template)

A phone-first "who's bringing what" sign-up page for a class party or any small event. Parents tap the
items they can bring, type their name once, and they're done. The organizer manages everything from the
page itself (Organizer mode, behind an organizer password). No accounts, no app.

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
- **Add your own** sits between the open items and the ones already claimed: at the bottom while nothing is
  claimed, moving up as items fill, and at the top once everything is claimed.
- One "Sign me up" step: **"Your name (shown on the list)"** plus an optional note. The name is remembered
  on that phone.
- "Already signed up" summary, "Add to calendar" (.ics), tap any name to edit or remove it, and
  "Recently removed" with Put back.
- **Class code (optional).** When it's on, the page asks for the code from the organizer's email before
  it shows anything (names are private). It asks once per phone; a signed cookie remembers it for 120 days.
  The cookie is an HMAC signed with the `PASS_SECRET` secret, so it can't be made up without that secret.
  Wrong codes and bad cookies share one limit: 10 tries per 10 minutes per visitor.

## What the organizer can do (Organizer mode)

Tap **Organizer** at the bottom of the page and type the **organizer password** (the `ORGANIZER_PASSWORD`
secret, step 6). Parents never need it: they sign up with the class code only. After the right password the
phone gets a separate organizer cookie for **12 hours** (or until "Turn off Organizer mode").

| Button | What it does |
|---|---|
| **Event details** (or the pencil next to the date) | Edit the event name, teacher, class, school, date, time, the message at the top, organizer name and contact, and the banner (moving / still / none). |
| **Add an item** | New item at the end of the list, with how many people. |
| Under each item: **Spots**, **Rename / remove**, **↑ ↓** | Change how many people, rename, remove (it goes to "Recently removed" with its sign-ups and can be put back), or move it up or down. In Organizer mode the list shows its true order. |
| **Back up the list** | Downloads a spreadsheet file (CSV: Item, Spots, Person, Note, Signed up, including open spots). |
| **Full backup file** | Downloads everything as JSON, including removed sign-ups (no visitor hashes, no IPs). |
| "Class code: on/off" | Shows whether the page is protected by a class code. |
| **Recently removed → Put back** (items) | Put back a removed item with its sign-ups (parents can put back sign-ups, not items). |

**Only the organizer** (with the password) can change the list: add, rename, remove or reorder items, change
spots, edit event details, put back removed items, and download either backup. The server checks this on every
one of those requests, not just the page: without a valid organizer cookie they answer `401`. Parents keep
everything they had: sign up, "Add your own", and edit or remove sign-ups ("tap any name").
- Wrong passwords and forged or expired organizer cookies share one limit: 10 tries per 10 minutes per visitor.
- Changing `ORGANIZER_PASSWORD` or `PASS_SECRET` (then redeploying) signs every organizer out.
- No `ORGANIZER_PASSWORD` (or one under 10 characters) or no `PASS_SECRET`: the page still works for parents,
  but every organizer action answers `503` "isn't set up yet". There is no default password.

---

## Files

| Path | What |
|---|---|
| `site.config.json` | **The only file you edit for a new page.** Project name, D1 database, time zone, theme, event details, organizer, class code on/off (never the code itself), starting items. |
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
   - `items`: `[{ "name": "...", "spots": 1-99 }]`, at most 40, with no duplicate names.
3. **Generate**: `node scripts/configure.mjs` (or `--check` to only validate).
4. **Try it locally** (see "Local testing" below).
5. **Create the database**: `npx wrangler login` (or, for a bot / CI, set `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID`; the token needs **Cloudflare Pages: Edit** and **D1: Edit**), then `npx wrangler d1 create <database_name>`. Put the
   printed `database_id` into `site.config.json`, run `node scripts/configure.mjs` again, and commit.
6. **Secrets: set them FIRST, then deploy.** Secrets live only on Cloudflare, never in the repo or config.
   - Create the Pages project once: `npx wrangler pages project create <project_name> --production-branch main`.
   - **Class code (if `use_code` is true)**: pick a short code (for example `BOO-123`; case, spaces and
     dashes don't matter), then `npx wrangler pages secret put CLASS_CODE --project-name <project_name>`.
   - **PASS_SECRET (required for every page)**: 32 random bytes that sign the class-code pass cookie and
     the organizer cookie (and salt the visitor hashes). Generate and set it in one go, without it ever being
     printed:
     `openssl rand -base64 32 | npx wrangler pages secret put PASS_SECRET --project-name <project_name>`
     (no openssl? `node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))" | npx wrangler pages secret put PASS_SECRET --project-name <project_name>`).
     There is **no default**: with a class code but no `PASS_SECRET` (or one shorter than 32 random bytes,
     43+ characters), the page refuses to open and says it isn't set up yet, and Organizer mode is off on
     every page without it. That's on purpose.
   - **ORGANIZER_PASSWORD (required for every page)**: the organizer picks it (10+ characters; a few words
     is good) and types it at the prompt, so it never lands in a file or the shell history:
     `npx wrangler pages secret put ORGANIZER_PASSWORD --project-name <project_name>`.
     Don't share it with parents. To change it, run the same command again, then redeploy.
   - Optional: `VISITOR_SALT` (any random text) salts visitor hashes instead of `PASS_SECRET`. Set it once
     and don't change it (`scripts/revert-visitor.mjs --ip` needs the same value).
   - Secrets take effect on the **next deploy**: set (or change) them, then run `./deploy.sh` again.
   - Send the code **in the same email as the link** (never the organizer password). Changing the code or
     `PASS_SECRET` later logs everyone out; they type the code once more.
   - To turn the code off, delete the secret: `npx wrangler pages secret delete CLASS_CODE --project-name <project_name>`, then redeploy.
7. **Deploy**: `./deploy.sh` (add `--worker` for the daily snapshot Worker). It first checks the secrets
   with `wrangler pages secret list` (names only, never values): it **refuses** unless `PASS_SECRET` and
   `ORGANIZER_PASSWORD` are set on the project, plus `CLASS_CODE` when `use_code` is true. If it can't check (no login, project not
   created yet, no network), it asks you to type `secrets are set`; without a terminal, re-run with
   `CONFIRM_SECRETS=yes ./deploy.sh` only once you know they're set. It then backs up the database (into
   `backups/`, gitignored) and deploys.

---

## Local testing (QA)

Everything runs on your machine: a local D1 copy under `.wrangler/state` (or `$PERSIST`). It never
touches Cloudflare.

```bash
cd signup-template
npm ci
node scripts/configure.mjs                    # writes seed.sql etc. from site.config.json

# Made-up test values: a class code, an organizer password, and a throwaway random PASS_SECRET
# (a new one each time; never written to a file). Use the SAME three exports in every terminal below.
export CLASS_CODE=BOO-123 ORGANIZER_PASSWORD='Made-up-organizer-pw-1'
export PASS_SECRET="$(openssl rand -base64 32)"

# Terminal 1: server on a fresh local database
rm -rf /tmp/signup-qa
PERSIST=/tmp/signup-qa scripts/dev.sh
#   -> open http://127.0.0.1:8788  (wrong code is refused; BOO-123 / boo 123 gets in;
#      "Organizer" at the bottom asks for the organizer password)

# Terminal 2 (same three exports; copy PASS_SECRET over with `export PASS_SECRET=...`). test.mjs also starts
# its own short-lived servers on ports 8795/8796/8798 (missing or short PASS_SECRET, no ORGANIZER_PASSWORD):
PERSIST=/tmp/signup-qa node scripts/test.mjs          # API, class code + organizer password tests (~5 min: waits out rate windows)
PERSIST=/tmp/signup-qa node scripts/test-admin.mjs    # revert / snapshot / backup-worker tools
node scripts/test-deploy.mjs                          # deploy.sh secrets check, offline (fake wrangler)

# Phone-width browser check (390 px) on its OWN fresh database: stop the server, then
rm -rf /tmp/signup-qa-ui && PERSIST=/tmp/signup-qa-ui scripts/dev.sh      # terminal 1
npm i --no-save puppeteer-core               # or PPTR_DIR=/path/with/node_modules (Chrome: CHROME=/path)
node scripts/ui-check.mjs                    # terminal 2; screenshots: /tmp/ui-check-*.png
```

- Run the API tests on a **fresh** database (a new `PERSIST` folder). They add test items, and the list
  holds at most 40.
- The class code allows 10 tries per 10 minutes per visitor, and locally every browser run is the same visitor (127.0.0.1). Re-running `ui-check.mjs` more than about 4 times on one database hits that limit ("Too many tries"). Use a new `PERSIST` folder, or wait 10 minutes.
- `ui-check.mjs` writes sign-ups and fills every item (to check where "Add your own" sits with 0, some
  and all items claimed), so give it its own fresh `PERSIST`.
- No class code: start `scripts/dev.sh` without `CLASS_CODE` and run the tests without it too. The gate
  tests are then skipped, and the tests check that `state.code` is false.
- `.dev.vars` (gitignored) also works for local secrets: `CLASS_CODE=BOO-123`, `PASS_SECRET=<random>`,
  `ORGANIZER_PASSWORD=<made-up>`.
- `CLASS_CODE` without `PASS_SECRET`: every `/api` call answers 503 "isn't finished being set up" (fail closed).
  No `ORGANIZER_PASSWORD`: organizer actions answer 503; parents can still sign up.
- `node scripts/test-deploy.mjs` checks deploy.sh's secrets check with a fake `wrangler` (no network).
- `TEST_HOOKS=1` is set only by `dev.sh`. It enables the rollback test headers and must never be set on
  the live site.

---

## How it's built (for maintainers)

- **API** (`/api/...`, all JSON):
  - `GET state` returns `{settings, items[{id,name,needed,sort,is_custom,entries}], removed, removed_items, calendar, code, limits}`.
  - `POST unlock {code}`; `POST organizer/login {password}`, `POST organizer/logout`.
  - `POST entries`, `PUT/DELETE entries/:id`, `POST entries/:id/restore`.
  - `POST batch {name, note, rows, others}` is the all-or-nothing sign-up.
  - `POST items`, `PUT items/:id {name?, needed?}` or `{move:-1|1}`, `DELETE items/:id`, `POST items/:id/restore`.
  - `PUT settings {key,value}` or `{values:{...}}`.
  - `GET export.csv`, `GET export.json`, `GET calendar.ics?name=&item=`.
- **Class code**:
  - On when `CLASS_CODE` is non-empty. Then `PASS_SECRET` (≥32 random bytes: ≥43 characters, not a
    repeated filler) is required: without it every `/api` route answers `503 {setup:true}` and logs a setup
    error. There is no default secret (fail closed).
  - `POST /api/unlock` allows 10 tries per 10 minutes per visitor. On success it sets an `HttpOnly;
    SameSite=Lax` cookie `signup_pass` = `v2.` + base64url HMAC-SHA256(`PASS_SECRET`, normalized code),
    never the code. It is compared in constant time and is `Secure` on https.
  - Without a valid pass, every other `/api` route answers `401 {gate:true}`. `GET /api/state` adds
    only `event_name`. A request with a **bad** pass cookie (forged, old format, or from before the code or
    secret changed) uses one of the same 10 tries, gets the cookie cleared, and after 10 gets `429`.
- **Organizer password**:
  - Organizer-only routes: `POST items`, `PUT/DELETE items/:id`, `POST items/:id/restore`, `PUT settings`,
    `GET export.csv`, `GET export.json`. Without a valid organizer cookie: `401 {organizer:true}`. The class
    code gate still comes first. Everything else (state, sign-ups, entries, calendar) is for parents.
  - `POST /api/organizer/login` compares HMACs of the typed and real password in constant time, and allows
    10 tries per 10 minutes per visitor (its own count, separate from the class code). On success it sets
    `signup_org` = `o1.<expiry>.` + base64url HMAC-SHA256(`PASS_SECRET`, expiry + a MAC of the password):
    `HttpOnly; SameSite=Strict`, `Secure` on https, `Max-Age` 12 hours, and the expiry is checked on the
    server too. A forged, expired or outdated organizer cookie is cleared and uses one of those 10 tries.
  - `GET /api/state` says `organizer: true|false`; the page shows Organizer mode only when it's true.
  - Missing `ORGANIZER_PASSWORD` (or under 10 characters) or a missing/short `PASS_SECRET`: organizer routes
    answer `503 {setup:true}` (fail closed, no default).
- **Items**: `needed` (spots) is 1-99; 0 is refused (remove an item instead).
- **Names**: a sign-up needs a name, on sign-up and on edit (`400 Please type your name.` otherwise).
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

## Setup guide for a bot

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
   duplicates). Offer the default list from this repo as a starting point.
6. "Do you want a class code?" (Explain: parents type a short code from your email before they can see
   the list or names.) → `class_code.use_code`. If yes, have them pick a code but **never write it into
   the config or chat logs**. It goes only into `wrangler pages secret put CLASS_CODE`. Remind them to put
   it in the email with the link. Every page **must** also get `PASS_SECRET` (step 12.6): pipe
   `openssl rand -base64 32` straight into `wrangler pages secret put PASS_SECRET`; never show, log or
   reuse it, and never invent a fixed value.
7. "Your name and an email or phone for questions?" → `organizer.name`, `organizer.contact` (optional,
   shown on the page).
8. "Pick an organizer password (10+ characters). Only you use it, to change the list or download backups;
   parents never need it." Don't ask them to type it in the chat: at step 12.6 they type it themselves at
   the `wrangler pages secret put ORGANIZER_PASSWORD` prompt. Never write it into the config, a file or a log.
   ("Add your own" needs no question: it always sits between the open and the claimed items.)
9. "Moving banner, still picture, or none?" → `event.banner`. Theme → `site.theme` (default
   `vintage-poster`).
10. Pick a web address → `site.project_name` (validate: lowercase, numbers, dashes; it becomes
    `<name>.pages.dev`). Set `site.database_name` to the same.
11. Run `node scripts/configure.mjs --check`. Show any errors in plain words, as the script prints them.
12. Then:
    1. `npm ci`
    2. `node scripts/configure.mjs`
    3. `npx wrangler login` (or `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` in the environment; token
       permissions: Cloudflare Pages Edit + D1 Edit)
    4. `npx wrangler d1 create <name>`
    5. Write the id into the config, run `configure.mjs` again, and commit.
    6. Create the Pages project and set the secrets **before** deploying: `PASS_SECRET`
       (`openssl rand -base64 32 | npx wrangler pages secret put PASS_SECRET --project-name <name>`),
       `ORGANIZER_PASSWORD` (the organizer types it at `npx wrangler pages secret put ORGANIZER_PASSWORD --project-name <name>`),
       and `CLASS_CODE` if there's a code.
    7. Run `./deploy.sh`. It refuses if a needed secret is missing. If secrets are added or changed
       later, run `./deploy.sh` again so they take effect.
    8. Send the link (and the code) to parents. Tell the organizer: tap "Organizer" at the bottom and
       enter the password to edit.

Everything the organizer might want to change later (details, items, order, spots, banner) can be changed
on the page in Organizer mode (with the organizer password). The setup bot doesn't need to be re-run for edits.
