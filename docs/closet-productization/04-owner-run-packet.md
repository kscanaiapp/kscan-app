# Owner Product-Feel Run Packet (section 70)

**Purpose.** Decide one thing: does this feel like a wardrobe? Source completion
does not imply product-feel approval, and nothing in this lane claims it does.

**Time.** About 10 minutes.

**Device status.** No physical-device evidence exists for this lane.
`DEVICE QA: PENDING-RUNTIME`. A simulator or emulator is fine for this review;
do not record simulator observations as device-proven.

---

## Setup — the seeded 48-item Closet

```bash
node tools/closet-eval/seedClosetFixture.mjs
```

Writes `tools/closet-eval/closet-fixture.json`: 48 deterministic, fully synthetic
items. No network call, no Supabase project, no bundled retailer imagery. Brand
names are the fictitious-company placeholders (Northwind, Contoso, Fabrikam,
Adventure Works, Litware).

Copy it into the running app's sandbox as:

```
<documentDirectory>/kscan_closet/kscan_closet.json
```

The fixture is generated for the **signed-out device-local** partition. For a
signed-in actor, regenerate with `--owner <your-user-uuid>`; a Closet whose
`ownerId` does not match the signed-in actor reads as empty **by design** —
that is actor isolation working, not a bug.

What the fixture deliberately contains:

| Shape | Count | Why |
| --- | --- | --- |
| Categorized items | 43 | the ordinary case |
| Uncategorized items | 5 | must stay visible, never hidden |
| Placeholder-titled items | 10 | gives the review queue real work |
| Items with no brand | 12 | proves a below-floor field is not featured |
| Items with no image | 7 | exercises the grid placeholder path |
| Legacy v1-schema records | 4 | must read, edit and delete identically |
| Exact re-add pairs | 2 | must NOT produce a duplicate warning |

---

## The eight steps

### 1. Open Closet — does it feel like a wardrobe?
Library → **MY CLOSET**.

Expect: a count line (*"48 items in K Scan AI · 6 categories"*), a search field,
category chips with counts, an origin filter, a sort control, an at-a-glance
panel, and a 2-up grid. Items with no photo show a placeholder rather than a gap.

**Judge:** does the top of this screen tell you what you own, or does it just
list things?

### 2. Find a known item through search
Type `northwind`. Expect 5 results and a *"Showing 5 of 48"* line with **Clear**.

Now type `nortwind` (typo). Expect **no results** — search is exact-substring by
design, so a result set can always be explained. Judge whether that is the right
trade for a wardrobe of this size.

### 3. Use one supported filter
Tap the **Uncategorized 5** chip. Expect exactly the 5 unclassified items.

**This is the one to be sceptical about:** unclassified items are the easiest
thing for a wardrobe app to quietly hide. They must be a real, selectable bucket.

Then tap **Added from a scan** and confirm the split is believable.

### 4. Open one item
Tap any card. Expect the existing detail path, unchanged by this lane.

### 5. Correct one reviewable item
The review row reads *"Some items could use a quick review."* with a
**Review 14** button — one coalesced line, not fourteen nags. Tap it.

Pick an item titled "Closet item", tap **Edit**, and correct it: give it a name,
a brand, a main colour, a size. Save.

Expect: the item leaves the review set immediately, and the count drops. Nothing
remembers that it was ever flagged.

**Judge:** could you correct what the app got wrong, in the words you would use?

### 6. Understand sync/cloud status without a developer explaining it
Look at the status row under the header.

- With K+ active: *"Up to date — Your Closet is available on your devices."*
- Mid-sync: *"Syncing — Saving N items to your other devices."*
- Without K+, or while entitlement is still resolving: **nothing at all.**

**Judge:** if you did not know how this was built, would the words mean anything?
And is the absence of a row confusing, or restful?

### 7. View Closet Intelligence
The **Your Closet at a glance** panel.

Free, above the divider: *"You have 48 items in K Scan AI"*, top category counts,
the review count.

K+, below it: *"89% of items in your K Scan AI Closet have a category"* and
similar coverage lines.

Two deliberate absences to check:
- **No duplicate warning**, even though the fixture contains two exact re-add
  pairs. A Closet record carries no product identity, so the product says nothing
  rather than guessing.
- **No "your wardrobe is X% complete"**, anywhere. Every figure names K Scan AI
  Closet records, because that is all the app knows.

**Judge:** is this interesting, or is it a report card? Would you read it twice?

### 8. Return to ordinary Closet
Tap **Clear** / **Show all**. The full 48 items return.

Then put the device in airplane mode and repeat steps 1–4. Everything must still
work: the Closet is local-first, and cloud problems may not block viewing,
searching or filtering.

---

## Verdict

```
PILOT-WORTHY        /        NOT PILOT-WORTHY
```

Please note specifically:

1. Anything that reads as an engineering state rather than a wardrobe state.
2. Any number you could not explain to a customer.
3. Any place the app implies it knows more about your wardrobe than it does.
4. Whether the review queue feels helpful or feels like homework.

---

## Known gaps to expect (not defects)

- **Brand coverage is 60%** in this fixture — below the 70% floor — so brand is
  searchable but is **not** a primary filter. That is the coverage gate working.
  It reflects a real upstream gap: Recent Scan promotion carries only the
  category across (see `05-future-requirements.md`, FR-3).
- **No duplicate candidates ever.** FR-2.
- **Physical-device performance is unmeasured.** The 1000-item behaviour is
  proven correct and bounded in tests, not on hardware.
