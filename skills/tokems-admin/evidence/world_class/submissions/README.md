# World-Class Evidence Submission Kit

Generated at: `2026-08-17`

This kit contains editable drafts for human and external evidence packets. Drafts are not accepted evidence.

## Workflow

1. Run the real provider, human review, native permission, or native client telemetry work first.
2. Edit the matching JSON draft with only aggregate artifact references and provenance metadata.
3. Set `template_only` to `false` only after real evidence exists.
4. Set attestation booleans truthfully; do not include credentials, raw prompts, raw outputs, transcripts, notes, or private user content.
5. Validate the packet before asking the ledger reviewer to set `attestation.ledger_reviewer`, `attestation.ledger_reviewed_at`, and `attestation.ledger_reviewer_approved` truthfully.
6. Optional artifact prefill only inserts SHA-256 digests for current local aggregate artifacts; it does not mark a draft as real evidence.

## Commands

- validate intake: `python3 scripts/yao.py world-class-intake . --submissions-dir evidence/world_class/submissions --self`
- review submission: `python3 scripts/yao.py world-class-submission-review . --submissions-dir evidence/world_class/submissions --self`
- refresh ledger: `python3 scripts/yao.py world-class-ledger . --submissions-dir evidence/world_class/submissions --self`
- guard public claims: `python3 scripts/yao.py world-class-claim-guard . --self`

## Operator Handoff

Follow these steps in order when handing the kit from operator to reviewer. Handoff rows are procedural and never count as completion evidence.

| Step | Status | Command | Completion signal |
| --- | --- | --- | --- |
| `prepare-drafts` | `ready` | `python3 scripts/yao.py world-class-submission-kit . --output-dir evidence/world_class/submissions --self` | JSON drafts, submission_manifest.json, README.md, and index.html are present. |
| `collect-source` | `blocked` | `manual` | Source aggregate reports satisfy the required provider, human, native, or telemetry checks. |
| `edit-submission` | `manual` | `manual` | template_only is false only after real evidence exists; ledger_reviewer_approved, ledger_reviewer, and ledger_reviewed_at stay unset until reviewer approval. |
| `validate-intake` | `pending` | `python3 scripts/yao.py world-class-intake . --submissions-dir evidence/world_class/submissions --self` | world_class_evidence_intake reports valid submissions and no invalid packets before reviewer approval. |
| `review-submission` | `pending` | `python3 scripts/yao.py world-class-submission-review . --submissions-dir evidence/world_class/submissions --self` | world_class_submission_review shows ready-for-ledger-review before reviewer identity, timestamp, and approval are set. |
| `refresh-ledger` | `pending` | `python3 scripts/yao.py world-class-ledger . --submissions-dir evidence/world_class/submissions --self` | world_class_evidence_ledger accepts the evidence entry with valid source checks. |
| `guard-claim` | `pending` | `python3 scripts/yao.py world-class-claim-guard . --self` | world_class_claim_guard allows the public readiness claim. |

## Phase Queue

This queue groups repair rows by execution phase so operators can clear access, artifact, and source blockers in order. Queue rows are procedural guidance only.

| Phase | Status | Rows | Owners | Next action | Verify |
| --- | --- | ---: | --- | --- | --- |
| `attach-artifacts` | `blocked` | `26` | Browser/Chrome/IDE/provider client integrator, human reviewer, operator with provider credentials, target client or installer integrator | Add the supporting artifact if it is needed for reviewer audit. | `python3 scripts/yao.py world-class-submission-kit . --evidence-key human-adjudication --output-dir evidence/world_class/submissions --prefill-artifacts --self` |
| `collect-source` | `blocked` | `11` | Browser/Chrome/IDE/provider client integrator, human reviewer, operator with provider credentials, target client or installer integrator | Set reviewer_attestation only after choices are completed before opening the answer key. | `python3 scripts/yao.py evidence-finalize-review . --source-run <PROVIDER_RUN_ID> --decisions <A.json> --decisions <B.json> --decisions <C.json> --reviewer-registry <registry.json> --self && python3 scripts/yao.py world-class-preflight . --submissions-dir evidence/world_class/submissions --self` |

