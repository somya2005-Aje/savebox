#!/usr/bin/env python3
"""Deploy SaveBox to Cloudflare Pages with Wrangler.

Uses the stored custom.cloudflare credential (surrogate token via authd).
Creates the Pages project on first run, then deploys final-deploy/ (index.html at root).
Re-run after every export to publish updates. Live URL: https://savebox.pages.dev/
DO NOT run automatically — parent deploys on user order.
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, dynamic_credential_entry

PROJECT_DIR = os.path.expanduser("~/workspace/savebox")
PROJECT_NAME = "savebox"
ACCOUNT_ID = "617e5ccdaae4cb0e07706e4e3a012801"


def api(method, path, body=None):
    url = "https://api.cloudflare.com" + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    add_surrogate_to_request(req, "custom.cloudflare", allowed_hosts=["api.cloudflare.com"])
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return {"_http": e.code, "body": e.read().decode("utf-8", "replace")}


def ensure_project():
    res = api("GET", f"/client/v4/accounts/{ACCOUNT_ID}/pages/projects/{PROJECT_NAME}")
    if res.get("success"):
        print(f"Project {PROJECT_NAME} exists.")
        return True
    print(f"Project {PROJECT_NAME} missing, creating...")
    res = api("POST", f"/client/v4/accounts/{ACCOUNT_ID}/pages/projects",
              {"name": PROJECT_NAME, "production_branch": "main"})
    if res.get("success"):
        print(f"Project {PROJECT_NAME} created.")
        return True
    print("Create failed:", json.dumps(res)[:2000])
    return False


def main():
    entry = dynamic_credential_entry("custom.cloudflare")
    surrogate = str(entry["surrogate"]).strip()
    env = dict(os.environ)
    env["CLOUDFLARE_API_TOKEN"] = surrogate
    env["CLOUDFLARE_ACCOUNT_ID"] = ACCOUNT_ID
    if not ensure_project():
        return 1
    cmd = ["npx", "--yes", "wrangler@4.160.0", "pages", "deploy",
           "final-deploy", "--project-name", PROJECT_NAME, "--commit-dirty=true"]
    proc = subprocess.run(cmd, cwd=PROJECT_DIR, env=env)
    return proc.returncode


if __name__ == "__main__":
    raise SystemExit(main())
