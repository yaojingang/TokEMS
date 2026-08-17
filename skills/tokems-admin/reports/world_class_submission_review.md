# World-Class Submission Review

Generated at: `2026-08-17`

## Summary

- decision: `fix-submissions`
- review items: `4`
- accepted: `0`
- awaiting submission: `0`
- valid packet but source incomplete: `0`
- ready for ledger review: `0`
- fix submission: `4`
- unmatched submissions: `0`
- ready to claim world-class: `false`
- review counts submission as completion: `false`

This report is a read-only reviewer queue. It does not accept evidence or make world-class completion true.

## Queue

| Evidence | Review state | Intake | Source accepted | Submission | Next action |
| --- | --- | --- | --- | --- | --- |
| `provider-holdout` | `fix-submission` | `fail` | `false` | `invalid-contract` | Run evidence-build with DEEPSEEK_API_KEY and keep raw outputs in the isolated run directory. |
| `human-adjudication` | `fix-submission` | `fail` | `false` | `invalid-contract` | Collect three controlled reviewer packets and adjudicate them against the private run answer key. |
| `native-permission-enforcement` | `fix-submission` | `fail` | `false` | `invalid-contract` | Integrate a real target-client or external installer runtime guard before claiming native permission enforcement. |
| `native-client-telemetry` | `fix-submission` | `fail` | `false` | `invalid-contract` | Install a real client against the native host and import production metadata-only events. |

## Details

### Provider Holdout

- review state: `fix-submission`
- blocking reason: Submission exists but fails the ledger submission contract.
- ledger status: `pending`
- submission status: `invalid-contract`
- intake status: `fail`
- source accepted: `false`
- submission path: `evidence/world_class/submissions/provider-holdout.json`

#### Source Checks

- Provider model run: 0 / >0 => blocked
- Timing observed: 0 / >0 => blocked
- Token usage observed: 0 / >0 => blocked

#### Completion Assertions

- reports/provider_output_evaluation.json summary.call_count == 40
- reports/provider_output_evaluation.json summary.model_executed_count == 40
- reports/provider_output_evaluation.json summary.failure_count == 0
- reports/provider_output_evaluation.json summary.total_tokens <= 250000
- reports/skill_os2_audit.json item provider-holdout status becomes pass

#### Intake Errors

- template_only must be false
- submitted_by must not use template placeholder text
- submitted_at must use YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ
- artifact_refs[0].path does not exist as a local file
- all required evidence artifacts must have verified sha256 digests
- attestation.real_external_or_human_evidence must be true for a real submission
- attestation.reviewer_or_operator_identity_present must be true for a real submission
- attestation.artifact_refs_reviewed must be true for a real submission
- attestation.privacy_contract_satisfied must be true for a real submission
- attestation.ledger_reviewer_approved must be true for a real submission
- attestation.ledger_reviewer is required
- attestation.ledger_reviewed_at must use YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ
- attestation.ledger_reviewer must be different from submitted_by
- attestation.ledger_reviewed_at must be at or after submitted_at

#### Privacy Contract

- Do not commit provider credentials or environment dumps.
- The output execution report records output hashes and aggregate run metadata, not raw provider prompts.

### Human Adjudication

- review state: `fix-submission`
- blocking reason: Submission exists but fails the ledger submission contract.
- ledger status: `pending`
- submission status: `invalid-contract`
- intake status: `fail`
- source accepted: `false`
- submission path: `evidence/world_class/submissions/human-adjudication.json`

#### Source Checks

- Review pairs exist: 7 / >0 => pass
- No pending decisions: 7 / ==0 => blocked
- Judgments complete: 0 / ==pair_count => blocked
- No invalid decisions: 0 / ==0 => pass
- Reviewer metadata: False / true => blocked
- Reason required: True / true => pass
- Blind review attested: False / true => blocked
- Raw content attested: True / true => pass
- Raw content blocked: False / false => pass
- Human evidence ready: False / true => blocked

#### Completion Assertions

- reports/provider_output_adjudication.json summary.reviewer_count == 3
- reports/provider_output_adjudication.json summary.pair_count == 20
- reports/provider_output_adjudication.json summary.failure_count == 0
- reports/provider_output_adjudication.json evidence_binding.blind_pack_sha256 matches the source run
- reports/skill_os2_audit.json item human-adjudication status becomes pass

#### Intake Errors

- template_only must be false
- submitted_by must not use template placeholder text
- submitted_at must use YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ
- artifact_refs[0].path does not exist as a local file
- artifact_refs[1].path does not exist as a local file
- all required evidence artifacts must have verified sha256 digests
- attestation.real_external_or_human_evidence must be true for a real submission
- attestation.reviewer_or_operator_identity_present must be true for a real submission
- attestation.artifact_refs_reviewed must be true for a real submission
- attestation.privacy_contract_satisfied must be true for a real submission
- attestation.ledger_reviewer_approved must be true for a real submission
- attestation.ledger_reviewer is required
- attestation.ledger_reviewed_at must use YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ
- attestation.ledger_reviewer must be different from submitted_by
- attestation.ledger_reviewed_at must be at or after submitted_at

