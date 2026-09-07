# Live VTO — Physical QA Run Packet

**Status:** PENDING-RUNTIME. Nothing in this document has been executed.
**Written by:** the cross-platform staging pilot lane, 2026-09-07, with no
physical Android or iOS device available at any point.
**Purpose:** make the later physical-device session a *validation* exercise
rather than another coding session.

---

## 0. Read this first

You are certifying a feature whose **source and build** are proven and whose
**runtime is not**. Everything below is written so that a tester who has never
seen this codebase can run it, and so that whoever reads the results
afterwards can tell the difference between "the feature is wrong" and "the
test was run wrong".

Three rules that override anything else in this packet:

1. **Do not use another person's photo, and do not use customer imagery.**
   Journey D sends an image of you across an external provider boundary. Only
   owner-authorized test subjects may appear in it. If you are not authorized
   to be that subject, stop at Journey C and record Journey D as NOT RUN.
2. **If a step's expected outcome does not happen, record what DID happen and
   keep going.** A single failure does not invalidate the rest of the run, and
   a run that stops at the first problem tells us much less than one that
   finishes.
3. **"It looked fine" is not a result.** Every step below names the evidence to
   collect. A step with no evidence is recorded as NOT RUN, not as PASS.

---

## 1. What you need before you start

| Item | Why | Where it comes from |
| --- | --- | --- |
| A physical Android phone (**not** the Samsung that produced the carried camera hold, if one is available — see §7) | The camera runtime is the thing under test | — |
| A physical iPhone (iOS 15.1 or later) | Same, on the other platform | — |
| A **staging-certification** build for that platform **with the Live flag turned on** | It points at the staging backend, and it is the profile the Live flag belongs on. **As of 2026-09-07 the flag is not set on any profile** — that is an open OWNER ACTION (see `docs/vto-live-productization-v1.md` §8), and until it is done there is nothing to test | Owner enables the flag, then a fresh build |
| A K Scan account with **K+** on staging | Journey D (Photoreal) is gated on it | Staging test actor |
| A room with **controllable lighting** and about 2.5 m of clear floor | Journeys C and F need you to move, and one step needs the light turned down | — |
| A second person to hold the phone, OR a tripod | You cannot stand 2 m from a phone you are holding | — |
| Screen recording enabled | Most of what is being judged is temporal | OS screen recorder |

### Confirm the build is the right one BEFORE testing

Do not skip this. A run against the wrong binary is worse than no run, because
it produces evidence that looks valid.

```bash
# From the repo, for the commit the build was made from:
git log -1 --format='%H'
```

Then, in the app, confirm all three:

- the backend is **staging** (`yzqjvdfgefveprobvvyw`), not production;
- **Try It On** appears on an eligible product;
- opening Try It On offers a **Live** option, not only AI Photo (this is the one that fails if the owner action above has not been done).

If Live is not offered, **stop**. Record the reason from §8's table and do not
continue — every journey below assumes Live is reachable, and a run that
"passed" because the feature never appeared is a false green.

---

## 2. How to record a result

For every numbered step, record exactly one of:

- **PASS** — the expected outcome happened, and you collected the named evidence.
- **FAIL** — something else happened. Write what, in one sentence, in plain
  language. No diagnosis needed; that is our job.
- **BLOCKED** — you could not run it (no K+, no second person, app crashed
  earlier in the journey). Say which.
- **NOT RUN** — you skipped it.

Use the evidence drop format in §6 for every file you collect.

---

## 3. The journeys

### Journey A — Launch

