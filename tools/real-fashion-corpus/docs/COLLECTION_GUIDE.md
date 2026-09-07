# Collection guide

For the person actually photographing garments. You do not need to be an
engineer and you never edit source code to add a garment.

This guide has been **tested end to end** — `node tools/real-fashion-corpus/cli.js dry-run`
walks every stage below against generated files and fails if any instruction
here has stopped working (mission section 43).

---

## The one rule that matters most

**Never put a K Scan result, a Gemini result, a ChatGPT answer, or any other AI
output into the ground-truth columns.**

K Scan is the thing being measured. If K Scan's own guess becomes the answer
key, the measurement is meaningless — it would be marking its own homework.

If you don't know the brand, style code or colourway, **leave it blank**.
"Unknown" is a completely valid, useful answer here, and the corpus has a
first-class way to record it (`VISUAL_ONLY`). Guessing is the only thing that
breaks it.

---

## What you need

- A phone (iOS or Android — ideally both, see step 6)
- Garments you own, or have permission to photograph
- A laptop with this repository checked out
- Somewhere to put the photo files (the **asset root** — step 4)

---

## Step 1 — Get the templates

```bash
node tools/real-fashion-corpus/cli.js template
```

That writes two spreadsheets:

- `intake/collection-template-garments.csv` — one row per **physical product**
- `intake/collection-template-cases.csv` — one row per **photograph**

Open them in Excel, Numbers or Google Sheets. Each has a column guide in the
`#` comment lines at the top; those lines are ignored when you submit the file,
so leave them there.

**Why two files?** A garment photographed three times is one product and three
photographs. Typing the brand and style code three times is three chances to
disagree with yourself, silently. So the product is described once.

---

## Step 2 — Photograph the garment

**Preferred, in order: hanger, flat-lay, mannequin, garment-only.**

Avoid photographs with a person in them. If you genuinely need one:

- you must consent explicitly, and record that in the `consent_status` column
- no other people may be in frame
- keep faces out of shot where the garment does not need them

The corpus never records biometric information and never infers anyone's age,
gender or ethnicity. The schema refuses those fields outright.

**Take the tag photograph too.** You don't submit it as a case — you read the
style code and colourway off it for step 3. That tag is what makes a garment
identity-eligible, which is what makes the identity metric possible at all.

### Getting hard cases, not just easy ones

A corpus of logo-covered white t-shirts on a clean background measures nothing
useful. Deliberately collect:

- garments with **no visible logo** as well as ones with a logo
- **dark** garments (black, navy, charcoal) — these are genuinely hard
- **patterned** as well as solid
- two **colourways of the same style**, if you own them
- two **adjacent styles from the same brand** that look alike
- **low light** and **retail floor** conditions, not just good window light

Record what you did in `difficulty_strata`. The allowed values are listed in the
template's column guide.

---

## Step 3 — Fill in the garment sheet

One row per physical product.

| If you have… | Do this |
|---|---|
| The tag, with a style/model code | Fill `style_code`. Set `asserted_grade` to `IDENTIFIER_GRADE`. |
| A barcode | Fill `gtin` (the digits under the barcode). Also `IDENTIFIER_GRADE`. |
| The brand but no code | Leave `style_code`/`gtin` blank. Set `asserted_grade` to `PARTIAL`. |
| Neither | Leave them blank. Set `asserted_grade` to `VISUAL_ONLY`. |

**For `IDENTIFIER_GRADE` you also need the colourway** (`colorway_name` or
`colorway_code`). "The right jacket in the wrong colour" is a different product
to a shopper, so identity is not established without it.

### `evidence_observed_facts` — the important column

Write down what you actually read, as `key=value; key=value`:

```
brandOnTag=Arc'teryx; styleCodeOnTag=X000006268; colorwayOnTag=Black Sapphire; materialOnTag=GORE-TEX
```

This exists because **retailer URLs die.** In two years the product page will be
gone, and if the URL was the only evidence, the record becomes unverifiable.
What you transcribed here survives. The `evidence_url` column is a *supplement*,
never the evidence itself — and the corpus checks this by literally deleting
every URL and re-deriving the grade.

`asserted_grade` is your **expectation**, not a decision. Validation works out
the real grade from the evidence you recorded and tells you if the two disagree.
If it says you claimed `IDENTIFIER_GRADE` but only `PARTIAL` is supported,
something you thought you recorded is missing.

---

## Step 4 — Put the photo files somewhere

Photo files are **not** committed to the repository. They live in an *asset
root* on your machine, and only their hashes go into git. (The repository is
public, and a garment photograph can show your home.)

Either:

```bash
export KSCAN_RFC_ASSET_ROOT=/path/to/your/corpus-photos
```

or drop them in `tools/real-fashion-corpus/corpus/assets-mount/`, which is
already git-ignored.

Organise by garment, and use the same paths in the `asset_path` column:

```
corpus-photos/
  G001/
    C0001-ios.jpg
    C0002-android.jpg
  G002/
    C0003-ios.jpg
```

