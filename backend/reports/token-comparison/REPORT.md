# Token comparison: old vs new pipeline (50 tests)

Run on 7 November 2026 with `node scripts/compare-pipelines.mjs 50`. Offline: no OpenAI credit was spent.

## Result

The new pipeline used **64.5% fewer tokens per look** than the old one: **2,673 instead of 7,537**. It was
cheaper in all 50 tests.

| Per look (mean of 50) | Old pipeline | New pipeline | Change |
|---|---|---|---|
| Tokens | 7,537 | 2,673 | **−4,865 (−64.5%)** |
| Tokens, if the old image comes out at high quality | 10,787 | 2,673 | −75.2% |
| Cost (the app's own price table) | $0.0748 | $0.0385 | −48.4% |
| Paid OpenAI calls | 4 | 2 | −2 |
| Images sent to OpenAI | 4 | 1 | −3 |

**The new pipeline's figure is pessimistic.** Real calls on 6 Nov 2026 measured the new pipeline at
1,857–1,970 tokens and about $0.028 per look (backend README). This model puts it at 2,673 tokens, mostly
because the test's design answer is wordier than real ones (see "Limits"). Against the real figure, the
saving would be about 74–75%. So **64.5% is a lower bound**.

## The two pipelines

| | Old: `POST /api/style-me` (v1) | New: `POST /api/v2/sessions` (v2) |
|---|---|---|
| Photo check | gpt-5.2 vision call on the full photo | local, in the sidecar (free) |
| Skin, height, build | estimated by the vision call | measured locally (free) |
| Design | 1 outfit, one call | 3 outfits, one streamed call |
| Image | gpt-image-1.5 edit of the full photo, quality `auto` | edit of a 1024×1536 cut-out, quality `low`, 2 streamed previews |
| Identity check | gpt-5.2 vision call with 2 images | local face embedding (free) |

## Where the tokens go (mean per look)

| Call | Old tokens | New tokens |
|---|---|---|
| Photo check (vision) | 1,549 | 0 (local) |
| Outfit design | 751 (1 outfit) | 1,375 (3 outfits) |
| Image edit | 2,947 | 1,297 |
| Face check (vision, 2 images) | 2,290 | 0 (local) |
| **Total** | **7,537** | **2,673** |

The new pipeline designs three outfits for less than the old pipeline's single photo check. Moving the
photo and face checks onto the device removed 3,839 tokens per look. The image call itself is 1,650
tokens smaller, mostly because it asks for low quality (the face is pasted back locally anyway).

## By photo type (10 tests each)

| Photo | Old tokens | New tokens |
|---|---|---|
| Webcam, landscape 1920×1080 | 7,676 | 2,673 |
| Kiosk, portrait 1080×1920 | 7,674 | 2,673 |
| Phone, 3024×4032 | 6,991 | 2,673 |
| Warm tungsten light, 1920×1080 | 7,676 | 2,673 |
| Cool, dim LED, 1280×720 | 7,668 | 2,673 |

The old pipeline's cost depends on the photo: it sends the original to OpenAI three times. The new one
always sends the same 1024×1536 cut-out, so its cost is flat. Phone photos are a little cheaper for the
old pipeline because the vision formula scales large images down to fewer tiles.

## How the numbers were produced

- **Same inputs for both.** The 10 synthetic people vary in skin depth (L* 32–76), undertone, build,
  clothing and gender, under 5 photo conditions: 50 pictures, in `pictures/`. Styles rotate through
  casual, office, wedding guest, party and smart casual. No real person's photo was used.
- **Real code for both.** Each test runs the actual v1 and v2 routes, orchestration, budget and retry
  code. Only the network calls are replaced:
  - OpenAI by a recorder that answers like the API and reports token usage.
  - The new pipeline's local sidecar by its test double. It's free either way, so it doesn't affect tokens.
- **Production settings:** final quality `low`, 2 streamed previews, face check on with 1 retry, no
  drafts, no prefetch.

| | Exact or modelled | How |
|---|---|---|
| Number and kind of paid calls | exact | recorded from the real code |
| Prompt and schema tokens | exact | OpenAI's o200k tokenizer (`gpt-tokenizer`) on the real prompts |
| Images sent, their sizes, quality asked for | exact | recorded from the real requests |
| Answer tokens | exact for the answers used | the old design answer is the real gpt-5.2 output saved on 5 Nov 2026 |
| Vision image tokens | modelled | OpenAI's tile formula: 85 + 170 per 512 px tile |
| Image-edit tokens | modelled, calibrated | this project's real gpt-image-1.5 calls: low 1,100, medium 2,750 per call, +100 per streamed preview |
| Reasoning tokens | set to 0 | unknown offline |

## Limits (read before quoting the numbers)

- **The old image at quality `auto`.** OpenAI decides the quality. The headline assumes medium, which is
  conservative. The 5 Nov report measured about $0.26 per visitor at the default quality, which matches
  high; at high the saving is 75.2%.
- **The new design answer is wordier than real.** Each of its three outfits copies the real 5 Nov
  outfit's long item descriptions: 959 output tokens, against about 900 for a whole real design call.
  This overstates the new pipeline by roughly 500–700 tokens.
- **Reasoning tokens are set to 0 for both.** The old pipeline makes three text calls to the new one's
  one, so this favours the old pipeline.
- **No face-check retries happened.** In real use, a drifted face makes the old pipeline render and
  check again (about +5,200 tokens). The new pipeline checks identity locally for free.
- **Offline is not the same as real calls.** These numbers aren't a substitute for a real run. To
  measure for real, swap the recorder in `scripts/compare-pipelines.mjs` for the real network call. Ten
  real paired runs would cost about $1–3.

## Files

| File | Contents |
|---|---|
| `pictures/` | the 50 test pictures (`tNN-person-condition.jpg`) |
| `results.jsonl` | one line per test: every call of both pipelines, with its tokens and cost |
| `calls.csv` | the same, one row per call (300 rows), for a spreadsheet |
| `summary.json` | all statistics, assumptions and calibration values |

To reproduce: `cd backend && node scripts/compare-pipelines.mjs 50`.
