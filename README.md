# npm-daycare

An npm registry proxy that doesn't include package versions released in the last 48h or packages with fewer than 5,000 downloads.

---

## Quickest quick start ⚡️

```bash
docker run --pull=always --rm --name npm-daycare -p 4873:4873 bgodil/npm-daycare

npm set registry http://localhost:4873/
pnpm config set registry http://localhost:4873/
yarn config set registry http://localhost:4873/
bun config set registry http://localhost:4873/

npm view @types/node  # has recent updates
npm view pgmock  # has <5,000 weekly downloads
```

That bootstraps the default policies immediately. Tweak `MIN_WEEKLY_DOWNLOADS` and `MIN_AGE_HOURS` if you need different X/Y thresholds.

---

## Why npm-daycare exists 🛡️

Public registries move fast and automated pipelines install new versions seconds after release. Attackers know this and repeatedly target JavaScript ecosystems. Some recent examples:

- [Tinycolor/Crowdstrike/Shai-Hulud attack](https://socket.dev/blog/tinycolor-supply-chain-attack-affects-40-packages)
- [chalk/simple-swizzle/Qix](https://socket.dev/blog/npm-author-qix-compromised-in-major-supply-chain-attack)
- [ua-parser-js](https://www.cisa.gov/news-events/alerts/2021/10/22/malware-discovered-popular-npm-package-ua-parser-js)
- [event-stream](https://es-incident.github.io/)
- [peacenotwar](https://en.wikipedia.org/wiki/Peacenotwar)
- ...and many more

`npm-daycare` is an answer to those incidents: It slows down risky packages, and lets you keep building while new releases bake in public.

## What npm-daycare does 🧩

- **Age gate** – `daycare-filter` rejects package versions younger than a configurable number of hours so your CI never installs a just-published release.
- **Download reputation** – `daycare-middleware` checks the npm download API and blocks packages falling below the weekly download floor you set.
- **Verdaccio-native** – both plugins slot into Verdaccio, so you get a familiar proxy cache, upstream auth, and local publishing workflow.
- **Zero-touch for developers** – once the registry URL changes, existing tooling (npm, pnpm, Yarn, Bun) works without extra configuration.

## Getting started 🚀

### 1. Run the proxy

```bash
docker run --pull=always --rm -p 4873:4873 \
  -e MIN_AGE_HOURS=48 \
  -e MIN_WEEKLY_DOWNLOADS=10000 \
  --name npm-proxy bgodil/npm-daycare
```

Environment variables

- `MIN_AGE_HOURS` (default `48`) – minimum publish age before a version becomes installable.
- `MIN_WEEKLY_DOWNLOADS` (default `10000`) – minimum downloads in the last seven days.

### 2. Point your tooling at npm-daycare

```
npm   : npm set registry http://localhost:4873/
pnpm  : pnpm config set registry http://localhost:4873/
yarn  : yarn config set registry http://localhost:4873/
bun   : bun config set registry http://localhost:4873/
```

To revert, reset each manager back to `https://registry.npmjs.org/`.

### 3. Verify the proxy

```bash
npm whoami --registry http://localhost:4873/ # should hit Verdaccio
npm view <package> --registry http://localhost:4873/ # confirms package visibility
```

## Caveats

npm-daycare should not be your only layer of defense. An npm package is a piece of software that you run on your computer, and you should treat it as such.

The tag handling logic is currently not very robust; if a tag's version is too new, the tag will not be returned, even if it previously had a version that was old enough. For the `latest` tag, there is a workaround which just returns the latest available version.

Private packages are currently not supported. There is currently no authentication, so don't host the proxy in a public place.

## Development 💻

This repository ships two Verdaccio plugins located in `daycare-filter` and `daycare-middleware`.

- `daycare-filter` inspects incoming metadata and strips versions that fail the age policy before Verdaccio serves them.
- `daycare-middleware` hooks the tarball fetch pipeline, queries download statistics, and rejects packages that lack adoption.

Install dependencies and run tests inside each plugin directory while contributing.

To build & run the proxy from source:

```bash
# Build the image
docker build -t npm-daycare ./

# Run with sane defaults (48h age minimum, 5k weekly downloads)
docker run --rm -p 4873:4873 --name npm-proxy npm-daycare
```