## Drafts

| Evidence | Draft | Status | Prefilled refs |
| --- | --- | --- | ---: |
| `provider-holdout` | `evidence/world_class/submissions/provider-holdout.json` | `written` | `0` |
| `human-adjudication` | `evidence/world_class/submissions/human-adjudication.json` | `written` | `0` |
| `native-permission-enforcement` | `evidence/world_class/submissions/native-permission-enforcement.json` | `written` | `0` |
| `native-client-telemetry` | `evidence/world_class/submissions/native-client-telemetry.json` | `written` | `0` |

## Evidence Matrix

This matrix combines draft, artifact, and source-check readiness into one operator action list. Matrix rows are guidance only; they do not count as completion evidence.

| Evidence | Stage | Draft | Submission refs | Supporting assets | Source checks | Next action |
| --- | --- | --- | ---: | ---: | ---: | --- |
| `provider-holdout` | `collect-source` | `written` | `0/1` | `1/8` | `0/3` | Run provider-backed output-exec with real credentials. |
| `human-adjudication` | `collect-source` | `written` | `0/2` | `1/8` | `5/10` | Record a reviewer choice and reason for every pair. |
| `native-permission-enforcement` | `collect-source` | `written` | `2/2` | `4/8` | `2/3` | Collect real target-client or external runtime guard proof. |
| `native-client-telemetry` | `collect-source` | `written` | `1/2` | `2/6` | `1/3` | Import at least one metadata-only event from a real client. |

## Repair Checklist

This checklist turns every draft, artifact, and source blocker into a concrete repair row. Repair rows are procedural guidance and do not count as completion evidence.

