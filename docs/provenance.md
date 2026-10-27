# Provenance: where this code came from

Rook is an independent program. It speaks the protocol of a closed-source
macOS browser, and people reasonably ask whether parts of that app ended up in
here. This document records a check that they did not, what the check can and
cannot prove, and the three overlaps it turned up on the way, each of which
traced to the public upstream project rather than to the app.

The audit is a script, not a claim: [`provenance-audit.sh`](provenance-audit.sh)
does everything described below and is meant to be re-run.

```sh
docs/provenance-audit.sh '/path/to/folder/holding/ego lite.app' \
    --cef=/path/to/cef_binary_156
```

It needs `strings`, `grep` and `awk`, the extracted app (not part of this
repository), and about two minutes. Exit status 0 means nothing of the app's
appears in this tree; anything unexplained fails the run.

## The two things being compared

| | |
|---|---|
| this tree | the Rook repository, commit `0793616`, as checked out |
| the app | `ego lite` 0.6.1.13 for macOS, a 432 MB extracted `.app` |

The app is a Chromium build with its own code on top: a 269 MB `ego Framework`
binary, a launcher, a bundled `ego-browser` helper, 220-odd locale archives, a
1.6 MB compiled asset catalogue and a 19 MB web front-end for its chat panel.
All of that goes into the corpus: every printable string of six characters or
more from every file, plus the full text of every CSS, HTML, SVG, plist,
`.strings`, `.sdef` and Markdown resource in it — 1,093,189 distinct lines.

## What it looks for

Probes are harvested from the app, and none of them may occur in this tree.
Six harvesters, chosen so that a copy of any kind has to carry something:

| Category | Probe | Why it is distinctive |
|---|---|---|
| identity | `com.citrolabs.*` bundle ids, `*.citrolabs.ai` hostnames | 45 of them; nobody invents these by accident |
| symbols | `Ego.*` UMA histogram names, `k*Space*`/`k*Ego*` view members, `ego.*` preference keys | names the app's own code adds to Chromium |
| UI copy | sentences of 30 characters or more carrying app vocabulary | 8,155 of them, from the binaries and the localisation archives |
| CSS | class names from the app's bundled web front-end | 399 names; a copied stylesheet keeps them |
| source paths | `../../ego/...` paths from the app's debug info | 303 file names from its own source tree |
| SVG | `d="…"` path data from its icon assets | 14 paths; copied artwork keeps its geometry |

That is 9,061 strings, de-duplicated to **9,011 probes**. A distinctiveness
filter drops 401 of them (single ordinary words, file names, fragments), and 97
are set aside as shared origin, explained below. **8,513 probes carry the
verdict.**

And the other direction, because a copy can run either way: identifiers of ours
are harvested the same way — our CSS classes, our C++ types, our control-socket
verbs and event names, our error codes, our UI sentences — and none of them may
occur in the app. 76 are generated, 24 dropped as stock phrases, 10 more by the
distinctiveness filter, 19 set aside as shared origin, and **23 carry that
verdict**.

## What is set aside, and why that is not a loophole

Two bodies of text cannot tell copying from shared origin, so a probe that
occurs in either is counted, reported and excluded:

**The upstream SDK.** `vendor/` and `patches/` are the MIT `ego-browser` SDK
(v2.1.0-6-gaecc583) and two small patches to it. It is public. The app bundles
the same upstream project: it ships an `ego-skills/ego-browser/` copy and an
`ego-browser` helper binary. So a string that exists in both is a string from
the upstream project, which both of us are entitled to have. The filter is
checked against the whole upstream checkout recorded in `vendor/UPSTREAM`, not
just the vendored subset, because the protocol documentation lives there and
prose from a published spec is not evidence about either app.

**The engine.** Both programs embed Chromium, so Chromium's own strings —
error text, translated UI, internal names — appear in both for boring reasons.
Those come from the CEF distribution's headers and from the Chromium resource
archives (`resources.pak`, `chrome_100_percent.pak`, `locales/en-US.pak`), which
this repository already has in `host/cef-runtime/`.

97 of 9,011 probes are set aside, just over one percent. The audit prints how
many, and `docs/provenance-reviewed.txt` exists for anything a future run turns
up that neither of these explains: an overlap listed there is waved through with
a written reason, and anything not listed fails.

## The result

```
A: 8513 probes from the app, 0 occurrence(s) in this tree
B: 23 identifiers of ours, 0 line(s) in the app's corpus
reviewed overlaps: 0 explained, 0 unexplained
clean
```

