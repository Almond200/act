# Testside — digital ACT practice

Turn an ACT PDF (a full booklet, one section, or a test inside an Official Prep Guide) into an
on-screen test that looks and behaves like the digital ACT delivery system, so you can practice
reading, highlighting, and pacing on a screen instead of on paper.

## Run it

```bash
python3 serve.py
```

Then open <http://127.0.0.1:8740>. (A local server is needed because browsers block
IndexedDB and PDF workers on `file://` pages.) Everything stays in your browser.
The PDF, your answers, and your highlights are stored locally in IndexedDB.

## Importing

- **Text PDFs** (ACT's free practice booklets, "My Answer Key" forms such as A1D): imported
  in a few seconds. Sections, passages, questions, answer keys, "Not Scored" field-test items,
  and modified timing tables are read automatically.
- **Books with several tests** (Official Prep Guides): after indexing you pick which practice
  test to import. Answers and explanations come from the book's Explanatory Answers pages.
- **Scanned pages** (most tests inside the Prep Guides): recognized on-device with Tesseract OCR,
  at roughly 3–6 s per page. The first run downloads the OCR engine (about 10 MB). Results are
  cached, so re-importing is instant.
  Question numbers and choice letters are often unreadable at scan resolution, so questions are
  found from the A–D / F–J choice ladders (ACT alternates them) and English underlines are matched
  to the question printed beside them. Choices OCR isn't sure about are shown as crops of the
  scan, and any question whose layout can't be recovered is shown as an image with plain answer
  bubbles, so a section is never missing questions. With the tab in front, a 60-page test takes
  about 3–5 minutes the first time.
- The review screen lets you change a section's type or page range, paste a missing answer
  key (`1 B 2 J 3 A…` or `BJA…`), and **Preview** every question with its answer before saving.

How content is shown:

| Section | Passage | Questions |
|---|---|---|
| English | Reflowed text with the underlined portions and numbered boxes; the current question's underline is highlighted and scrolled into view | Text |
| Reading | Booklet line breaks with line numbers every 5 lines (or reflowed paragraphs, from the menu) | Text |
| Science | Text plus crisp crops of every figure and table | Text, or crops when a choice is a graph |
| Math | — | Plain questions as text; anything with fractions, radicals, matrices, or figures as crops |

## In the test

- **Back / Next**: <kbd>Alt</kbd>+<kbd>←</kbd> / <kbd>Alt</kbd>+<kbd>→</kbd>
- **Review**: grid of all questions (answered, unanswered, flagged). <kbd>Alt</kbd>+<kbd>R</kbd>
- **Flag** a question to revisit. <kbd>Alt</kbd>+<kbd>F</kbd>
- **Answer eliminator**: strike out choices.
- **Highlighter**: drag across passage or question text (three colours); click a highlight to remove it.
- **Line reader**: a movable, resizable reading window (drag the yellow tabs, or use ↑/↓).
- **Calculator** (Math): Desmos graphing calculator, as on the digital ACT (needs internet).
- **Menu**: zoom, contrast, line-numbered vs reflowed reading passages, full screen,
  pause (practice only), save & exit, end section.
- Timer counts down and warns at 5 minutes; the section is submitted when time runs out.
  Standard, time-and-a-half, and untimed modes.
- **Full test** runs every section in order, with the 10-minute break after Math.

After a section: raw score (field-test items excluded), time per question, per-passage
results, and a review mode showing the key, your answer, the book's explanation, and
**View in booklet** (the original page region) for every question.

## Files

- `js/parser.js`: PDF → sections/passages/questions (layout analysis on pdf.js text + vector graphics)
- `js/ocr.js`: Tesseract OCR adapter for scanned pages (words → text items, ink → rules and figures)
- `js/render.js`: renders figure/math crops from the stored PDF
- `js/app.js`: library, import review, test runner, results
- `js/store.js`: IndexedDB persistence
- `_dev/`: developer pages for checking conversions against the booklet (`verify.html`)

The interface is original. It borrows the general layout, type size, and tools of on-screen test
delivery, not any vendor's branding or artwork.
