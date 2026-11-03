# Handwritten maths

Write a problem, lasso it (or end it with "="), tap **Solve**. Inkwright reads the handwriting
from the strokes on the device, works the answer out with its own solver, and writes the result
next to the ink. This page explains how, what it can do, how accurate it is, and what still needs
checking on real hardware.

- Reader: `packages/core/src/mathink/` (pure TypeScript, no DOM)
- Engines on the app side: `apps/web/src/smart/inkmath.ts`; Android: `recognizeSymbols` in
  `apps/web/android/.../InkwrightNativePlugin.kt` and `recognition/HandwritingRecognizer.kt`
- Solver: `apps/web/src/smart/math.ts` (CAS) and `apps/web/src/smart/steps.ts` (exact steps)
- Eval: `apps/web/evals/mathink.eval.ts` (`npx vitest run --project evals apps/web/evals/mathink.eval.ts`)

## Why it works this way

Until November 2026, Solve sent a *picture* of the ink to whatever AI was active, before trying
on-device recognition — including small on-device vision models such as Gemma 4 E2B. On a Razr
Fold with a Moto Pen Ultra, a handwritten "2+2=" came back as "the Roman numeral fifteen followed
by a downward arrow". Small vision models are poor at handwriting, and a picture throws away what
a pen records: stroke order and direction, timing, and which marks belong together.

Now the strokes are read on the device first, always. A picture goes to an AI only when the
on-device reading is unavailable or unsure, and only to a strong vision model — a cloud provider
with your key, or a model server you run — never to a small on-device model
(`strongVisionAI` in `smart/read.ts`). Tables and circled-writing reads follow the same rule.

Every result says who read it: the result's tooltip ("Read by ML Kit on this device, solved on
this device"), the toast after solving, and the steps sheet. The note keeps it in `readBy`
(docs/VAULT_FORMAT.md).

## The pipeline

```
strokes ─▶ symbols ─▶ candidates ─▶ 2-D structure ─▶ best valid reading ─▶ plain + LaTeX ─▶ solver
          segment.ts  recognizer     layout.ts         decode.ts                               math.ts
                      + symbols.ts                                                              steps.ts
```

### 1. Strokes → symbols (`segment.ts`)

Handwritten maths is mostly one to three strokes per symbol. Strokes join into one symbol when
they cross (+, ×, 4, t), when two flat bars stack closely with nothing between them (=), when a
bar has a dot above and below (÷), when a short bar touches the top or bottom end of a stroke
(the foot of a 1, the flag of a 5), or when consecutive strokes stack tightly in one box (i, a
detached flag). Three things never join what they touch: a fraction bar (a flat stroke with writing
just above and just below), a radical sign (it encloses its radicand), and a neighbour that only
touches side by side. If the recognizer reads a group as several characters ("12" from two digits
that touch), the group is split at its widest gaps and the parts are read again.

### 2. Candidates (`symbols.ts`, a `SymbolRecognizer`)

Each group gets a ranked list of candidate labels from a recognizer, fused with what its geometry
alone says (a lone flat bar is "−", two stacked bars "=", a bar with dots "÷", a √-shaped stroke
"√"; two straight crossing strokes are "+" or "×/x"). Text recognizers answer in text, so answers
expand into the maths symbols they may stand for: "t" may be "+", "l" and "|" are "1", "o" is "0",
"V" may be "√", "TT" and "n" may be "π", "X" is "x" or "×". Engines, best first, all on device:

| Engine | Where | How |
|---|---|---|
| ML Kit Digital Ink | Android app | each symbol is recognized on its own (`recognizeSymbols`), up to 6 candidates with scores |
| Handwriting Recognition API | ChromeOS browsers | one drawing per symbol with `alternatives: 5` |
| Built-in classifier | everywhere | a $P point-cloud recognizer (Vatavu, Anthony & Wobbrock, ICMI 2012) over templates of the maths alphabet built from the two single-line fonts, plus π and √ |

