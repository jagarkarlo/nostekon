# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS studio
WORKDIR /src
COPY studio/package.json studio/package-lock.json ./studio/
RUN --mount=type=secret,id=npm_ca \
	if test -f /run/secrets/npm_ca; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
	npm ci --prefix studio
COPY studio/ ./studio/
COPY examples/runs/ ./examples/runs/
COPY examples/suites/postgresql-policy/ ./examples/suites/postgresql-policy/
COPY examples/validation-profiles/ ./examples/validation-profiles/
COPY site/src/content/docs/assets/nostekon-mark.svg ./site/src/content/docs/assets/nostekon-mark.svg
RUN npm run build --prefix studio

FROM golang:1.25-bookworm AS api
WORKDIR /src
COPY go.mod ./
COPY cmd/nostekon-api/ ./cmd/nostekon-api/
COPY internal/ ./internal/
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /nostekon-api ./cmd/nostekon-api

FROM gcr.io/distroless/static-debian12:nonroot
LABEL org.opencontainers.image.title="Nostekon"
LABEL org.opencontainers.image.source="https://github.com/jagarkarlo/nostekon"
COPY --from=api /nostekon-api /nostekon-api
COPY --from=studio /src/studio/dist /studio
ENV NOSTEKON_ADDR=:8080 NOSTEKON_STUDIO_DIR=/studio
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/nostekon-api"]