| # | Step | Expected | Evidence |
| --- | --- | --- | --- |
| A1 | Open an eligible product and tap **Try It On** | The sheet opens offering a mode choice including Live | Screenshot |
| A2 | Choose **Live** | A "Live uses your camera to show the piece on you" panel appears with a **Start Live** button. **The camera has NOT started yet** and no permission prompt has appeared | Screenshot |
| A3 | Tap **Start Live** | The OS camera permission prompt appears **now**, not earlier | Screenshot |
| A4 | **Allow** camera access | The viewfinder appears. The status line reads "Starting Live…" then "Getting ready…" | Video, from the tap to the first frame |
| A5 | Stand about 2 m away, facing the camera, whole torso visible | Within a few seconds the status line reads **"Ready"** and the garment is drawn on you | Video, ≥10 s |
| A6 | While it says "Ready", check the two capture buttons | **Create AI photo** and **Capture preview** are both ENABLED | Screenshot |
| A7 | Tap **Close Live** | You return to the sheet. The camera indicator (green/orange dot) goes out | Video |

**A7 is a privacy check, not a navigation check.** If the OS camera indicator
stays lit after closing, that is a FAIL and it is serious — say so immediately
rather than continuing.

### Journey B — Garment switching

Run this from a scan result that produced **more than one** eligible item. If
you cannot find one, record B as BLOCKED and say so — do not substitute a
different flow.

| # | Step | Expected | Evidence |
| --- | --- | --- | --- |
| B1 | With Live running on item **A**, switch to item **B** | The status line changes to "Loading this piece…", then the NEW garment appears. **The camera does not restart** and you do not have to re-grant permission | Video across the switch |
| B2 | Switch back to **A** | Same, and the garment that appears is A's, not B's | Video |
| B3 | Switch A → B → A as fast as the UI allows | The garment that ends up on screen is the last one you chose. No flash of the wrong garment | Video |
| B4 | During any switch, watch the capture buttons | They go DISABLED while loading and come back when the new garment is rendered | Video |
| B5 | After each switch, confirm the product name on the sheet matches the garment drawn | They agree | Screenshot |

**B5 is the one that matters most.** A garment drawn that is not the product
named is the defect this whole lifecycle exists to prevent.

### Journey C — Movement and tracking

Record **one continuous video** for the whole journey. Say each step number out
loud before you do it, so the video is self-labelling.

| # | Step | Expected |
| --- | --- | --- |
| C1 | Stand neutral, ~2 m, facing camera | "Ready", garment tracks your torso |
| C2 | Step closer (~1 m) | Garment follows. Status may change; note what it says |
| C3 | Step back (~3 m) | Garment follows, or guidance appears. Note the exact words |
| C4 | Turn ~30° left, then ~30° right | Note whether the garment follows the turn or slides off |
| C5 | Cross one arm over your torso | **Note whether the arm appears in front of the garment or behind it.** This is the occlusion question |
| C6 | Raise both arms overhead | Note what happens to the garment |
| C7 | Walk out of frame entirely, wait 3 s | Status changes to a "step back into frame" message. **It must not keep saying "Ready"** |
| C8 | While out of frame, look at the capture buttons | Both are DISABLED |
| C9 | Walk back into frame | Status returns to "Ready" within a few seconds and the garment reappears |
| C10 | Turn the room lights down until you are dimly lit | Note the guidance. "Try somewhere brighter" is the expected wording |
| C11 | Turn the lights back up | Recovers to "Ready" |

**C7 and C8 together are the single most important pair in this packet.** They
are the difference between a tracking indicator that reports reality and one
that is decorative.

### Journey D — Photoreal (owner-authorized subject only)

Only run this if you are an authorized test subject. See §0 rule 1.

| # | Step | Expected | Evidence |
| --- | --- | --- | --- |
| D1 | Get to "Ready" with the garment drawn | **Create AI photo** is enabled | Screenshot |
| D2 | Tap **Create AI photo** | The button shows "Creating AI photo…" and is disabled. The Live session behind it stays alive | Video |
| D3 | Tap it again immediately | **Nothing happens.** Exactly one generation runs, and you are not billed twice | Video |
| D4 | Wait for the result | Either a generated image appears, or a bounded failure notice appears. **In either case Live is still running underneath** | Video through to the outcome |
| D5 | If it failed: read the message | It says something like "Try again later or return to Live Try-On". **It must not mention RapidAPI, AILabTools, HTTP 429, a reservation id, or a provider name** | Screenshot |
| D6 | Return to Live | The session is still there; you do not have to restart it | Video |