**What ML Kit offers for maths.** ML Kit Digital Ink has no maths model. Its model list has text
recognizers for 300+ languages and three non-language classifiers — `zxx-Zsye-x-emoji`,
`zxx-Zsym-x-autodraw`, `zxx-Zsym-x-shapes` — and gesture classifiers (`en-x-gesture`)
([base models](https://developers.google.com/ml-kit/vision/digital-ink-recognition/base-models),
[overview](https://developers.google.com/ml-kit/vision/digital-ink-recognition)). The English
text model (`en`) handles digits and the common operators. A recognition result is a list of
candidates, most likely first, each with a text and a score where "more likely candidates get
lower values", the scale is unspecified, and the score "is populated only for models that support
it" ([DigitalInkRecognitionCandidate](https://developers.google.com/ml-kit/reference/swift/mlkitdigitalinkrecognition/api/reference/Classes/DigitalInkRecognitionCandidate.html)).
There is no per-character segmentation. That is why Inkwright segments symbols itself, asks ML Kit
about one symbol at a time with an empty pre-context, and treats scores as relative: weights are a
softmax of score differences mixed with a rank prior (`fromRanked`), so a strange score scale
cannot make the ranking meaningless.

### 3. Structure (`layout.ts`)

Within any region: fraction bars first, widest first — what sits just above (roughly centred) is
the numerator, what sits just below the denominator, each parsed again as a region so fractions
nest. Then radicals: everything inside the sign's box is the radicand. What is left splits into
lines (big symbols claim bands, small marks join the band they overlap most), so a system of
equations is several lines. Within a line, left to right: a symbol whose bottom is lifted well off
the previous symbol's bottom and which is smaller than full-size writing starts an exponent, which
continues while symbols stay up there; one hanging below the baseline after a letter starts a
subscript. A dot on the baseline is a decimal point, at mid-height a multiplication dot. All
thresholds are fractions of the typical symbol height, so any writing size and zoom work. If no
valid reading exists with the scripts found, the decoder tries again with them back on the line.

### 4. The most likely valid reading (`decode.ts`)

A beam search over the symbols in reading order (with structure markers between them) scores each
reading by the candidates' log-weights plus small priors (digits are likelier than stray letters,
x and y likelier than other letters, function names like sin are rewarded), and drops anything
that is not maths: an operator after an operator, ")" with nothing open, "." not between digits,
two "=" on a line. So context settles what shape cannot: "2x3" is 2 × 3 but "2x+1" has a
variable; a "t" between two numbers is a plus; "l" is a one. In a system, a reading where one line
lost a variable the other lines have is penalized (a misread letter is likelier than a different
problem). A trailing "=" means "evaluate". Output: plain maths for the solver (`2x+3=7`, `3/4`,
`x^2`, `sqrt(16)`) and LaTeX (`\frac{3}{4}`, `x^{2}`, `\sqrt{16}`).

The reader reports a confidence (geometric mean of the chosen candidates' weights) and the weakest
symbol's weight. Below 0.5 overall or 0.2 for one symbol (`CONFIDENT` in `smart/inkmath.ts`), a
strong vision AI may read the picture instead, if one is set up.

## Solving

`solveMath` (`smart/math.ts`) runs entirely on the device:

- **Exact arithmetic with steps** (`steps.ts`): BigInt fractions, the order of operations
  (brackets, powers, × ÷, + −, left to right), common denominators shown for fractions, integer
  powers and square roots of perfect squares. "1/2 + 1/3 =" is "= 5/6 ≈ 0.8333"; decimals in,
  decimals out ("3.5 + 1.25 =" is "= 4.75").
- **Percentages**: "15%" is 0.15, "20% of 50" is 10.
- **Equations**: linear and quadratic equations in one unknown with rational coefficients are
  solved exactly with the steps done by hand (expand, collect terms, divide; discriminant,
  factored form). Others go to the CAS (nerdamer) with a numeric root finder as the fallback.
- **Systems**: two linear equations in two unknowns by elimination with steps; larger systems
  through the CAS.
- **Calculus and units** through the CAS (derivatives, integrals, limits) and mathjs (units). The
  reader doesn't yet read handwritten ∫, d/dx or lim; typed input in other features does.

Steps worked out by the solver say "Worked out exactly on this device". If the solver cannot do a
problem, a strong vision AI (when set up) is asked to read and answer it, and the result says the
AI was involved (`origin: 'ai'`, `readBy`).

## Accuracy

The eval writes 350 problems as strokes — 70 each of arithmetic, fractions, powers & roots,
equations and systems — in three hands: A (EMS Felix, the print single-line font), B (EMS Allure,
the script font) and C (a hand drawn for the eval only: open 4s, crossed 7s, flagged 1s, two-stroke
5s, curly x; not among the built-in classifier's templates). On top: per-symbol size, slant and
rotation wobble, per-stroke offsets (so a "+" crosses off-centre and an "=" has uneven bars),
uneven spacing, a wandering baseline, random stroke order and direction, stacked fractions with
the bar written before, between or after the parts, exponents smaller and raised, radicals with an
overline, systems on two lines. Exact match means the reading is the same maths as the truth
(each side parsed and compared); solve-correct means the solver's answer equals the true answer.

**How the eval models ML Kit.** ML Kit cannot run off Android, so "ML Kit (simulated)" is a model
of its per-symbol behaviour (`evals/mathink/mlkitsim.ts`): for a group that is one whole symbol it
samples a ranked answer list from a confusion table — digits wrong about 5% of the time (twice the
2.5% character error rate Google reports for its production recognizer on IAM-OnDB, Carbune et al.,
*Fast multi-language LSTM-based online handwriting recognition*, IJDAR 2020,
[arXiv:1902.10525](https://arxiv.org/abs/1902.10525), because a lone symbol has no word context),
"+" read as "t" 9% of the time, "×" mostly as "x" or "X", "√" as "V" 30%, "π" as "n" or "TT" 35%;
several whole symbols read as their texts run together; a fragment of a symbol as what it looks
like. It knows which strokes belong to which symbol only to model recognition; grouping, layout and
decoding are tested for real.

Results (seeded, deterministic; November 2026):

| Before — old on-device path (ML Kit reads whole lines as text) | cases | exact match | solve-correct |
|---|---:|---:|---:|
| arithmetic | 70 | 25.7% | 25.7% |
| fractions | 70 | 0.0% | 0.0% |
| powers | 70 | 0.0% | 1.4% |
| equations | 70 | 44.3% | 44.3% |
| systems | 70 | 21.4% | 21.4% |
| **all** | 350 | **18.3%** | **18.6%** |

| After — stroke reader, ML Kit (simulated) | cases | exact match | solve-correct |
|---|---:|---:|---:|
| arithmetic | 70 | 95.7% | 95.7% |
| fractions | 70 | 94.3% | 94.3% |
| powers | 70 | 92.9% | 92.9% |
| equations | 70 | 95.7% | 95.7% |
| systems | 70 | 91.4% | 91.4% |
| **all** | 350 | **94.0%** | **94.0%** |

| After — stroke reader, built-in classifier | cases | exact match | solve-correct |
|---|---:|---:|---:|
| hand A (template font) | 120 | 92.5% | 92.5% |
| hand B (template font) | 115 | 95.7% | 95.7% |
| hand C (unseen) | 115 | 44.3% | 45.2% |
| **all** | 350 | **77.7%** | **78.0%** |

How to read these honestly:

- The "before" path is the app's old on-device route: line segmentation (`segmentLines`) cut maths
  into fragments and the solver got flat text ("3²" as "32", fractions as separate lines, "×" as
  "x"). On the phone the old code went to the vision AI first whenever one was active; that path
  can't be measured here, and the field report says how it went.
- The ML Kit numbers measure everything except ML Kit itself. Most remaining errors are the
  simulated digit confusions (a 6 read as 0) that no grammar can catch. Real ML Kit may be better
  or worse on single symbols than the model assumes; recorded samples will tell (below).
- The built-in classifier is excellent on the fonts it was built from and poor on a hand it has
  never seen (44%: it reads open 4s as 9s, for one). On the web without a recognizer it is the only
  engine, and its confidence is reported, so unsure readings can go to a strong AI when one is set
  up. More templates from real samples would help it most.
- Synthetic handwriting is not real handwriting. These numbers are a regression bar (the eval fails
  below 85% for simulated ML Kit and 75% for the built-in classifier on hands A and B), not a claim
  about a particular person's writing.

## Tuning with real handwriting

Settings › About › Check this device › **Record handwriting samples**: write on the pad, type what
you meant ("2+2=", "x^2-4", "π"), save, repeat, then **Share file**. The file
(`inkwright-handwriting-samples-YYYY-MM-DD.json`, format in `devicecheck/samples.ts`) holds the
strokes with timing and pressure, the labels, what the device's reader made of each sample, and
the device's screen and user agent — nothing else, and nothing leaves the device unless you share
it. To measure a file:

```sh
INKWRIGHT_SAMPLES=~/Downloads/inkwright-handwriting-samples-2026-11-02.json \
  npx vitest run --project evals apps/web/evals/mathink.eval.ts -t "real samples"
```

It reports how often the phone (ML Kit) read the samples right when they were saved, and how the
built-in classifier reads them here, with the misses listed.

## Still to check on a real phone

These can only be verified on the Razr Fold with the Moto Pen Ultra (or another Android device):

1. ML Kit's real per-symbol answers and scores: the bridge (`recognizeSymbols`) is JVM-tested on
   representative fixtures, not on recorded ML Kit output. Record 100 or so samples, including
   "+", "×", "x", "÷", "√", "π", fractions and exponents, and run the samples eval.
2. The confidence thresholds (`CONFIDENT`): too high sends readable ink to the AI, too low keeps
   misreadings. Tune them from the samples' `read.confidence` values.
3. ML Kit's `WritingArea` and coordinates: inks are sent relative to the problem's top-left with
   the problem's size as the area; check "o"/"0" and "-"/"_" come out right at different zooms.
4. Speed: one ML Kit call per symbol, batched in one bridge call; a 20-symbol system should read in
   well under a second. The built-in classifier takes 50–400 ms per problem on this machine.
5. Stroke timing from the Moto Pen Ultra (coalesced events) and how the pen's own palm rejection
   affects stray marks inside a lasso.