| Evidence | Type | Target | Status | Next action |
| --- | --- | --- | --- | --- |
| `human-adjudication` | `artifact` | `evidence/world_class/intake.schema.json` | `blocked` | Add the supporting artifact if it is needed for reviewer audit. |
| `human-adjudication` | `artifact` | `reports/provider_output_adjudication.json` | `blocked` | Create the required submission artifact or update artifact_refs to a concrete existing aggregate file. |
| `human-adjudication` | `artifact` | `reports/provider_output_blind_pack.json` | `blocked` | Add the supporting artifact if it is needed for reviewer audit. |
| `human-adjudication` | `artifact` | `reports/provider_review_lineage.json` | `blocked` | Add the supporting artifact if it is needed for reviewer audit. |
| `human-adjudication` | `artifact` | `reports/provider_reviewer_registry.json` | `blocked` | Create the required submission artifact or update artifact_refs to a concrete existing aggregate file. |
| `human-adjudication` | `artifact` | `reports/world_class_evidence_intake.json` | `blocked` | Add the supporting artifact if it is needed for reviewer audit. |
| `human-adjudication` | `artifact` | `reports/world_class_evidence_intake.md` | `blocked` | Add the supporting artifact if it is needed for reviewer audit. |
| `human-adjudication` | `artifact` | `scripts/adjudicate_multi_reviewer.py` | `blocked` | Add the supporting artifact if it is needed for reviewer audit. |
| `human-adjudication` | `artifact` | `scripts/finalize_provider_review.py` | `blocked` | Add the supporting artifact if it is needed for reviewer audit. |
| `native-client-telemetry` | `artifact` | `evidence/world_class/intake.schema.json` | `blocked` | Add the supporting artifact if it is needed for reviewer audit. |
| `native-client-telemetry` | `artifact` | `reports/telemetry_hook_recipes.json` | `blocked` | Create the required submission artifact or update artifact_refs to a concrete existing aggregate file. |
| `native-client-telemetry` | `artifact` | `reports/world_class_evidence_intake.json` | `blocked` | Add the supporting artifact if it is needed for reviewer audit. |
| `native-client-telemetry` | `artifact` | `reports/world_class_evidence_intake.md` | `blocked` | Add the supporting artifact if it is needed for reviewer audit. |
| `native-client-telemetry` | `artifact` | `scripts/telemetry_native_host.py` | `blocked` | Add the supporting artifact if it is needed for reviewer audit. |
| `native-permission-enforcement` | `artifact` | `dist/targets/*/adapter.json` | `blocked` | Replace the glob with concrete files, then reference the generated SHA-256 digests. |
| `native-permission-enforcement` | `artifact` | `evidence/world_class/intake.schema.json` | `blocked` | Add the supporting artifact if it is needed for reviewer audit. |
| `native-permission-enforcement` | `artifact` | `reports/world_class_evidence_intake.json` | `blocked` | Add the supporting artifact if it is needed for reviewer audit. |
| `native-permission-enforcement` | `artifact` | `reports/world_class_evidence_intake.md` | `blocked` | Add the supporting artifact if it is needed for reviewer audit. |
| `provider-holdout` | `artifact` | `evals/output/provider_matrix.json` | `blocked` | Add the supporting artifact if it is needed for reviewer audit. |
| `provider-holdout` | `artifact` | `evidence/world_class/intake.schema.json` | `blocked` | Add the supporting artifact if it is needed for reviewer audit. |
| `provider-holdout` | `artifact` | `reports/provider_output_answer_commitment.json` | `blocked` | Add the supporting artifact if it is needed for reviewer audit. |
| `provider-holdout` | `artifact` | `reports/provider_output_blind_pack.json` | `blocked` | Add the supporting artifact if it is needed for reviewer audit. |
| `provider-holdout` | `artifact` | `reports/provider_output_evaluation.json` | `blocked` | Create the required submission artifact or update artifact_refs to a concrete existing aggregate file. |
| `provider-holdout` | `artifact` | `reports/skill_os2_audit.json` | `blocked` | Add the supporting artifact if it is needed for reviewer audit. |
| `provider-holdout` | `artifact` | `reports/world_class_evidence_intake.json` | `blocked` | Add the supporting artifact if it is needed for reviewer audit. |
| `provider-holdout` | `artifact` | `reports/world_class_evidence_intake.md` | `blocked` | Add the supporting artifact if it is needed for reviewer audit. |
| `human-adjudication` | `source-check` | `blind_review_attested` | `blocked` | Set reviewer_attestation only after choices are completed before opening the answer key. |
| `human-adjudication` | `source-check` | `judgment_count` | `blocked` | Every pair needs one valid human judgment. |
| `human-adjudication` | `source-check` | `pending_count` | `blocked` | Record a reviewer choice and reason for every pair. |
| `human-adjudication` | `source-check` | `ready_for_human_evidence` | `blocked` | Complete all reviewer decisions with metadata and rationale, plus blind-review attestation and integrity fingerprints. |
| `human-adjudication` | `source-check` | `reviewer_metadata_present` | `blocked` | Record reviewer and reviewed_at before adjudication can count. |
| `native-client-telemetry` | `source-check` | `adoption_sample_count` | `blocked` | Telemetry must include adoption outcome evidence. |
| `native-client-telemetry` | `source-check` | `external_source_events` | `blocked` | Import at least one metadata-only event from a real client. |
| `native-permission-enforcement` | `source-check` | `native_enforcement_count` | `blocked` | Collect real target-client or external runtime guard proof. |
| `provider-holdout` | `source-check` | `model_executed_count` | `blocked` | Run provider-backed output-exec with real credentials. |
| `provider-holdout` | `source-check` | `timing_observed_count` | `blocked` | Provider execution should record timing metadata. |
| `provider-holdout` | `source-check` | `token_observed_count` | `blocked` | Provider execution should return non-estimated token usage. |

## Execution Runbook


