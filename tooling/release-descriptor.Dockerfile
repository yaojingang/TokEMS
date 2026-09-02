# syntax=docker/dockerfile:1.7

FROM scratch

COPY --from=release source.bundle /release/source.bundle
COPY tooling/release-descriptor.py /release/release-descriptor.py

ARG BUILD_SHA
ARG BUILD_TIME
ARG BUILD_MIGRATION
ARG BUILD_MIGRATION_HASH
ARG RELEASE_PLATFORM
ARG SOURCE_BUNDLE_SHA256
ARG VERIFIER_SHA256
ARG API_IMAGE
ARG WORKER_IMAGE
ARG WEB_IMAGE
ARG ADMIN_IMAGE
ARG GATEWAY_IMAGE
ARG NOTIFICATION_SINK_IMAGE

LABEL org.opencontainers.image.source="https://github.com/yaojingang/TokEMS" \
      org.opencontainers.image.revision="${BUILD_SHA}" \
      org.opencontainers.image.created="${BUILD_TIME}" \
      com.tokems.release.schema="2" \
      com.tokems.release.platform="${RELEASE_PLATFORM}" \
      com.tokems.release.source-bundle.ref="refs/heads/tokems-release-source" \
      com.tokems.release.source-bundle.sha256="${SOURCE_BUNDLE_SHA256}" \
      com.tokems.release.verifier.sha256="${VERIFIER_SHA256}" \
      com.tokems.build.sha="${BUILD_SHA}" \
      com.tokems.build.time="${BUILD_TIME}" \
      com.tokems.build.migration="${BUILD_MIGRATION}" \
      com.tokems.build.migration-hash="${BUILD_MIGRATION_HASH}" \
      com.tokems.release.image.api="${API_IMAGE}" \
      com.tokems.release.image.worker="${WORKER_IMAGE}" \
      com.tokems.release.image.web="${WEB_IMAGE}" \
      com.tokems.release.image.admin="${ADMIN_IMAGE}" \
      com.tokems.release.image.gateway="${GATEWAY_IMAGE}" \
      com.tokems.release.image.notification-sink="${NOTIFICATION_SINK_IMAGE}"