---

## Step 5 — Strip location data from the photos

Phones write GPS coordinates into photos. That is your home address.

Check a file:

```bash
node tools/real-fashion-corpus/cli.js inspect-asset corpus-photos/G001/C0001-ios.jpg
```

If it says `locationPresent true`, clean it:

```bash
node tools/real-fashion-corpus/cli.js sanitize-asset corpus-photos/G001/C0001-ios.jpg
```

This removes GPS, XMP location and IPTC city/country data, **and keeps the
orientation flag** so a portrait photo does not come back sideways.

Ingestion will refuse any photo that still carries location data. It will not
clean it for you silently — quietly rewriting your photograph behind your back
is not something the corpus should do.

---

## Step 6 — Fill in the case sheet

One row per photograph. Several rows share one `garment_id` — that is the point.

**You do not type a file hash.** Ingestion reads the actual file and records its
hash, size and real dimensions itself.

### Device pairs

If you photograph the same garment on both an iPhone and an Android phone, set
`paired_case_id` on each row to the other's `case_id`. Keep them as similar as
you can — same hanger, same spot, same light, same distance.

Two rules the corpus enforces:

- both members must be the **same garment**
- the two files must be **genuinely different photographs**. Copying one file
  and filing it as the other platform's capture is caught and rejected — that
  would fabricate exactly the parity the comparison exists to measure.

If you only have one platform, leave `paired_case_id` blank. The corpus reports
`PAIRED PLATFORM COLLECTION: PENDING_DEVICE`, which is honest. Faking it is not.

---

## Step 7 — Validate before you ingest

```bash
node tools/real-fashion-corpus/cli.js validate \
  --garments intake/inbox/my-garments.csv \
  --cases    intake/inbox/my-cases.csv
```

This writes nothing. It reports **every** problem across both sheets at once —
so you fix them in one pass rather than discovering them one at a time — and
each error names the spreadsheet row, the column, what you typed, and what was
expected:

```
cases:
  row 7, column "difficulty_strata" (got "DARK;SPARKLY"): unknown value(s): SPARKLY. Allowed: VISIBLE_LOGO, ...
```

Fix and re-run until it says `VALIDATE: PASS`.

---

## Step 8 — Ingest

```bash
node tools/real-fashion-corpus/cli.js ingest \
  --garments intake/inbox/my-garments.csv \
  --cases    intake/inbox/my-cases.csv
```

Nothing is written unless the whole batch is good — a half-ingested batch is a
corpus that disagrees with the spreadsheet it came from.

Ingestion assigns each garment to the **development** or **holdout** partition
automatically. You do not choose, and you should not try to: the assignment is a
hash of the garment id, so it is stable and unbiased. Some of your garments will
go into the sealed holdout and you will not see their results in day-to-day
evaluation. That is deliberate.

---

## Step 9 — QC

```bash
node tools/real-fashion-corpus/cli.js qc
```

QC checks corpus **integrity** — not whether K Scan matched anything. It will
reject a case for: an unreadable or corrupt file, a hash that no longer matches
the file, retained location data, the same photo filed twice, a broken pair, a
missing evidence chain, or a privacy problem. Every rejection names its reason.

---

## Step 10 — See where you are

```bash
node tools/real-fashion-corpus/cli.js queue
```

Shows the live queue, the grade distribution, the collector spread, and the
**gap list** — what to collect next, in plain language, ordered by what it
unblocks:

```
P1  Need 7 more case(s) toward "Does a visible logo materially change
    identification quality?" (now n=8, DESCRIPTIVE_ONLY; 7 more reaches DIRECTIONAL).
P2  Need 4 more dark garment case(s) (now 1). Without them the corpus is an
    easy-product benchmark.
```

Work the P1 items first.

---

## Quick reference

```bash
cli.js template                        # write the blank templates
cli.js inspect-asset FILE              # is this file clean and readable?
cli.js sanitize-asset FILE             # strip location data, keep orientation
cli.js validate --garments F --cases F # check a filled sheet, write nothing
cli.js ingest   --garments F --cases F # ingest a validated batch
cli.js qc                              # corpus integrity check
cli.js queue                           # state + gap list
cli.js gaps                            # just the gap list
cli.js dry-run                         # prove this whole guide still works
```

## Things that will be rejected, and why

| You did | What happens |
|---|---|
| Pasted a K Scan or AI answer as evidence | Rejected. The model may never create its own truth. |
| Claimed `IDENTIFIER_GRADE` without a style code or GTIN | Rejected, naming what is missing. |
| Submitted a photo with GPS still in it | Rejected, with the command to clean it. |
| Filed the same photo under two case ids | Rejected as an accidental duplicate. |
| Copied one photo and called it the Android capture | Rejected — that fabricates device parity. |
| Photographed someone without recording consent | Rejected. |
| Only recorded a retailer URL, no observed facts | Rejected — the record would die with the page. |