### Provider Holdout

- Set DEEPSEEK_API_KEY in the operator shell; never commit or print the value.
- `python3 scripts/yao.py evidence-build . --run-id <PROVIDER_RUN_ID> --self`
- Keep the generated private answer key and role-neutral review materials inside .yao/runs/<PROVIDER_RUN_ID>.
- `python3 scripts/yao.py skill-os2-audit . --generated-at <YYYY-MM-DD> --self`
- Copy evidence/world_class/templates/provider-holdout.intake.json to evidence/world_class/submissions/provider-holdout.json and fill only real evidence fields.
- `python3 scripts/yao.py world-class-intake . --submissions-dir evidence/world_class/submissions --self`

### Human Adjudication

- Give each registered reviewer an independent copy of the matching provider_review_reviewer-*.json template and the role-neutral blind pack.
- Collect all 20 A/B choices, reasons, controlled submission ids, timestamps, and truthful independent-review attestations.
- Export an access-controlled reviewer registry that binds each reviewer id to the exact packet SHA256.
- `python3 scripts/yao.py evidence-finalize-review . --source-run <PROVIDER_RUN_ID> --decisions <reviewer-a.json> --decisions <reviewer-b.json> --decisions <reviewer-c.json> --reviewer-registry <registry.json> --run-id <FINAL_RUN_ID> --self`
- `python3 scripts/yao.py skill-os2-audit . --generated-at <YYYY-MM-DD> --self`
- Copy evidence/world_class/templates/human-adjudication.intake.json to evidence/world_class/submissions/human-adjudication.json and fill only real evidence fields.
- `python3 scripts/yao.py world-class-intake . --submissions-dir evidence/world_class/submissions --self`

### Native Permission Enforcement

- Implement or connect a real target client or external installer runtime guard that blocks undeclared network, file_write, or subprocess capabilities.
- Update the generated target adapter only when the guard is actually enforced by that target.
- `python3 scripts/yao.py package . --platform openai --platform claude --platform generic --platform vscode --output-dir dist --zip --self`
- `python3 scripts/yao.py install-simulate . --package-dir dist --install-root dist/install-simulation --self`
- `python3 scripts/yao.py runtime-permissions . --package-dir dist --self`
- `python3 scripts/yao.py skill-os2-audit . --generated-at <YYYY-MM-DD> --self`
- Copy evidence/world_class/templates/native-permission-enforcement.intake.json to evidence/world_class/submissions/native-permission-enforcement.json and fill only real evidence fields.
- `python3 scripts/yao.py world-class-intake . --submissions-dir evidence/world_class/submissions --self`

### Native Client Telemetry

- `python3 scripts/telemetry_native_host.py . --write-launcher /tmp/yao-telemetry-host.sh --write-manifest /tmp/yao-telemetry-host.json --allowed-origin chrome-extension://<extension-id>/`
- Install the generated native messaging manifest for the real client and send at least one accepted skill_activation or skill_output event.
- `python3 scripts/yao.py telemetry-import . --input-jsonl .yao/telemetry_spool/external_events.jsonl --self`
- `python3 scripts/yao.py skill-atlas --workspace-root . --self`
- `python3 scripts/yao.py skill-os2-audit . --generated-at <YYYY-MM-DD> --self`
- Copy evidence/world_class/templates/native-client-telemetry.intake.json to evidence/world_class/submissions/native-client-telemetry.json and fill only real evidence fields.
- `python3 scripts/yao.py world-class-intake . --submissions-dir evidence/world_class/submissions --self`

## Artifact Checklist

Use these paths and SHA-256 digests when filling `artifact_refs`. Glob patterns are expanded into concrete files; submissions must reference concrete paths, not globs.

