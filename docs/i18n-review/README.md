# Hindi / Marathi review

Every hi/mr string was machine-written. `translation-review.xlsx` is the native-speaker
review sheet; the Instructions tab explains it to the reviewer.

- Regenerate after strings change: `python scripts/i18n/make_review.py`
- Apply a filled-in sheet: `python scripts/i18n/apply_review.py <file.xlsx> --dry-run`, then
  without `--dry-run`. Rows whose `{{placeholders}}` differ from English are rejected.
- Then: `cd web && npx vitest run src/__tests__/i18n-*` and open a PR.
- Answers on the Questions tab (Marathi terminator, transliterated words, tone) are applied by hand.

Machine checks that already run in CI (`web/src/__tests__/i18n-consistency.test.ts`):
placeholder parity, Hindi danda terminators, no mixed Marathi terminators.
