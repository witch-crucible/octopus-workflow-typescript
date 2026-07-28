# Magento Security Watcher — Debian deploy notes

## 1. System packages

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip git
```

## 2. Install app

```bash
sudo mkdir -p /opt/magento-security-watcher
sudo chown "$USER":"$USER" /opt/magento-security-watcher
cd /opt/magento-security-watcher
# sync this repository here
python3 -m venv .venv
source .venv/bin/activate
pip install -e .

cp config/settings.yaml.example config/settings.yaml
cp config/projects.yaml.example config/projects.yaml
```

## 3. Git access

- Create a deploy key (read-only) on the scanner host.
- Add it to each Magento repo.
- Ensure `projects.yaml` uses SSH URLs the key can access.
- Disk: vendor-in-git mirrors are large; size for 6–20 repos.

## 4. Secrets

Prefer environment in crontab or a root-only env file:

```bash
export WECOM_WEBHOOK_URL='...'
export MSW_LLM_API_KEY='...'   # optional
export NVD_API_KEY='...'       # optional
```

Do not commit secrets into YAML.

## 5. First run

```bash
msw --root /opt/magento-security-watcher ingest
msw --root /opt/magento-security-watcher scan --notify
msw status
```

## 6. Cron

See `scripts/cron.example`.

## 7. Future HTTP API

Same services via `magento_security_watcher.api.create_fastapi_app` (optional FastAPI dependency).
