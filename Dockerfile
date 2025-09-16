FROM node:20-alpine AS builder

WORKDIR /app/daycare-filter
COPY daycare-filter/ ./
RUN npm install
RUN npm install -g typescript \
  && tsc -p .

WORKDIR /app/daycare-middleware
COPY daycare-middleware/ ./
RUN npm install
RUN npm install -g typescript \
  && tsc -p .

FROM verdaccio/verdaccio:nightly-master
USER root

# Copy compiled plugins into Verdaccio plugins directory
COPY --from=builder /app/daycare-filter /verdaccio/plugins/verdaccio-plugin-daycare-filter
RUN chown -R $VERDACCIO_USER_UID:root /verdaccio/plugins/verdaccio-plugin-daycare-filter
COPY --from=builder /app/daycare-middleware /verdaccio/plugins/verdaccio-plugin-daycare-middleware
RUN chown -R $VERDACCIO_USER_UID:root /verdaccio/plugins/verdaccio-plugin-daycare-middleware


# Provide Verdaccio config that enables the filter plugin
COPY config.yaml /verdaccio/conf/config.yaml

# Ensure storage directory exists and is writable
RUN mkdir -p /verdaccio/storage \
  && chown -R $VERDACCIO_USER_UID:root /verdaccio/storage

USER $VERDACCIO_USER_UID
EXPOSE 4873
