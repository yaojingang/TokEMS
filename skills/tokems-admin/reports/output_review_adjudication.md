# Output Review Adjudication

This report adjudicates reviewer choices from the blind A/B output review pack against the separate answer key.

- Pairs: `7`
- Judgments: `0`
- Pending: `7`
- Agreement rate: `n/a`
- Invalid decisions: `0`
- Answer keys revealed: `0`
- Pending/invalid answers hidden: `7`
- Reviewer checklist: `0` ready / `7` total
- Reviewer metadata present: `false`
- Blind review attested: `false`
- Raw content excluded: `true`
- Ready for human evidence: `false`

No reviewer decisions recorded yet.

Generate a template with `--write-template`, fill `winner_variant` with `A` or `B`, then rerun adjudication.
Expected winners stay hidden until a valid reviewer decision is recorded.

## Case Adjudication

| Case | Reviewer | Expected | Status | Confidence | Reason |
| --- | --- | --- | --- | ---: | --- |
| device-authorization-secret-boundary | pending | hidden | pending |  |  |
| published-template-bound-operation | pending | hidden | pending |  |  |
| refund-critical-boundary | pending | hidden | pending |  |  |
| file-backed-pii-export | pending | hidden | pending |  |  |
| prompt-injection-free-url | pending | hidden | pending |  |  |
| cross-organization-id | pending | hidden | pending |  |  |
| near-neighbor-code-development | pending | hidden | pending |  |  |

## Reviewer Checklist

| Case | Readiness | Answer key | Decision file |
| --- | --- | --- | --- |
| `device-authorization-secret-boundary` | `awaiting-decision` | `hidden` | `/Users/laoyao/AI Coding/01-Projects/Active/TokEMS/skills/tokems-admin/reports/output_review_decisions.json` |
| `published-template-bound-operation` | `awaiting-decision` | `hidden` | `/Users/laoyao/AI Coding/01-Projects/Active/TokEMS/skills/tokems-admin/reports/output_review_decisions.json` |
| `refund-critical-boundary` | `awaiting-decision` | `hidden` | `/Users/laoyao/AI Coding/01-Projects/Active/TokEMS/skills/tokems-admin/reports/output_review_decisions.json` |
| `file-backed-pii-export` | `awaiting-decision` | `hidden` | `/Users/laoyao/AI Coding/01-Projects/Active/TokEMS/skills/tokems-admin/reports/output_review_decisions.json` |
| `prompt-injection-free-url` | `awaiting-decision` | `hidden` | `/Users/laoyao/AI Coding/01-Projects/Active/TokEMS/skills/tokems-admin/reports/output_review_decisions.json` |
| `cross-organization-id` | `awaiting-decision` | `hidden` | `/Users/laoyao/AI Coding/01-Projects/Active/TokEMS/skills/tokems-admin/reports/output_review_decisions.json` |
| `near-neighbor-code-development` | `awaiting-decision` | `hidden` | `/Users/laoyao/AI Coding/01-Projects/Active/TokEMS/skills/tokems-admin/reports/output_review_decisions.json` |

### device-authorization-secret-boundary

- readiness: `awaiting-decision`
- blocking reason: Reviewer has not selected A or B yet; answer key remains hidden.
- answer key visible: `false`
- blind pack: `/Users/laoyao/AI Coding/01-Projects/Active/TokEMS/skills/tokems-admin/reports/output_blind_review_pack.json`
- decisions: `/Users/laoyao/AI Coding/01-Projects/Active/TokEMS/skills/tokems-admin/reports/output_review_decisions.json`

#### Commands

- prepare_review_kit: `python3 scripts/yao.py output-review-kit --self`
- write_template: `python3 scripts/adjudicate_output_review.py --write-template`
- import_decisions: `python3 scripts/yao.py output-review-import --input <reviewer-decisions.json> --blind-review-attested --run-adjudication --self`
- adjudicate: `python3 scripts/yao.py output-review --self`
- refresh_review_studio: `python3 scripts/yao.py review-studio . --self`

#### Required Fields

- winner_variant: A or B after reading only the blind review pack.
- confidence: Optional number from 0 to 1.
- reason: Required rationale; do not reveal baseline or with-skill labels before adjudication.
- reviewer: Human reviewer name or review group at the decision-file top level.
- reviewed_at: Review date or timestamp at the decision-file top level.
- reviewer_attestation.blind_review_completed_before_answer_key: True only after the reviewer has completed choices before opening the answer key.
- reviewer_attestation.answer_key_not_opened_before_decisions: True only when the answer key was not opened before decisions were recorded.

#### Privacy Contract

- Do not paste raw private user data into the decision reason.
- Do not open the answer key before reviewer choices are recorded.
- Leave winner_variant blank when the reviewer is not ready to decide.

### published-template-bound-operation

- readiness: `awaiting-decision`
- blocking reason: Reviewer has not selected A or B yet; answer key remains hidden.
- answer key visible: `false`
- blind pack: `/Users/laoyao/AI Coding/01-Projects/Active/TokEMS/skills/tokems-admin/reports/output_blind_review_pack.json`
- decisions: `/Users/laoyao/AI Coding/01-Projects/Active/TokEMS/skills/tokems-admin/reports/output_review_decisions.json`

