FROM ghcr.io/hasura/ndc-duckduckapi:v0.7.0

COPY package-lock.json package.json /functions/

WORKDIR /functions
RUN --mount=type=cache,target=/root/.npm \
    npm ci

COPY ./ /functions
