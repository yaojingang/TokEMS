# Security Trust Report

- OK: `True`
- Scanned files: `26`
- Scripts: `0`
- Internal script modules: `0`
- Secret findings: `0`
- Network-capable scripts: `0`
- Network policy covered scripts: `0`
- Network policy missing scripts: `0`
- File-write scripts: `0`
- Permission approvals: `0 / 0`
- Permission approval gaps: `0`
- CLI help smoke checked: `0`
- CLI help smoke failures: `0`
- Interactive scripts: `0`
- Package hash scope: `source-contract-without-generated-reports`
- Package hash files: `26`
- Package SHA256: `b29c5a45d4aabb4fdfdf81e4d9f83905c817861ec2d9f0be79b75440b1b08b32`

## Failures

- None

## Warnings

- No dependency or lock file detected

## Dependency Evidence

- Files: `none`
- Pinned entries: `0`
- Unpinned entries: `0`

## Network Policy

- Policy file: `security/network_policy.json`
- Present: `True`
- Covered scripts: `0`
- Missing scripts: `none`
- Mismatches: `0`

## Permission Governance

- Policy file: `security/permission_policy.json`
- Present: `True`
- Required capabilities: `none`
- Approved capabilities: `none`
- Missing approvals: `none`
- Invalid approvals: `none`
- Expired approvals: `none`

## CLI Help Smoke

- Enabled: `True`
- Timeout seconds: `5.0`
- Checked scripts: `0`
- Passed scripts: `0`
- Failed scripts: `none`

## Script Surface

| Script | Interface | Declared | Argparse | Main Guard | Input | Network | File Write | Subprocess | Reason |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |


## Node.js connector inventory

- Scripts: `11`
- Network-capable: `1`
- File-write: `1`
- Subprocess: `1`
- Interactive browser handoff: `1`
- CLI help smoke: `pass`
- Network policy gaps: `none`

The upstream trust scanner currently inventories Python scripts. This repository-local augmentation applies the same report fields to the required Node.js connector and keeps the package at experimental status until independent production acceptance.