Zero of 8,513 app identifiers occur anywhere in this tree: not in the GTK
shell, not in the Node bridge or the CLI, not in the packaging, not in the
docs, not in the icon. Zero of our 23 distinctive identifiers occur in the app.

Three controls keep that from being a vacuous statement:

- **The grep works.** A string that exists only in our tree (a CSS class from
  `host/src/shell.cc`) is injected and must be reported: it is found in 26 lines. A
  zero result with a broken grep cannot pass.
- **The filter works.** A string the upstream SDK certainly contains must be
  found in the upstream corpus, and one of ours must not. If either is wrong the
  audit stops rather than reporting a clean result.
- **The audit bites.** It caught real overlaps while it was being built, below.

## The three overlaps it found

Nothing here is currently in the tree. Each was found by an earlier run,
investigated, and traced to the public upstream project — which then joined the
upstream corpus, because the first version of the filter only knew about the
vendored subset and got these wrong.

1. A sentence of ours in `runtime/bridge.js`, the message a space hands back
   when an agent takes it over. The app has the same sentence. So does the
   upstream protocol documentation, at `docs/native-bindings-api.md:639` of the
   upstream checkout, as the specified wording of that state. It is protocol
   text, and Rook is meant to speak it.

2. `highlightMouseTo`, our backend method for the pointer animation. It is a
   fragment of the upstream API's `animationHighlightMouseToPosition`
   (`package/ego-browser/src/driver/pointer.ts`), which the app's documentation
   also quotes.

3. `EGO_PROFILE_NOT_FOUND`, our error code for a profile id that does not exist.
   It is a documented code in the upstream spec,
   `docs/native-bindings-api.md:96`, `:506` and `:856`. Our own vendored build of
   the SDK does not contain it, which is why it looked like ours at first; the
   upstream checkout does.

Two bugs in the audit itself came out of this, and both would have let a real
copy through or libelled an honest one:

- The filter was case-sensitive while the hit scan was case-insensitive, so
  `highlightMouseTo` matched inside `animationHighlightMouseToPosition` but was
  not recognised as shared. Both sides are now case-folded together.
- Direction B matched substrings, so our CSS class `.tabstrip` "matched"
  Chromium's `Tabs.VerticalTabs.TabStripSize`, and our event name `tab.closed`
  "matched" `ContextualTasks.Tab.ClosedWithSidePanelOpenState`. Direction B now
  matches whole tokens. Direction A deliberately still matches substrings: a
  30-character sentence is its own evidence even where a localisation archive
  runs it into its neighbours.

## The icon

The one asset that is ours and could plausibly have been lifted is the app
icon. The app's `app.icns` carries a 128×128 PNG slice; Rook's
`packaging/assets/rook-256.png` resized to 128×128 differs from it by a
normalised RMSE of 0.518, where 0 is identical and roughly 1 is unrelated. The
bytes are not the same file. The icon was drawn for this project, in SVG, and
the PNGs in the package are rendered from it by `packaging/common.sh`.

## What this does not prove

Being explicit, because a clean result is easy to over-read:

- **It is a text comparison.** It cannot see independently written code that
  solves the same problem under different names, and it cannot see design or
  feature similarity. What it can see is reuse of names, sentences, class names,
  paths and path data, which is what copying actually leaves behind.
- **It compares sources, not machine code.** Nobody disassembled the app's
  binary to compare functions. The string corpus covers what the binary says,
  not what it computes.
- **The probes are only as good as the harvesters.** A speculative regex decides
  what counts as a distinctive identifier. If a copy had renamed everything, the
  harvesters would have nothing to find.
- **The shared-origin filter is broad on purpose.** Prose from the published
  protocol spec is excluded, which means app UI copy that happens to be in the
  spec too would be excluded with it. That is the price of not flagging every
  documented protocol string as a copy; the alternative produces noise, and
  noise gets ignored.
- **The app is not in this repository.** The audit needs an extracted copy of it
  and cannot run in a checkout that has none. It has been run against
  `ego lite` 0.6.1.13 only; a different version would need a fresh run.

## Re-running it

```sh
docs/provenance-audit.sh /path/to/folder/holding/'ego lite.app' \
    --cef=/path/to/cef_binary_156.0.14

# the pieces, if you want to do it by hand:
find .../Contents -type f -exec strings -a -n 6 {} + | sort -u > app.txt
grep -aoE 'Ego\.[A-Za-z0-9_.]{4,}' app.txt | sort -u > probes.txt
grep -rniF -f probes.txt host runtime bin scripts packaging docs bench README.md
```

`ROOK_AUDIT_DIR` moves the working directory, where the corpus and the
intermediate probe lists are kept, so a second run reuses them.
