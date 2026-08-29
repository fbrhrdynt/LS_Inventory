# GitHub Workflow

Repository:

```text
https://github.com/fbrhrdynt/LS_Inventory
```

## Files that should be committed

Examples:

```text
app.js
package.json
package-lock.json
views/
public/
scripts/
services/
central/
docs/
README.md
```

## Files that must not be committed

Add these to `.gitignore`:

```gitignore
.env

data/
central/data/

cache/*.json

*.db
*.db-wal
*.db-shm
*.sqlite
*.sqlite3

config/google-token.json
config/oauth-client.json

node_modules/

backups/
*.tar.gz
*.zip

*.log
```

If you want to keep empty directories in Git:

```bash
touch data/.gitkeep
touch central/data/.gitkeep
```

Then add exceptions:

```gitignore
!data/.gitkeep
!central/data/.gitkeep
```

## Push changes

On Raspberry Pi 1:

```bash
cd /opt/LS_Inventory

git status

git add \
    app.js \
    package.json \
    package-lock.json \
    views \
    public \
    scripts \
    services \
    central \
    docs \
    README.md \
    .gitignore

git status
```

Make sure `.env` and `.db` files are not staged.

Commit:

```bash
git commit -m "LS Inventory V2 central server and multi-cabinet architecture"
```

Push:

```bash
git push origin main
```

If the repository uses `master`, use:

```bash
git push origin master
```

## Before every push

Run:

```bash
git status --short
```

Never push secrets.

Useful safety check:

```bash
git diff --cached --name-only
```

If you see:

```text
.env
central/data/central.db
data/device.db
google-token.json
```

unstage them immediately:

```bash
git restore --staged <file>
```

## Updating a cabinet from GitHub

On Pi 2:

```bash
cd /opt/LS_Inventory

git pull

npm install

pm2 restart LS_Inventory --update-env
```

Do not overwrite the local `.env` or local `device.db`.