| Evidence | Role | Path | Status | SHA-256 |
| --- | --- | --- | --- | --- |
| `provider-holdout` | `supporting-evidence` | `evals/output/provider_matrix.json` | `missing` | `n/a` |
| `provider-holdout` | `submission-ref` | `reports/provider_output_evaluation.json` | `missing` | `n/a` |
| `provider-holdout` | `supporting-evidence` | `reports/provider_output_blind_pack.json` | `missing` | `n/a` |
| `provider-holdout` | `supporting-evidence` | `reports/provider_output_answer_commitment.json` | `missing` | `n/a` |
| `provider-holdout` | `supporting-evidence` | `reports/skill_os2_audit.json` | `missing` | `n/a` |
| `provider-holdout` | `supporting-evidence` | `evidence/world_class/intake.schema.json` | `missing` | `n/a` |
| `provider-holdout` | `supporting-evidence` | `evidence/world_class/templates/provider-holdout.intake.json` | `ready` | `4cbd530f0cf131bb0f89c3c5607322d085a78279d97b796a213d607eb60e925f` |
| `provider-holdout` | `supporting-evidence` | `reports/world_class_evidence_intake.json` | `missing` | `n/a` |
| `provider-holdout` | `supporting-evidence` | `reports/world_class_evidence_intake.md` | `missing` | `n/a` |
| `human-adjudication` | `supporting-evidence` | `reports/provider_output_blind_pack.json` | `missing` | `n/a` |
| `human-adjudication` | `submission-ref` | `reports/provider_reviewer_registry.json` | `missing` | `n/a` |
| `human-adjudication` | `submission-ref` | `reports/provider_output_adjudication.json` | `missing` | `n/a` |
| `human-adjudication` | `supporting-evidence` | `reports/provider_review_lineage.json` | `missing` | `n/a` |
| `human-adjudication` | `supporting-evidence` | `scripts/adjudicate_multi_reviewer.py` | `missing` | `n/a` |
| `human-adjudication` | `supporting-evidence` | `scripts/finalize_provider_review.py` | `missing` | `n/a` |
| `human-adjudication` | `supporting-evidence` | `evidence/world_class/intake.schema.json` | `missing` | `n/a` |
| `human-adjudication` | `supporting-evidence` | `evidence/world_class/templates/human-adjudication.intake.json` | `ready` | `e4be62eaa71fba4b59f150fbec7f092abe68ca10a2da286e80fa14139c7dcd54` |
| `human-adjudication` | `supporting-evidence` | `reports/world_class_evidence_intake.json` | `missing` | `n/a` |
| `human-adjudication` | `supporting-evidence` | `reports/world_class_evidence_intake.md` | `missing` | `n/a` |
| `native-permission-enforcement` | `supporting-evidence` | `dist/targets/*/adapter.json` | `glob-no-match` | `n/a` |
| `native-permission-enforcement` | `submission-ref` | `reports/runtime_permission_probes.json` | `ready` | `6fdce750caffc3be7a49150cd26b105adc972bb9d7be8ffb9c8ccbe2dd469d80` |
| `native-permission-enforcement` | `supporting-evidence` | `reports/runtime_permission_probes.md` | `ready` | `c0b2cc323c9dc770b9ac1a022fe03c8f4540115a2b7cb71fbf0352938708bd7e` |
| `native-permission-enforcement` | `submission-ref` | `reports/install_simulation.json` | `ready` | `750b1003402652f5da1e4cf0cb5fe7622bad2b832d332a03ec2bae2cb20acce5` |
| `native-permission-enforcement` | `supporting-evidence` | `reports/install_simulation.md` | `ready` | `f0052f5c2c71102b3842b6fcd2bb380b0f58ce6987ca10db5f4a671abe445745` |
| `native-permission-enforcement` | `supporting-evidence` | `security/permission_policy.json` | `ready` | `be1a0bb06794f80b30f3a396a2d0549c59a7e118f5c2f9c369dbae35338c7692` |
| `native-permission-enforcement` | `supporting-evidence` | `evidence/world_class/intake.schema.json` | `missing` | `n/a` |
| `native-permission-enforcement` | `supporting-evidence` | `evidence/world_class/templates/native-permission-enforcement.intake.json` | `ready` | `5ec64105eede7161785c227ae98f3bd4632296b4a2609bce06b9ea1b0a5b74fb` |
| `native-permission-enforcement` | `supporting-evidence` | `reports/world_class_evidence_intake.json` | `missing` | `n/a` |
| `native-permission-enforcement` | `supporting-evidence` | `reports/world_class_evidence_intake.md` | `missing` | `n/a` |
| `native-client-telemetry` | `submission-ref` | `reports/adoption_drift_report.json` | `ready` | `8e8c47fce75ca671e1bdf399eae5ae46a28d353c0da978e28e4069bd7c48875e` |
| `native-client-telemetry` | `supporting-evidence` | `reports/adoption_drift_report.md` | `ready` | `85326515e54955601fd81c009174b5534c28e963b7e3a93da5ec050b7d3d1043` |
| `native-client-telemetry` | `submission-ref` | `reports/telemetry_hook_recipes.json` | `missing` | `n/a` |
| `native-client-telemetry` | `supporting-evidence` | `scripts/telemetry_native_host.py` | `missing` | `n/a` |
| `native-client-telemetry` | `supporting-evidence` | `evidence/world_class/intake.schema.json` | `missing` | `n/a` |
| `native-client-telemetry` | `supporting-evidence` | `evidence/world_class/templates/native-client-telemetry.intake.json` | `ready` | `4fcb9f1c596d45f2c6ad21b21ab29fdd856601d57c2ff922d5791f1aa6dabbe6` |
| `native-client-telemetry` | `supporting-evidence` | `reports/world_class_evidence_intake.json` | `missing` | `n/a` |
| `native-client-telemetry` | `supporting-evidence` | `reports/world_class_evidence_intake.md` | `missing` | `n/a` |

