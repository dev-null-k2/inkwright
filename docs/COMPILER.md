# The context compiler

Notes that maintain themselves and can be trusted. Inkwright compiles the notes you choose into a
**compiled wiki** (topic, concept, project and people pages, a glossary and an index), keeps it up
to date as the notes change, and can say for every sentence it wrote where that sentence came from.
Around that core sit a **contradiction linter**, **spaced repetition** and a **teach-back tutor**,
a built-in **"Does my memory help?" eval**, **context packs** for other agents, and a light
**people and follow-ups** view.

Everything runs in the app on your device; the compiler uses an on-device model by default and
works with no model at all (pages are then made of quotes).

## Where this comes from

- **Karpathy's "LLM wiki"** (April 2026): an LLM compiles raw sources into an interlinked Markdown
  wiki with index files, and runs "lint" passes for inconsistencies. People build it by hand with
  Claude Code and Obsidian; no notes app ships it. Reviewers' gaps — provenance on every AI-written
  claim, staleness when sources change, contradiction linting, measurable usefulness — are what
  this design is built around.
- **graphify**: deterministic structure first (parsers, hashes for incremental updates), the model
  only at the edges, and every relation tagged **EXTRACTED / INFERRED / AMBIGUOUS**. The compiler
  tags every *sentence* the same way.
- **A-MEM** (agentic memory with Zettelkasten-style linked notes) and **Letta context
  repositories** (git-versioned memory files with descriptive front matter, background
  reflection): memory as plain, versioned, inspectable files. Here that is the vault itself —
  compiled pages are ordinary notes, provenance and state are JSON beside them, every accepted
  change is an undoable activity-log entry and is covered by version history.
- **Claim extraction** work (atomic, decontextualised, verifiable claims): the ledger extracts
  atomic claims with numbers, units, dates and decisions by rule, and checks them deterministically
  where it can.
- **FSRS-6** via **ts-fsrs 5.4** (MIT, the scheduler Anki uses). ts-fsrs 6.0 needs Node 24, so the
  5.x line (FSRS-6 algorithm, Node ≥ 20) is used.

## Pipeline

```
notes ─► extraction (rules) ─► source units: one sentence each, with note/page/rect/strokes/
          │                    text box/recording moment and a content hash
          ├─► plan (rules): pages ← tags, shared headings, loose notes, [[links]], defined terms,
          │                 "Project X", people (with consent); glossary; index
          │                 fingerprint = hash(title, cited sentence hashes)
          ├─► changed pages only ─► draft (model, or quotes without one)
          │        ─► validate against the sources (drop / downgrade / force AMBIGUOUS)
          │        ─► claims with anchors ─► diff against the page now ─► PROPOSAL
          └─► ledger (rules, background): claims ─► conflicts ─► grey zone ─► on-device model
```

### 1. Extraction (`packages/core/src/compiler/extract.ts`, `entities.ts`)

A note becomes **source units** — single sentences that know exactly where they are:

| From | Anchor |
|---|---|
| Typed text (Markdown) | page, the line's slice of the text box, text box id, nearest heading |
| Recognized handwriting | page, the recognized line's bounds and stroke ids (`recognizedLines`) |
| Imported PDF | page, the text layer's paragraph bounds |
| Recording transcript | the recording and segment time, the page and ink written while it was said |

