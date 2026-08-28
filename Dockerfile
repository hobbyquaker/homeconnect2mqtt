FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
# --ignore-scripts: no native add-ons are needed
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY index.js config.js ./
COPY lib/ ./lib/

# config only via environment (HOMECONNECT2MQTT_*, see README), e.g.
#   -e HOMECONNECT2MQTT_CLIENT_ID=... -e HOMECONNECT2MQTT_MQTT_URL=mqtt://broker
# authorize once before the first run, into the same volume:
#   docker run --rm -it -v homeconnect2mqtt:/data -e HOMECONNECT2MQTT_CLIENT_ID=... \
#     ghcr.io/hobbyquaker/homeconnect2mqtt --login
ENV NODE_ENV=production \
    HOMECONNECT2MQTT_MQTT_URL=mqtt://localhost \
    HOMECONNECT2MQTT_NAME=homeconnect \
    HOMECONNECT2MQTT_STATE_DIR=/data \
    HOMECONNECT2MQTT_VERBOSITY=info

# tokens.json and the api budget counters live here — mount a volume, or --login again
# after every restart
RUN mkdir /data && chown node:node /data
VOLUME /data

USER node

ENTRYPOINT ["node", "index.js"]