## Source Evidence Snapshot

These checks explain why a draft is not ready for ledger acceptance yet. They mirror current aggregate reports and do not accept evidence by themselves.

| Evidence | Check | Current | Expected | Status |
| --- | --- | --- | --- | --- |
| `provider-holdout` | Provider model run | `0` | `>0` | `blocked` |
| `provider-holdout` | Timing observed | `0` | `>0` | `blocked` |
| `provider-holdout` | Token usage observed | `0` | `>0` | `blocked` |
| `human-adjudication` | Review pairs exist | `7` | `>0` | `pass` |
| `human-adjudication` | No pending decisions | `7` | `==0` | `blocked` |
| `human-adjudication` | Judgments complete | `0` | `==pair_count` | `blocked` |
| `human-adjudication` | No invalid decisions | `0` | `==0` | `pass` |
| `human-adjudication` | Reviewer metadata | `False` | `true` | `blocked` |
| `human-adjudication` | Reason required | `True` | `true` | `pass` |
| `human-adjudication` | Blind review attested | `False` | `true` | `blocked` |
| `human-adjudication` | Raw content attested | `True` | `true` | `pass` |
| `human-adjudication` | Raw content blocked | `False` | `false` | `pass` |
| `human-adjudication` | Human evidence ready | `False` | `true` | `blocked` |
| `native-permission-enforcement` | Native enforcement | `0` | `>0` | `blocked` |
| `native-permission-enforcement` | Probe failures | `0` | `==0` | `pass` |
| `native-permission-enforcement` | Installer support | `True` | `true` | `pass` |
| `native-client-telemetry` | External events | `0` | `>0` | `blocked` |
| `native-client-telemetry` | Adoption sample | `0` | `>0` | `blocked` |
| `native-client-telemetry` | Raw content blocked | `False` | `false` | `pass` |

## Anti-Overclaim

- This kit never marks ledger evidence as accepted.
- Planned work, metadata fallback, pending review, and local command-runner output remain non-evidence.
- A valid intake packet means ready for ledger review, not world-class completion.
