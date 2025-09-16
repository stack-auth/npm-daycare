FROM node:20-alpine AS builder
WORKDIR /app/quarantine-filter

COPY quarantine-filter/ ./
RUN npm install

# Compile TypeScript to dist using a known TypeScript version
RUN npm install -g typescript \
  && tsc -p .

FROM verdaccio/verdaccio:nightly-master
USER root

# Copy compiled plugin into Verdaccio plugins directory
COPY --from=builder /app/quarantine-filter /verdaccio/plugins/verdaccio-plugin-quarantine-filter
RUN chown -R $VERDACCIO_USER_UID:root /verdaccio/plugins/verdaccio-plugin-quarantine-filter

# Provide Verdaccio config that enables the filter plugin
COPY config.yaml /verdaccio/conf/config.yaml

# Ensure storage directory exists and is writable
RUN mkdir -p /verdaccio/storage \
  && chown -R $VERDACCIO_USER_UID:root /verdaccio/storage

USER $VERDACCIO_USER_UID
EXPOSE 4873
