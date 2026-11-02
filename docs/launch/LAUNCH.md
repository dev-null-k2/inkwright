# Launch kit

Drafts for launch day. Post them in this order, a few hours apart:

1. Show HN on a Tuesday to Thursday morning US Pacific time.
2. X and Bluesky.
3. Reddit.
4. Product Hunt the following week.

Reply to every comment in the first six hours. Lead with the honest numbers: they are what makes this launch different.

---

## Show HN

**Title:** Show HN: Inkwright – an open-source handwriting notebook whose AI answers in ink

**Text:**

I write by hand on a foldable phone with a stylus, and I wanted three things no app gave me together:
- ink that feels like paper;
- an AI that works *on the page*;
- notes that stay plain files I own.

So I built Inkwright (Apache-2.0).

A few things that might be interesting to HN:

- **Scribble-to-erase** is a geometric classifier, not a model. On 580 synthetic cases it catches 99.6 % of scribbles and never erased a neighbouring word. The eval is in the repo.
- **The AI answers in handwriting**, written by a deterministic synthesiser built on single-line engraving fonts. AI ink carries an origin flag, so the authorship certificate never counts it as yours.
- **A "compiled wiki"** (Karpathy's LLM-wiki idea), where every sentence is tagged extracted, inferred or ambiguous and points at the exact region of the page it came from. Drafts are checked against their sources before you see them.
- **Every AI call goes through one guard.** It does policy routing, PII redaction with rehydration, reversible context compression (about 80 % fewer tokens on our tasks; "summarise everything" costs 47 % *more*), cost metering, and a signed, hash-chained audit log.
- **The prompt-injection detector is weak:** 29 % recall on held-out attacks. I publish that number. The protections that actually hold are structural: deletes always ask, dry-run mode, and local-only notebooks.
- **The notebook is also an MCP server** (spec 2026-07-28), an A2A agent, and a REST API with OpenAPI 3.1 and webhooks. `[[code:src/api.ts#createOrder]]` links a note to a function and flags it when the signature drifts.
- **No server of ours.** It's static files plus your own Google Drive, WebDAV or folder, plus your own key or an on-device model.

Repo: https://github.com/karthikkasukurti/inkwright. The web app runs in the browser, and there's an Android APK. I'd love feedback from anyone who writes with a stylus, and from anyone who has thoughts on the trust layer's design.

---

## X / Bluesky thread

1/ I built a handwriting notebook where the AI answers you *in ink*, on the page, in a colour that's never mistaken for yours. Open source, local-first, no server. 🧵 [GIF: lasso a question → handwritten answer appears]

2/ Paper feel first. A native ink tip on Android, nib sound that follows your speed, and scribble-to-erase that caught 99.6 % of scribbles in our eval without ever erasing a real word.

3/ Your notes compile into a wiki where every sentence cites the exact spot on the page it came from, and a linter flags when Tuesday-you disagrees with Friday-you.

4/ Every AI call passes one checkpoint: PII redaction, about 80 % fewer tokens, a $ meter and a signed audit log. Our injection detector is weak (29 % on held-out attacks), so writes are guarded structurally too. Honest numbers are in the README.

5/ It's also an MCP server, an A2A agent and a REST API. Your notebook becomes context for Claude Code, Cursor and your scripts. Notes linked to code get flagged when the code drifts.

6/ Apache-2.0. Web, Android, iPad, Mac, Windows. github.com/karthikkasukurti/inkwright ⭐

---

## Reddit

Post to r/selfhosted, r/LocalLLaMA, r/stylus and r/ObsidianMD, each on a different day, each with its own angle:
- **r/LocalLLaMA:** on-device models by default, a guarded router and honest evals.
- **r/selfhosted:** no server, an air-gapped Docker appliance, the vault as plain files.
- **r/ObsidianMD:** two-way Obsidian vault import and export, links and a 3D graph.
- **r/stylus and r/GalaxyTab, r/ipad:** the feel, scribble-erase and the pen-button eraser.

Title pattern: "I built an open-source handwriting notebook where the AI answers in ink (local-first, no server)". Add one paragraph for the angle, a GIF and the repo link. No hype words.

---

## Product Hunt

- **Tagline:** The handwriting notebook that writes back
- **Topics:** Productivity, Note-taking, Artificial Intelligence, Open Source, Developer Tools
- **First comment:** the HN text, shortened to four sentences, plus the honest-numbers table as an image.
- **Gallery:**
  1. Lecture page
  2. AI answer in ink (GIF)
  3. Sketch → Run
  4. Compiled wiki with Explain
  5. Routing and privacy screen
  6. The four palettes

---

## What to measure

- GitHub stars per hour on launch day (Trending needs roughly 300–800 in 24 h for a TypeScript repo).
- Web app opens.
- APK downloads.
- Issues filed by real stylus users. They are the best signal.