#### Privacy Contract

- Reviewer packets contain choices, reasons, hashes, and controlled submission metadata without raw prompts or answer-key roles.
- The private answer key remains under .yao/runs and is opened by the finalizer after all controlled packets are fixed.
- The adjudication and lineage artifacts preserve blind_pack_sha256 and answer_key_sha256 commitments.

### Native Permission Enforcement

- review state: `fix-submission`
- blocking reason: Submission exists but fails the ledger submission contract.
- ledger status: `pending`
- submission status: `invalid-contract`
- intake status: `fail`
- source accepted: `false`
- submission path: `evidence/world_class/submissions/native-permission-enforcement.json`

#### Source Checks

- Native enforcement: 0 / >0 => blocked
- Probe failures: 0 / ==0 => pass
- Installer support: True / true => pass

#### Completion Assertions

- reports/runtime_permission_probes.json summary.native_enforcement_count > 0
- reports/runtime_permission_probes.json summary.failure_count == 0
- reports/runtime_permission_probes.json summary.installer_enforcement_pass_count records local installer enforcement but does not replace native evidence
- reports/skill_os2_audit.json item native-permission-enforcement status becomes pass

#### Intake Errors

- template_only must be false
- submitted_by must not use template placeholder text
- submitted_at must use YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ
- artifact_refs[0].sha256 is required for a real submission
- artifact_refs[1].sha256 is required for a real submission
- artifact_refs[2].path artifact_refs path must be concrete, not a placeholder or glob
- all required evidence artifacts must have verified sha256 digests
- attestation.real_external_or_human_evidence must be true for a real submission
- attestation.reviewer_or_operator_identity_present must be true for a real submission
- attestation.artifact_refs_reviewed must be true for a real submission
- attestation.privacy_contract_satisfied must be true for a real submission
- attestation.ledger_reviewer_approved must be true for a real submission
- attestation.ledger_reviewer is required
- attestation.ledger_reviewed_at must use YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ
- attestation.ledger_reviewer must be different from submitted_by
- attestation.ledger_reviewed_at must be at or after submitted_at
- native-permission-enforcement runtime probe summary.native_enforcement_count must be >0
- native-permission-enforcement native target rows must match summary.native_enforcement_count
- native-permission-enforcement must include at least one native-enforced target row

#### Privacy Contract

- Do not mark native_enforcement true for metadata-only fallbacks.
- Keep residual risks visible for targets that still rely on operator enforcement.

### Native Client Telemetry

- review state: `fix-submission`
- blocking reason: Submission exists but fails the ledger submission contract.
- ledger status: `pending`
- submission status: `invalid-contract`
- intake status: `fail`
- source accepted: `false`
- submission path: `evidence/world_class/submissions/native-client-telemetry.json`

#### Source Checks

- External events: 0 / >0 => blocked
- Adoption sample: 0 / >0 => blocked
- Raw content blocked: False / false => pass

#### Completion Assertions

- reports/adoption_drift_report.json summary.source_types.external > 0
- reports/adoption_drift_report.json summary.adoption_sample_count > 0
- reports/skill_os2_audit.json item native-client-telemetry status becomes pass

#### Intake Errors

- template_only must be false
- submitted_by must not use template placeholder text
- submitted_at must use YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ
- artifact_refs[0].sha256 is required for a real submission
- artifact_refs[1].path does not exist as a local file
- all required evidence artifacts must have verified sha256 digests
- attestation.real_external_or_human_evidence must be true for a real submission
- attestation.reviewer_or_operator_identity_present must be true for a real submission
- attestation.artifact_refs_reviewed must be true for a real submission
- attestation.privacy_contract_satisfied must be true for a real submission
- attestation.ledger_reviewer_approved must be true for a real submission
- attestation.ledger_reviewer is required
- attestation.ledger_reviewed_at must use YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ
- attestation.ledger_reviewer must be different from submitted_by
- attestation.ledger_reviewed_at must be at or after submitted_at
- native-client-telemetry adoption drift summary.source_types.external must be >0
- native-client-telemetry adoption drift summary.adoption_sample_count must be >0
- native-client-telemetry external event rows must cover summary.source_types.external
- native-client-telemetry must include at least one external adoption event row
- native-client-telemetry adoption event rows must cover summary.adoption_sample_count
- native-client-telemetry adoption_by_skill must include at least one adoption event

#### Privacy Contract

- Telemetry must remain metadata-only and local-first.
- Do not package reports/telemetry_events.jsonl or any raw prompt, output, transcript, note, or message field.

## Boundary

- A valid submission packet is not accepted evidence by itself.
- Planned work, metadata fallback, pending human review, and local command-runner output still do not count.
- The world-class ledger remains the source of truth for `ready_to_claim_world_class`.
