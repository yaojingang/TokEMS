#!/usr/bin/env python3
"""Validate TokEMS immutable release descriptors and service image metadata."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any


EXPECTED_SOURCE = "https://github.com/yaojingang/TokEMS"
EXPECTED_PACKAGE = "ghcr.io/yaojingang/tokems-production"
SERVICES = ("api", "worker", "web", "admin", "gateway", "notification-sink")
SOURCE_BUNDLE_REF = "refs/heads/tokems-release-source"
SOURCE_CANDIDATE_REF = "refs/tokems-deploy/source-candidate"
EXPECTED_UPSTREAM_REF = "refs/remotes/origin/main"
SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")
DIGEST_REF_PATTERN = re.compile(
    rf"^{re.escape(EXPECTED_PACKAGE)}@sha256:([0-9a-f]{{64}})$"
)
MIGRATION_PATTERN = re.compile(r"^[0-9]{4}_[A-Za-z0-9_.-]+\.sql$")
MIGRATION_HASH_PATTERN = re.compile(r"^[0-9a-f]{64}$")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
TIME_PATTERN = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")
PLATFORMS = {"linux/amd64", "linux/arm64"}


class DescriptorError(ValueError):
    pass


def validate_time(value: str, description: str) -> None:
    if not TIME_PATTERN.fullmatch(value):
        raise DescriptorError(f"{description} must be a UTC second-resolution RFC3339 value")
    try:
        datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError as error:
        raise DescriptorError(f"{description} is not a valid calendar time") from error


def validate_build_values(
    target_sha: str, build_time: str, migration: str, migration_hash: str
) -> None:
    if not SHA_PATTERN.fullmatch(target_sha):
        raise DescriptorError("target SHA must be a lowercase 40-character Git SHA")
    validate_time(build_time, "build time")
    if not MIGRATION_PATTERN.fullmatch(migration):
        raise DescriptorError("build migration has an invalid file name")
    if not MIGRATION_HASH_PATTERN.fullmatch(migration_hash):
        raise DescriptorError("build migration hash must be a lowercase SHA-256")


def load_object(path: str, description: str) -> dict[str, Any]:
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise DescriptorError(f"unable to read {description}: {error}") from error
    if not isinstance(value, dict):
        raise DescriptorError(f"{description} must be a JSON object")
    return value


def require_text(mapping: dict[str, Any], key: str, description: str) -> str:
    value = mapping.get(key)
    if not isinstance(value, str) or not value:
        raise DescriptorError(f"missing required {description}: {key}")
    if "\n" in value or "\r" in value or "\t" in value:
        raise DescriptorError(f"invalid control character in {description}: {key}")
    return value


def expect_equal(actual: str, expected: str, description: str) -> None:
    if actual != expected:
        raise DescriptorError(f"{description} mismatch: expected {expected}, received {actual}")


def validate_build_identity(
    labels: dict[str, Any], target_sha: str
) -> tuple[str, str, str, str]:
    build_sha = require_text(labels, "com.tokems.build.sha", "build label")
    build_time = require_text(labels, "com.tokems.build.time", "build label")
    migration = require_text(labels, "com.tokems.build.migration", "build label")
    migration_hash = require_text(
        labels, "com.tokems.build.migration-hash", "build label"
    )
    expect_equal(build_sha, target_sha, "build SHA")
    validate_build_values(target_sha, build_time, migration, migration_hash)
    return build_sha, build_time, migration, migration_hash


def validate_common_labels(labels: dict[str, Any], target_sha: str) -> str:
    expect_equal(
        require_text(labels, "org.opencontainers.image.source", "OCI label"),
        EXPECTED_SOURCE,
        "OCI source",
    )
    expect_equal(
        require_text(labels, "org.opencontainers.image.revision", "OCI label"),
        target_sha,
        "OCI revision",
    )
    created = require_text(labels, "org.opencontainers.image.created", "OCI label")
    validate_time(created, "OCI created label")
    return created


def verify_descriptor(args: argparse.Namespace) -> None:
    if not SHA_PATTERN.fullmatch(args.target_sha):
        raise DescriptorError("target SHA must be a lowercase 40-character Git SHA")
    if args.platform not in PLATFORMS:
        raise DescriptorError("platform must be linux/amd64 or linux/arm64")

    labels = load_object(args.labels_file, "descriptor labels")
    created = validate_common_labels(labels, args.target_sha)
    expect_equal(
        require_text(labels, "com.tokems.release.schema", "descriptor label"),
        "2",
        "descriptor schema",
    )
    expect_equal(
        require_text(labels, "com.tokems.release.platform", "descriptor label"),
        args.platform,
        "descriptor platform",
    )
    build_sha, build_time, migration, migration_hash = validate_build_identity(
        labels, args.target_sha
    )
    expect_equal(created, build_time, "OCI created/build time")

    source_bundle_ref = require_text(
        labels, "com.tokems.release.source-bundle.ref", "source bundle label"
    )
    expect_equal(source_bundle_ref, SOURCE_BUNDLE_REF, "source bundle ref")
    source_bundle_hash = require_text(
        labels, "com.tokems.release.source-bundle.sha256", "source bundle label"
    )
    if not SHA256_PATTERN.fullmatch(source_bundle_hash):
        raise DescriptorError("source bundle hash must be a lowercase SHA-256")
    verifier_hash = require_text(
        labels, "com.tokems.release.verifier.sha256", "release verifier label"
    )
    if not SHA256_PATTERN.fullmatch(verifier_hash):
        raise DescriptorError("release verifier hash must be a lowercase SHA-256")

    release_image_keys = {
        key for key in labels if key.startswith("com.tokems.release.image.")
    }
    expected_image_keys = {
        f"com.tokems.release.image.{service}" for service in SERVICES
    }
    if release_image_keys != expected_image_keys:
        raise DescriptorError("descriptor must contain exactly the six supported service images")

    image_refs: dict[str, str] = {}
    digests: set[str] = set()
    for service in SERVICES:
        key = f"com.tokems.release.image.{service}"
        image_ref = require_text(labels, key, "descriptor label")
        match = DIGEST_REF_PATTERN.fullmatch(image_ref)
        if not match:
            raise DescriptorError(
                f"descriptor image {service} must use the private TokEMS package and a SHA-256 digest"
            )
        digest = match.group(1)
        if digest in digests:
            raise DescriptorError("every service image must have a unique digest")
        digests.add(digest)
        image_refs[service] = image_ref

    records = [
        ("build", "sha", build_sha),
        ("build", "time", build_time),
        ("build", "migration", migration),
        ("build", "migration-hash", migration_hash),
        ("release", "platform", args.platform),
        ("release", "source-bundle-ref", source_bundle_ref),
        ("release", "source-bundle-sha256", source_bundle_hash),
        ("release", "verifier-sha256", verifier_hash),
    ]
    records.extend(("image", service, image_refs[service]) for service in SERVICES)
    payload = "".join("\t".join(record) + "\n" for record in records)
    if args.records_output:
        Path(args.records_output).write_text(payload, encoding="utf-8")
    else:
        sys.stdout.write(payload)


def verify_source_bundle(args: argparse.Namespace) -> None:
    if not SHA_PATTERN.fullmatch(args.target_sha):
        raise DescriptorError("target SHA must be a lowercase 40-character Git SHA")
    bundle = Path(args.bundle_file)
    if not bundle.is_file() or bundle.is_symlink():
        raise DescriptorError("source bundle must be a regular non-symbolic file")

    with tempfile.TemporaryDirectory(prefix="tokems-bundle-verify-") as directory:
        environment = {
            "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "HOME": directory,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_NO_REPLACE_OBJECTS": "1",
            "GIT_TERMINAL_PROMPT": "0",
        }

        def run_git(*command: str) -> subprocess.CompletedProcess[str]:
            try:
                return subprocess.run(
                    ["git", *command],
                    cwd=directory,
                    env=environment,
                    check=True,
                    capture_output=True,
                    text=True,
                    timeout=120,
                )
            except (OSError, subprocess.SubprocessError) as error:
                detail = getattr(error, "stderr", "") or ""
                detail = detail.strip()
                suffix = f": {detail}" if detail else ""
                raise DescriptorError(f"source bundle Git validation failed{suffix}") from error

        run_git("init", "--bare", "--quiet", ".")
        run_git("bundle", "verify", str(bundle))
        heads = run_git("bundle", "list-heads", str(bundle), SOURCE_BUNDLE_REF).stdout
        records = [line.split() for line in heads.splitlines() if line.strip()]
        if records != [[args.target_sha, SOURCE_BUNDLE_REF]]:
            raise DescriptorError("source bundle target ref does not equal the requested SHA")
        candidate_ref = "refs/tokems-verify/source"
        run_git(
            "fetch",
            "--quiet",
            "--no-tags",
            "--no-write-fetch-head",
            str(bundle),
            f"{SOURCE_BUNDLE_REF}:{candidate_ref}",
        )
        imported_sha = run_git("rev-parse", candidate_ref).stdout.strip()
        if imported_sha != args.target_sha:
            raise DescriptorError("source bundle imported a different target SHA")
        object_type = run_git("cat-file", "-t", args.target_sha).stdout.strip()
        if object_type != "commit":
            raise DescriptorError("source bundle target is not a Git commit")


def import_source_bundle(args: argparse.Namespace) -> None:
    if not 1 <= args.timeout_seconds <= 600:
        raise DescriptorError("bundle import timeout must be between 1 and 600 seconds")
    verify_source_bundle(args)
    repository = Path(args.repository).resolve()
    if not repository.is_dir() or not (repository / ".git").is_dir():
        raise DescriptorError("production source repository is not a Git checkout")
    bundle = Path(args.bundle_file).resolve()
    environment = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": str(repository),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_NO_REPLACE_OBJECTS": "1",
        "GIT_TERMINAL_PROMPT": "0",
    }

    def run_git(*command: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        try:
            return subprocess.run(
                ["git", *command],
                cwd=repository,
                env=environment,
                check=check,
                capture_output=True,
                text=True,
                timeout=args.timeout_seconds,
            )
        except (OSError, subprocess.SubprocessError) as error:
            detail = getattr(error, "stderr", "") or ""
            detail = detail.strip()
            suffix = f": {detail}" if detail else ""
            raise DescriptorError(f"source bundle import failed{suffix}") from error

    if run_git("status", "--porcelain", "--untracked-files=all").stdout:
        raise DescriptorError("production source worktree changed before bundle import")
    if run_git("for-each-ref", "--format=%(refname)", "refs/replace").stdout:
        raise DescriptorError("Git replacement references are forbidden during bundle import")

    current_origin_sha = run_git("rev-parse", EXPECTED_UPSTREAM_REF).stdout.strip()
    current_head_sha = run_git("rev-parse", "HEAD").stdout.strip()
    existing_candidate = run_git(
        "show-ref", "--verify", "--quiet", SOURCE_CANDIDATE_REF, check=False
    )
    if existing_candidate.returncode == 0:
        raise DescriptorError("reserved source candidate ref already exists")
    if existing_candidate.returncode != 1:
        raise DescriptorError("unable to establish reserved source candidate ref state")
    try:
        run_git(
            "fetch",
            "--quiet",
            "--no-tags",
            "--no-write-fetch-head",
            str(bundle),
            f"{SOURCE_BUNDLE_REF}:{SOURCE_CANDIDATE_REF}",
        )
        candidate_sha = run_git("rev-parse", SOURCE_CANDIDATE_REF).stdout.strip()
        if candidate_sha != args.target_sha:
            raise DescriptorError("imported source candidate differs from the requested SHA")
        for description, ancestor in (
            ("current origin/main", current_origin_sha),
            ("production HEAD", current_head_sha),
        ):
            ancestry = run_git(
                "merge-base", "--is-ancestor", ancestor, args.target_sha, check=False
            )
            if ancestry.returncode == 1:
                raise DescriptorError(
                    f"{description} cannot fast-forward to the verified source bundle"
                )
            if ancestry.returncode != 0:
                raise DescriptorError(f"unable to verify {description} ancestry")
        run_git(
            "update-ref",
            EXPECTED_UPSTREAM_REF,
            args.target_sha,
            current_origin_sha,
        )
    finally:
        run_git("update-ref", "-d", SOURCE_CANDIDATE_REF, check=False)
    print(f"Imported verified source bundle: {current_origin_sha} -> {args.target_sha}")


def image_labels(metadata: dict[str, Any]) -> dict[str, Any]:
    config = metadata.get("config")
    if not isinstance(config, dict):
        config = metadata.get("Config")
    if not isinstance(config, dict):
        raise DescriptorError("service image metadata is missing its config object")
    labels = config.get("Labels")
    if labels is None:
        labels = config.get("labels")
    if not isinstance(labels, dict):
        raise DescriptorError("service image metadata is missing labels")
    return labels


def verify_service(args: argparse.Namespace) -> None:
    validate_build_values(
        args.target_sha, args.build_time, args.migration, args.migration_hash
    )
    if args.service not in SERVICES:
        raise DescriptorError("service is not part of the TokEMS release set")
    if args.platform not in PLATFORMS:
        raise DescriptorError("platform must be linux/amd64 or linux/arm64")
    expected_os, expected_architecture = args.platform.split("/", 1)
    metadata = load_object(args.metadata_file, "service image metadata")
    expect_equal(str(metadata.get("os", metadata.get("Os", ""))), expected_os, "image OS")
    expect_equal(
        str(metadata.get("architecture", metadata.get("Architecture", ""))),
        expected_architecture,
        "image architecture",
    )
    labels = image_labels(metadata)
    created = validate_common_labels(labels, args.target_sha)
    expect_equal(created, args.build_time, "OCI created/build time")
    expect_equal(
        require_text(labels, "com.tokems.service", "service image label"),
        args.service,
        "service image service",
    )
    expected = {
        "com.tokems.build.sha": args.target_sha,
        "com.tokems.build.time": args.build_time,
        "com.tokems.build.migration": args.migration,
        "com.tokems.build.migration-hash": args.migration_hash,
    }
    for key, value in expected.items():
        expect_equal(require_text(labels, key, "service image label"), value, key)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    descriptor = subparsers.add_parser("verify-descriptor")
    descriptor.add_argument("--labels-file", required=True)
    descriptor.add_argument("--target-sha", required=True)
    descriptor.add_argument("--platform", required=True)
    descriptor.add_argument("--records-output")
    descriptor.set_defaults(handler=verify_descriptor)

    service = subparsers.add_parser("verify-service")
    service.add_argument("--metadata-file", required=True)
    service.add_argument("--service", required=True)
    service.add_argument("--target-sha", required=True)
    service.add_argument("--build-time", required=True)
    service.add_argument("--migration", required=True)
    service.add_argument("--migration-hash", required=True)
    service.add_argument("--platform", required=True)
    service.set_defaults(handler=verify_service)

    bundle = subparsers.add_parser("verify-source-bundle")
    bundle.add_argument("--bundle-file", required=True)
    bundle.add_argument("--target-sha", required=True)
    bundle.set_defaults(handler=verify_source_bundle)

    importer = subparsers.add_parser("import-source-bundle")
    importer.add_argument("--bundle-file", required=True)
    importer.add_argument("--repository", required=True)
    importer.add_argument("--target-sha", required=True)
    importer.add_argument("--timeout-seconds", type=int, default=180)
    importer.set_defaults(handler=import_source_bundle)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        args.handler(args)
    except DescriptorError as error:
        print(f"release descriptor validation failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
