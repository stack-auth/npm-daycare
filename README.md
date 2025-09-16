## Setup

```bash
 docker build -t npm-daycare ./
 docker run --rm -p 4873:4873 --name npm-proxy npm-daycare
```

Or run with custom settings:

```bash
docker run --rm -p 4873:4873 \
  -e MIN_AGE_HOURS=72 \
  -e MIN_WEEKLY_DOWNLOADS=10000 \
  --name npm-proxy npm-daycare
```

Then run

```bash
npm set registry http://localhost:4873/
```

## Development

This project has two Verdaccio plugins, `daycare-filter` and `daycare-middleware`.

`daycare-filter` filters out package versions that are younger than a certain age.

`daycare-middleware` checks that a package has been installed at least a certain number of times in the last week before allowing it to be installed.
