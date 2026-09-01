FROM node:24.12.0-trixie-slim@sha256:35876cf614d84f076fcd51792d2ebe8ef21663d785d52ef09c2e459b0b199efa AS node-runtime
FROM eclipse-temurin:21-jdk-noble@sha256:81cecb98bcca2d5d5c3d496e71779073865db0d0bd776ecf434e017f20dac638 AS builder

ARG SYSML_RELEASE_TAG=2026-04
ARG SYSML_KERNEL_VERSION=0.59.0

WORKDIR /app
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY apps/validator ./apps/validator
COPY packages/teacher-contract/official-validator-artifacts.json ./packages/teacher-contract/official-validator-artifacts.json
COPY packages/teacher-contract/official-validator-runtime-artifacts.json ./packages/teacher-contract/official-validator-runtime-artifacts.json

RUN set -eux; \
  installed=0; \
  for mirror in \
    "http://mirrors.tuna.tsinghua.edu.cn/ubuntu/" \
    "http://archive.ubuntu.com/ubuntu/"; do \
    if [ -f /etc/apt/sources.list.d/ubuntu.sources ]; then \
      sed -i "s|http://[^ ]*/ubuntu/|${mirror}|g" /etc/apt/sources.list.d/ubuntu.sources; \
    fi; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/partial/*; \
    if apt-get -o Acquire::Retries=5 update \
      && apt-get -o Acquire::Retries=5 install -y --no-install-recommends ca-certificates curl; then \
      installed=1; \
      break; \
    fi; \
  done; \
  test "$installed" = "1"; \
  mkdir -p /opt/sysml \
  && curl -L --fail --retry 5 --retry-all-errors --connect-timeout 30 \
    -o /tmp/jupyter-sysml-kernel.zip \
    "https://github.com/Systems-Modeling/SysML-v2-Pilot-Implementation/releases/download/${SYSML_RELEASE_TAG}/jupyter-sysml-kernel-${SYSML_KERNEL_VERSION}.zip" \
  && cd /opt/sysml \
  && jar xf /tmp/jupyter-sysml-kernel.zip \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /app/apps/validator/official/classes \
  && javac -cp "/opt/sysml/sysml/jupyter-sysml-kernel-${SYSML_KERNEL_VERSION}-all.jar" \
    -d /app/apps/validator/official/classes \
    /app/apps/validator/official/src/org/sysmlv2/learning/validator/*.java \
  && node /app/apps/validator/official/verify-artifact-manifest.js \
    --manifest /app/packages/teacher-contract/official-validator-runtime-artifacts.json \
    --archive /tmp/jupyter-sysml-kernel.zip \
    --jar "/opt/sysml/sysml/jupyter-sysml-kernel-${SYSML_KERNEL_VERSION}-all.jar" \
    --library /opt/sysml/sysml/sysml.library \
    --wrapper /app/apps/validator/official/classes \
  && rm /tmp/jupyter-sysml-kernel.zip

FROM eclipse-temurin:21-jre-noble@sha256:5ea5c6c4c4f75be58b4391e91b14f72f53c3e7e43a304d537ceecd3f5513260d

ARG SYSML_RELEASE_TAG=2026-04
ARG SYSML_KERNEL_VERSION=0.59.0

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=builder /app/apps/validator ./apps/validator
COPY --from=builder /app/packages/teacher-contract ./packages/teacher-contract
COPY --from=builder /opt/sysml /opt/sysml

RUN set -eux; \
  installed=0; \
  for mirror in \
    "http://mirrors.tuna.tsinghua.edu.cn/ubuntu/" \
    "http://archive.ubuntu.com/ubuntu/"; do \
    if [ -f /etc/apt/sources.list.d/ubuntu.sources ]; then \
      sed -i "s|http://[^ ]*/ubuntu/|${mirror}|g" /etc/apt/sources.list.d/ubuntu.sources; \
    fi; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/partial/*; \
    if apt-get -o Acquire::Retries=5 update \
      && apt-get -o Acquire::Retries=5 install -y --no-install-recommends --fix-missing \
        fontconfig \
        fonts-noto-cjk \
        graphviz; then \
      installed=1; \
      break; \
    fi; \
  done; \
  test "$installed" = "1"; \
  command -v dot; \
  fc-match 'Noto Sans CJK SC' | grep -q 'NotoSansCJK'; \
  rm -rf /var/lib/apt/lists/*

ENV SYSML_RELEASE_TAG=${SYSML_RELEASE_TAG}
ENV SYSML_KERNEL_VERSION=${SYSML_KERNEL_VERSION}
ENV SYSML_OFFICIAL_JAR=/opt/sysml/sysml/jupyter-sysml-kernel-${SYSML_KERNEL_VERSION}-all.jar
ENV SYSML_LIBRARY_PATH=/opt/sysml/sysml/sysml.library
ENV SYSML_WRAPPER_CLASSES=/app/apps/validator/official/classes
ENV OFFICIAL_VALIDATOR_ENABLED=true
ENV OFFICIAL_VALIDATOR_FALLBACK=false
ENV OFFICIAL_VALIDATOR_TIMEOUT_MS=25000
ENV OFFICIAL_PLANTUML_ENABLED=true
ENV OFFICIAL_PLANTUML_TIMEOUT_MS=120000
ENV GRAPHVIZ_DOT=/usr/bin/dot

EXPOSE 9090
CMD ["node", "apps/validator/server.js"]