**If D4 produced a generated image, the person in it must be YOU from the
clean camera frame — not a screenshot of the composited preview with the
garment already drawn on it.** If the result looks like the garment was
already on you before generation, that is a serious FAIL: record it and say so
explicitly.

### Journey E — Lifecycle

| # | Step | Expected |
| --- | --- | --- |
| E1 | With Live running, press Home / swipe to background | The camera indicator goes out |
| E2 | Return to the app | Either Live resumes, or it shows a clear state you can act on. **Not a frozen last frame, and not a permanent spinner** |
| E3 | Close the sheet, reopen Try It On, choose Live again | It starts cleanly. No leftover garment, no leftover preview image, no stale status |
| E4 | Minimize the sheet to the pill while Live is running | The camera indicator goes out |
| E5 | Force-quit the app while Live is running, relaunch, open Live again | Starts cleanly |
| E6 | Sign out and back in, then open Live | No image, preview or state from the previous session is visible |

**E6 is an account-boundary check.** Anything from the previous account
appearing is a serious FAIL.

### Journey F — Failure paths

You must run **at least** F1 and one of F3/F4.

| # | Step | How | Expected |
| --- | --- | --- | --- |
| F1 | Camera permission denied | Deny at the prompt (or revoke in OS settings, then open Live) | A clear message that camera access is off. **No black screen, no spinner, and AI Photo is still offered.** No retry button is shown, because granting permission is not something the app can retry for you |
| F2 | Permission granted after a denial | Grant in OS settings, return, tap Live again | It starts normally |
| F3 | Camera busy | Open another camera app, leave it running, switch back and start Live | A bounded message and a way forward. **Not a black screen and not a spinner** |
| F4 | Provider unavailable | Enable airplane mode, then tap **Create AI photo** | A bounded failure notice. **Live is still running behind it** |
| F5 | Retry after a recoverable failure | If F3 or F4 showed a **Try Live again** button, tap it | It restarts cleanly, or fails the same way with the same clear message. It must not do nothing |

For every failure step, screenshot the **exact message text**. Provider names,
HTTP status codes, native error strings and internal ids appearing in customer
copy are findings in their own right.

---

## 4. The perceptual quality matrix — DO NOT SKIP

This is the part that cannot be automated and the part the product decision
rests on. Fill it in from the Journey C video, after the run, not during it.

Score each **ACCEPTABLE** or **BELOW FLOOR**. There is deliberately no middle
option: "sort of fine" is the answer that lets a bad pilot ship.

| Dimension | What you are judging | Score | One sentence of why |
| --- | --- | --- | --- |
| Camera experience | Does it start quickly and look like a normal camera? | | |
| Tracking feedback | Did the status line tell you the truth about what the app could see? | | |
| Garment attachment | Does the garment sit where a garment would sit? | | |
| Garment switching | Did switching feel instant and land on the right piece? | | |
| Visual stability | Does it jitter, swim, or lag behind you? | | |
| Occlusion | When your arm crossed your torso, did it look right? | | |
| Photoreal flow | Was the capture → result path clear and honest? | | |
| Overall experience | Would you show this to someone whose opinion you care about? | | |

**This matrix is owner-ratified, not tester-ratified.** Your job is to score it
and say why; the decision about whether the pilot proceeds is not made here.

---

## 5. What this run CANNOT conclude

Say these explicitly in your report so nobody infers them:

- It cannot conclude the garment sizing is accurate. VTO is a visualization;
  the app makes no fit, size, drape or colour claim, and neither should the
  report.
- It cannot conclude the feature is ready for people outside the company.
  External pilot distribution is not authorized, because Photoreal sends
  authorized person imagery across an external provider boundary and the
  disclosure/consent posture for that is an owner and counsel decision.
- It cannot conclude anything about production. This build points at staging
  and production Live activation is not authorized.