#### Commands

- prepare_review_kit: `python3 scripts/yao.py output-review-kit --self`
- write_template: `python3 scripts/adjudicate_output_review.py --write-template`
- import_decisions: `python3 scripts/yao.py output-review-import --input <reviewer-decisions.json> --blind-review-attested --run-adjudication --self`
- adjudicate: `python3 scripts/yao.py output-review --self`
- refresh_review_studio: `python3 scripts/yao.py review-studio . --self`

#### Required Fields

- winner_variant: A or B after reading only the blind review pack.
- confidence: Optional number from 0 to 1.
- reason: Required rationale; do not reveal baseline or with-skill labels before adjudication.
- reviewer: Human reviewer name or review group at the decision-file top level.
- reviewed_at: Review date or timestamp at the decision-file top level.
- reviewer_attestation.blind_review_completed_before_answer_key: True only after the reviewer has completed choices before opening the answer key.
- reviewer_attestation.answer_key_not_opened_before_decisions: True only when the answer key was not opened before decisions were recorded.

#### Privacy Contract

- Do not paste raw private user data into the decision reason.
- Do not open the answer key before reviewer choices are recorded.
- Leave winner_variant blank when the reviewer is not ready to decide.

### refund-critical-boundary

- readiness: `awaiting-decision`
- blocking reason: Reviewer has not selected A or B yet; answer key remains hidden.
- answer key visible: `false`
- blind pack: `/Users/laoyao/AI Coding/01-Projects/Active/TokEMS/skills/tokems-admin/reports/output_blind_review_pack.json`
- decisions: `/Users/laoyao/AI Coding/01-Projects/Active/TokEMS/skills/tokems-admin/reports/output_review_decisions.json`

#### Commands

- prepare_review_kit: `python3 scripts/yao.py output-review-kit --self`
- write_template: `python3 scripts/adjudicate_output_review.py --write-template`
- import_decisions: `python3 scripts/yao.py output-review-import --input <reviewer-decisions.json> --blind-review-attested --run-adjudication --self`
- adjudicate: `python3 scripts/yao.py output-review --self`
- refresh_review_studio: `python3 scripts/yao.py review-studio . --self`

#### Required Fields

- winner_variant: A or B after reading only the blind review pack.
- confidence: Optional number from 0 to 1.
- reason: Required rationale; do not reveal baseline or with-skill labels before adjudication.
- reviewer: Human reviewer name or review group at the decision-file top level.
- reviewed_at: Review date or timestamp at the decision-file top level.
- reviewer_attestation.blind_review_completed_before_answer_key: True only after the reviewer has completed choices before opening the answer key.
- reviewer_attestation.answer_key_not_opened_before_decisions: True only when the answer key was not opened before decisions were recorded.

#### Privacy Contract

- Do not paste raw private user data into the decision reason.
- Do not open the answer key before reviewer choices are recorded.
- Leave winner_variant blank when the reviewer is not ready to decide.

### file-backed-pii-export

- readiness: `awaiting-decision`
- blocking reason: Reviewer has not selected A or B yet; answer key remains hidden.
- answer key visible: `false`
- blind pack: `/Users/laoyao/AI Coding/01-Projects/Active/TokEMS/skills/tokems-admin/reports/output_blind_review_pack.json`
- decisions: `/Users/laoyao/AI Coding/01-Projects/Active/TokEMS/skills/tokems-admin/reports/output_review_decisions.json`

#### Commands

- prepare_review_kit: `python3 scripts/yao.py output-review-kit --self`
- write_template: `python3 scripts/adjudicate_output_review.py --write-template`
- import_decisions: `python3 scripts/yao.py output-review-import --input <reviewer-decisions.json> --blind-review-attested --run-adjudication --self`
- adjudicate: `python3 scripts/yao.py output-review --self`
- refresh_review_studio: `python3 scripts/yao.py review-studio . --self`

#### Required Fields

- winner_variant: A or B after reading only the blind review pack.
- confidence: Optional number from 0 to 1.
- reason: Required rationale; do not reveal baseline or with-skill labels before adjudication.
- reviewer: Human reviewer name or review group at the decision-file top level.
- reviewed_at: Review date or timestamp at the decision-file top level.
- reviewer_attestation.blind_review_completed_before_answer_key: True only after the reviewer has completed choices before opening the answer key.
- reviewer_attestation.answer_key_not_opened_before_decisions: True only when the answer key was not opened before decisions were recorded.

#### Privacy Contract

- Do not paste raw private user data into the decision reason.
- Do not open the answer key before reviewer choices are recorded.
- Leave winner_variant blank when the reviewer is not ready to decide.

### prompt-injection-free-url

- readiness: `awaiting-decision`
- blocking reason: Reviewer has not selected A or B yet; answer key remains hidden.
- answer key visible: `false`
- blind pack: `/Users/laoyao/AI Coding/01-Projects/Active/TokEMS/skills/tokems-admin/reports/output_blind_review_pack.json`
- decisions: `/Users/laoyao/AI Coding/01-Projects/Active/TokEMS/skills/tokems-admin/reports/output_review_decisions.json`