Each unit has `sentenceHash` (normalised text): the same sentence anywhere hashes the same. Rules
also pull out headings, `[[links]]`, `#tags`, dates (ISO, "3 Dec", "Dec 3rd", "12/03", weekdays and
"tomorrow" resolved against the note's own date), people (after "call/email/ask/meet/follow up
with…", before "said/will/to send…", attendee lists, titles, @mentions; capitalised words that are
days, months, products or pronouns are not people), projects, definitions ("Term: meaning",
"Term is a …") and action items (checkboxes, "TODO:", "Sam to send…", "follow up with Priya
about…", "I need to…", with owner and due date). Precision over recall: a missing person page is
better than a page about "Monday".

### 2. Planning and incremental compiles (`wiki.ts`)

Page keys are stable (`topic:atlas`, `concept:embedding`, `person:priya-shah`, `glossary`,
`index`), so a page keeps its note across compiles. A page's fingerprint is the hash of the hashes
of the sentences it cites: editing an unrelated note recompiles nothing; editing one sentence
recompiles exactly the pages that cite it. Pages whose sentences didn't change but moved on the
page are **re-anchored silently** (no proposal). Compiled notes (tag `compiled`, notebook
"Compiled wiki") are never their own sources. A rejected change is remembered by fingerprint and
not proposed again until its sources change.

### 3. Drafting and validation (`packages/ai/src/compiler/draft.ts`, core `validateDraft`)

Topic, concept and project pages are drafted by the model from numbered source sentences
(`S1 [Note, p.2, handwritten]: …`) with a strict JSON prompt (`compiler.page/1`). Glossary, index
and people pages are always built by the rules (exact, cheap, private). Before anything is shown,
each sentence is checked:

- it must cite at least one real source sentence (else dropped);
- ≥ 34 % of its content words must be in what it cites (else dropped: "not supported");
- every number it states must appear in its sources (else dropped);
- EXTRACTED must be a near-quote (≥ 80 % of its words in one cited sentence), else it becomes
  INFERRED;
- a sentence citing sources that conflict is AMBIGUOUS, whatever the model said;
- known disagreements always get an AMBIGUOUS line, even if the model missed them.

When the reply has no usable sentences, or the model fails, the page falls back to quotes, and the
proposal says so. What validation dropped is listed in the proposal ("3 sentences the AI wrote
were left out"), so nothing disappears silently.

### 4. Proposals and applying (`compile.ts`)

A compile writes a proposal (`ai/compiler/proposals/<id>.json`) and changes no note. The Compiled
wiki screen shows it page by page: **+** added and **−** removed claims, each with its tag and
number of sources, ticked by default; accept or reject per page, untick single claims, or accept
or reject all. Accepting writes through the same paths as other agent edits (the open note through
its `NoteDocument`, others through the vault) and logs one activity run: `note_created` for new
pages, the new `text_replaced` op for updates (undo puts the old text back if untouched since),
`note_trashed` for archived pages whose sources are all gone. Lines you wrote yourself on a
compiled page (no provenance) are kept under "Your notes" when the page is updated.

Compiling runs on demand (Compile now), from the assistant (`compile_wiki` tool — proposals only),
and nightly with the **Compile my wiki** routine template (02:40).

### 5. Provenance and "Explain" (`provenance.ts`, `attribute.ts`, `apps/web/src/compiler/ui/Explain.tsx`)

Every sentence of AI text carries a claim: its text, tag, source anchors, confidence and the
generation that wrote it (model label, provider — "device" for on-device —, model id, prompt id
with version, time). Anchors are compact strings that convert to the app's `#mem/…` links:

```
<noteId>/<page 1-based>[/x,y,w,h][@<clipId>:<ms>]#<sentence hash>
```

Staleness is a set lookup: a claim is **stale** when a sentence it cites no longer exists in its
note, **missing** when the note is gone. Stale claims show on compiled pages ("2 stale") and in
Explain, with **Re-check** (a proposal for that page only). Anchors with hash `0` point at a
region rather than a sentence (ink a solver read) and can't go stale.

Explain is available for compiled pages (Compiled wiki › Explain, or ••• › Sources of AI text on
the page), assistant answers (Explain under the reply), summaries (Explain, and the provenance is
kept when the summary is saved), answers inserted on a page (provenance kept), and solved maths
(••• › Sources of AI text). Tapping a sentence shows the tag (or "Not from your notes"), support,
freshness, each source with a picture of the ink/page region and its words or the moment in the
recording, and who wrote it. Answers are attributed to the passages the model actually read in
that turn (`search_memory`, `read_note`, `search_notes` results) by the links it cited and by
overlap; nothing is invented to fill a gap.

### 6. The contradiction linter (`claims.ts`, `packages/ai/src/compiler/ledger.ts`)

Atomic claims are extracted by rule from every readable note in the background (debounced after
saves, at idle, cached per note version): **constraints** ("must stay under 50 ms", "at least
99.9 %", "budget is at most $5k"), **measurements** ("averages 110 ms", "hit 900 MB"), **dated
events** ("the launch is on Dec 3") and **decisions** ("we decided (not) to use Postgres").
Quantities are parsed with units and normalised (ns…weeks, B…TiB, currencies, %, rates, lengths,
masses); only the same dimension (and currency) compares. A constraint without a comparator takes
its direction from the concept (uptime and coverage are floors; latency, size and cost caps).

Two claims conflict when (a) their subjects match — shared words, a shared measured concept
("p95/averages/pipeline … ms" is latency), shared context (tag, notebook, heading, link) — minus a
penalty when each side *names* something the other doesn't in the words before the value
("Postgres p99" vs "Kafka p99"), and (b) their values are incompatible: a measurement breaks a
limit, two limits can't both hold or differ, two dates for one event, a decision reversed.
Measurement-vs-measurement disagreements additionally need one note, or shared context and a
shared title word. Plans changed on purpose ("moved to", "now", "instead") are not conflicts.
Confidence = subject match × kind weight; only ≥ 0.6 is shown. Pairs between 0.4 and 0.6 go to an
**on-device model only** (never a cloud model in the background; at most 4 new pairs per scan),
which promotes a pair only when it says same subject + contradiction with confidence ≥ 0.75.

Conflicts appear as quiet badges beside the sentence in the editor (tap: both sides, linked) and
in the Conflicts screen. "Not a conflict" or "Resolve…" with a note stores a decision
(`ai/ledger/<id>.json`); a decided conflict stays quiet while both sentences stay the same.

### 7. Study (`study.ts` in core, ai and web)

Decks are made from a note, a lasso selection (ink or text), or a compiled page. With a model,
cards must cite the sentence they test and their answer must be in it (else dropped); without one
the rules write definition and cloze cards ("Latency must stay under ___." → "50 ms"). Cards keep
the source anchor. **Review** is a calm full-screen sheet: answer by typing or writing with the
pen on an answer pad (read by on-device recognition where available, else the AI's vision), Show
answer (Space), see your answer graded (numbers must match; the rules always run, a model adds
feedback), the card's source with a picture, and rate 1–4 with the next interval on each button.
**Teach me back** asks explanatory questions about a notebook or note, grades the answer against
the sources (gaps, contradictions, a full answer), and first lists where *your notes* disagree
with *the sources* (recordings and imported PDFs count as sources).

### 8. "Does my memory help?" (`memeval.ts`, Settings › AI)

Held-out questions are generated by rule from the user's notes (numbers, dates, definitions; spread
across notes), asked under *model alone*, *with retrieval from notes* (the app's hybrid memory
search) and *with notes and compiled wiki*; answers are graded by rule, citations checked against
the note each fact lives in, tokens counted from provider usage. Conditions are compared with an
exact McNemar test; p ≥ 0.05 is reported as "No significant difference", and fewer than 10
questions as "too few to tell". The report is saved as `ai/evals/memory.json`.

### 9. Context packs and AGENTS.md (`packs.ts`)

A pack bundles chosen notes, the compiled pages about them (every line tagged and cited with
numbered references to note and page) and key ink (pages with unrecognized handwriting, as
images), within a character budget (≈ 12k tokens by default; what doesn't fit is listed). Export
as **Markdown**, **JSON** (images base64), an **Agent Skill folder** (`SKILL.md` +
`references/context.md` + `assets/`, zipped), or **Save for agents**: `ai/packs/<id>/` is served
by the MCP server as the resource `inkwright://packs/{id}`. **AGENTS.md** exports standing
instructions and facts from assistant memory and decisions found in notes, each with where it was
made.

### 10. People and follow-ups

With consent (Compiled wiki › People pages, or the People screen), names found by the rules get
person pages in "Compiled wiki › People" with their mentions, action items and follow-ups; the
People screen lists them with links to each item. The **Follow-ups from today's meetings**
routine template (17:40 and after each recording) uses the `list_followups` tool and appends open
items, grouped by person, to a "Follow-ups" note.

## Privacy

Extraction, the ledger, staleness and the people rules run on the device with no model. Compiling
uses an on-device model by default; "My AI" sends the source sentences of the pages being compiled
to the configured provider (the setting says so). Locked notes are never read. The memory eval
uses the configured AI and its tokens, and says so before it runs.

## Vault files

See docs/VAULT_FORMAT.md § Context compiler: `ai/compiler/{config,state}.json`,
`ai/compiler/proposals/`, `ai/ledger/`, `ai/study/` (merged card by card), `ai/packs/`,
`ai/evals/memory.json`, and `notes/<id>/assets/provenance.json` (merged item by item).

## Evals and tests

| What | Where | Bar | Result (scripted model / rules) |
|---|---|---|---|
| Contradictions, pairwise (58 labelled pairs, 25 conflicts incl. 2 "hard") | `packages/core/evals/compiler.eval.ts` | precision ≥ 0.95, recall ≥ 0.8 | precision **1.00**, recall **0.92** (misses: the two hard pairs) |
| Noise floor (40 everyday notes, 81 claims, no conflicts) | same | ≤ 1 false alarm | **0** |
| Staleness (90 claims; edits, deletions, moves, trashed notes) | same | accuracy = 1 | **1.00** |
| Anchors of extracted claims | same | all resolve to the right sentence and place | **72/72** |
| Drafts vs a noisy model (18 gold-labelled sentences) | `packages/ai/evals/compiler.eval.ts` | provenance precision ≥ 0.9, unsupported pass-through ≤ 0.25, recall ≥ 0.85, tag accuracy ≥ 0.85 | **0.917, 0.167, 0.917, 0.909** |

The draft eval's misses are deliberate and honest: a supported paraphrase with low word overlap is
dropped, an inference that reuses the source's words passes as EXTRACTED, and a plausible but
unsupported link between two cited sources ("the quiz covers Fourier transforms") passes. Set
`INKWRIGHT_EVAL_PROVIDER/KEY/MODEL` to draft the same pages with a real model and print its
validation report.

Unit tests: `packages/core/test/compiler.test.ts`, `packages/ai/test/compiler.test.ts`,
`packages/sync/test/compiler-merge.test.ts`, `apps/mcp-server/test/packs.test.ts`,
`apps/web/src/compiler/explain.test.ts`. End to end: `apps/web/e2e/compiler.spec.ts`.

## Limitations

- Extraction, entities and claims are English-centric rules. Other languages get units, anchors,
  provenance and staleness, but fewer people, definitions and decisions.
- Subject matching is lexical plus a small concept lexicon; differently worded claims about the
  same thing in unrelated notes ("rent" vs "the new flat") are missed unless an on-device model
  adjudicates them, and the model only sees grey-zone pairs.
- Validation is lexical: it reliably drops invented facts, numbers and citations, but cannot judge
  whether an inference that reuses the source's words is valid.
- Web pages added as sources are fetched by the browser; most sites block that (CORS) and the app
  says so — paste the text into a note instead.
- The nightly routine runs while the app is open (or catches up on open). The always-on runner
  (`inkwright-agent`) has no `compile_wiki` tool yet; the routine says so and stops there.
- On-device quality depends on the model; small models fall back to quotes more often (the
  proposal shows when that happened).