---

## 6. Evidence drop format

One folder per device. Name it `<platform>-<device>-<YYYYMMDD>`.

Every file gets a sibling `.md` or a line in the folder's `README.md` carrying:

```
COLLECTED_BY:    <name>
PLATFORM:        ios | android
DEVICE:          <model, e.g. Pixel 8 / iPhone 15 Pro>
OS:              <version>
BUILD SHA:       <40-hex commit the build was made from>
BUILD ID:        <EAS build id>
BACKEND:         STAGING (yzqjvdfgefveprobvvyw)
VTO FLAG STATE:  <Live offered? yes/no>
GARMENT ID:      <the product you were trying on>
TEST CASE:       <e.g. C7>
RESULT:          PASS | FAIL | BLOCKED | NOT RUN
```

**Video for anything temporal** — tracking, switching, recovery, lifecycle.
A screenshot of a tracking state proves almost nothing, because the question is
always *when* it changed. **Screenshots are fine for static failures** — an
error message, a disabled button, a permission dialog.

Do not collect: anything containing another person, anything containing a real
customer's data, or raw camera frames beyond what the journeys ask for.

---

## 7. Known holds you should NOT spend time on

These are already recorded. If you hit them, note it and move on — do not
debug.

| Hold | What it looks like | What to do |
| --- | --- | --- |
| **Android camera runtime (carried)** | On one specific Samsung device the camera binds successfully and then never delivers a frame: the viewfinder stays black while the app reports it started. `Camera2-FrameProcessorBase ETIMEDOUT (-110)` in logcat | Record it, note the exact device model, and **run the rest of the journeys on a different Android device if one is available**. This hold is why a second device matters |
| **iOS physical runtime** | Never exercised on hardware at all | Everything you find on iOS is new information. Report generously |
| **Photoreal provider quota** | A failure notice on D4 with no image | Record it as a provider outcome, not a client defect. Do not retry more than once |
| **Occlusion quality** | Arm-over-torso looks wrong | Score it in §4 and describe it. There is no local segmentation stack behind it yet, so a poor result here is expected information, not a regression |

If the tracking status line ever says "Ready" while the viewfinder is black,
that is **not** the Samsung hold — that is a tracking-contract failure and it
is a high-priority finding. The whole point of the tracking work is that those
two cannot disagree.

---

## 8. If Live never appears

Work down this table in order. The first row that matches is the answer.

| Check | If it fails |
| --- | --- |
| Is the Live build flag `EXPO_PUBLIC_LIVE_VTO_ENABLED` set on the profile this build came from? | **As of 2026-09-07 no EAS profile sets it** — that is an open OWNER ACTION, see `docs/vto-live-productization-v1.md` §8. If it has not been done, Live cannot appear and there is nothing to test. Stop here |
| Is this the **staging-certification** build? | Live is enabled on no other profile. Get the right build |
| Does the app point at staging? | A production build will never offer Live. Get the right build |
| Is the operator switch on? | The `vto_generation` app_config row's `live.enabled` must be `true` on staging. This is a backend setting, not a build setting |
| Is the product eligible? | Most real products are not. Live only renders products with a governed prepared asset — this is expected, not a bug |
| Does the device have a front camera, and is it iOS 15.1+ / Android 7+? | Below those, the runtime reports itself not capable, by design |
| Did you deny camera permission earlier? | Grant it in OS settings and reopen |

If all six pass and Live still does not appear, that is a finding. Capture a
screenshot of the Try It On sheet and report it.

---

## 9. Reporting back

One markdown file per device, containing:

1. the header block from §6, filled in once;
2. a table of every step number with PASS / FAIL / BLOCKED / NOT RUN;
3. the §4 perceptual matrix, filled in;
4. a list of anything that surprised you, in plain language, whether or not it
   was on the list;
5. the evidence folder.

Point 4 is worth more than points 1–3. The journeys cover what we already know
to ask about; you are the first person to see this on real hardware.