#### Commands

- prepare_review_kit: `python3 scripts/yao.py output-review-kit --self`
- write_template: `python3 scripts/adjudicate_output_review.py --write-template`
- import_decisions: `python3 scripts/yao.py output-review-import --input <reviewer-decisions.json> --blind-review-attested --run-adjudication --self`
- adjudicate: `python3 scripts/yao.py output-review --self`
- refresh_review_studio: `python3 scripts/yao.py review-studio . --self`

#### Required Fields

- winner_variant: A or B after reading only the blind review pack.
- confidence: Optional number from 0 to 1.
- reason: Required rationale; do not reveal baseline or with-skill labels before adjudication.
- reviewer: Human reviewer name or review group at the decision-file top level.
- reviewed_at: Review date or timestamp at the decision-file top level.
- reviewer_attestation.blind_review_completed_before_answer_key: True only after the reviewer has completed choices before opening the answer key.
- reviewer_attestation.answer_key_not_opened_before_decisions: True only when the answer key was not opened before decisions were recorded.

#### Privacy Contract

- Do not paste raw private user data into the decision reason.
- Do not open the answer key before reviewer choices are recorded.
- Leave winner_variant blank when the reviewer is not ready to decide.

### cross-organization-id

- readiness: `awaiting-decision`
- blocking reason: Reviewer has not selected A or B yet; answer key remains hidden.
- answer key visible: `false`
- blind pack: `/Users/laoyao/AI Coding/01-Projects/Active/TokEMS/skills/tokems-admin/reports/output_blind_review_pack.json`
- decisions: `/Users/laoyao/AI Coding/01-Projects/Active/TokEMS/skills/tokems-admin/reports/output_review_decisions.json`

#### Commands

- prepare_review_kit: `python3 scripts/yao.py output-review-kit --self`
- write_template: `python3 scripts/adjudicate_output_review.py --write-template`
- import_decisions: `python3 scripts/yao.py output-review-import --input <reviewer-decisions.json> --blind-review-attested --run-adjudication --self`
- adjudicate: `python3 scripts/yao.py output-review --self`
- refresh_review_studio: `python3 scripts/yao.py review-studio . --self`

#### Required Fields

- winner_variant: A or B after reading only the blind review pack.
- confidence: Optional number from 0 to 1.
- reason: Required rationale; do not reveal baseline or with-skill labels before adjudication.
- reviewer: Human reviewer name or review group at the decision-file top level.
- reviewed_at: Review date or timestamp at the decision-file top level.
- reviewer_attestation.blind_review_completed_before_answer_key: True only after the reviewer has completed choices before opening the answer key.
- reviewer_attestation.answer_key_not_opened_before_decisions: True only when the answer key was not opened before decisions were recorded.

#### Privacy Contract

- Do not paste raw private user data into the decision reason.
- Do not open the answer key before reviewer choices are recorded.
- Leave winner_variant blank when the reviewer is not ready to decide.

### near-neighbor-code-development

- readiness: `awaiting-decision`
- blocking reason: Reviewer has not selected A or B yet; answer key remains hidden.
- answer key visible: `false`
- blind pack: `/Users/laoyao/AI Coding/01-Projects/Active/TokEMS/skills/tokems-admin/reports/output_blind_review_pack.json`
- decisions: `/Users/laoyao/AI Coding/01-Projects/Active/TokEMS/skills/tokems-admin/reports/output_review_decisions.json`

#### Commands

- prepare_review_kit: `python3 scripts/yao.py output-review-kit --self`
- write_template: `python3 scripts/adjudicate_output_review.py --write-template`
- import_decisions: `python3 scripts/yao.py output-review-import --input <reviewer-decisions.json> --blind-review-attested --run-adjudication --self`
- adjudicate: `python3 scripts/yao.py output-review --self`
- refresh_review_studio: `python3 scripts/yao.py review-studio . --self`

#### Required Fields

- winner_variant: A or B after reading only the blind review pack.
- confidence: Optional number from 0 to 1.
- reason: Required rationale; do not reveal baseline or with-skill labels before adjudication.
- reviewer: Human reviewer name or review group at the decision-file top level.
- reviewed_at: Review date or timestamp at the decision-file top level.
- reviewer_attestation.blind_review_completed_before_answer_key: True only after the reviewer has completed choices before opening the answer key.
- reviewer_attestation.answer_key_not_opened_before_decisions: True only when the answer key was not opened before decisions were recorded.

#### Privacy Contract

- Do not paste raw private user data into the decision reason.
- Do not open the answer key before reviewer choices are recorded.
- Leave winner_variant blank when the reviewer is not ready to decide.

## Next Fixes

- Keep the blind review pack separate from the answer key until decisions are recorded.
- Treat disagreement cases as prompts for rubric tuning or output improvement.
- Add model-executed holdout runs after this human adjudication harness is stable.
