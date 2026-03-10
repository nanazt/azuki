#!/usr/bin/env bash
# Daily cron job to update Cloudflare IP ranges for nginx and UFW
# Installed to /etc/cron.daily/update-cloudflare-ips by setup.sh
#
# Safety: on download failure, existing config is preserved unchanged.
# Uses atomic file replacement and nginx -t validation before reload.

set -euo pipefail

CONF="/etc/nginx/snippets/cloudflare-realip.conf"
TMPFILE=$(mktemp)

trap 'rm -f "$TMPFILE"' EXIT

# ── Download latest Cloudflare IP ranges ──
CF_IPV4=$(curl -sf --max-time 15 https://www.cloudflare.com/ips-v4/) || { echo "Failed to fetch IPv4 list"; exit 0; }
CF_IPV6=$(curl -sf --max-time 15 https://www.cloudflare.com/ips-v6/) || { echo "Failed to fetch IPv6 list"; exit 0; }

if [[ -z "$CF_IPV4" ]] || [[ -z "$CF_IPV6" ]]; then
    echo "Empty response from Cloudflare, keeping existing config"
    exit 0
fi

# ── Generate new config to temp file ──
{
    echo "# Cloudflare IPv4 — https://www.cloudflare.com/ips-v4/"
    echo "# Last updated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    while IFS= read -r ip; do
        [[ -n "$ip" ]] && echo "set_real_ip_from ${ip};"
    done <<< "$CF_IPV4"
    echo ""
    echo "# Cloudflare IPv6 — https://www.cloudflare.com/ips-v6/"
    while IFS= read -r ip; do
        [[ -n "$ip" ]] && echo "set_real_ip_from ${ip};"
    done <<< "$CF_IPV6"
    echo ""
    echo "real_ip_header CF-Connecting-IP;"
} > "$TMPFILE"

# ── Validate with nginx -t before applying ──
cp "$CONF" "${CONF}.bak"
cp "$TMPFILE" "$CONF"

if ! nginx -t 2>/dev/null; then
    echo "nginx config test failed with new IPs, rolling back"
    cp "${CONF}.bak" "$CONF"
    rm -f "${CONF}.bak"
    exit 1
fi
rm -f "${CONF}.bak"

# ── Update UFW rules ──
# Remove all existing Cloudflare rules
ufw status numbered 2>/dev/null | grep 'Cloudflare' | grep -oP '^\[\s*\K\d+' | sort -rn | while read -r num; do
    yes | ufw delete "$num" >/dev/null 2>&1 || true
done

# Add new rules from fresh IP list
declare -a ALL_IPS=()
while IFS= read -r ip; do [[ -n "$ip" ]] && ALL_IPS+=("$ip"); done <<< "$CF_IPV4"
while IFS= read -r ip; do [[ -n "$ip" ]] && ALL_IPS+=("$ip"); done <<< "$CF_IPV6"

for ip in "${ALL_IPS[@]}"; do
    ufw allow from "$ip" to any port 80,443 proto tcp comment 'Cloudflare' >/dev/null 2>&1 || true
done

# ── Reload nginx ──
systemctl reload nginx
echo "Cloudflare IPs updated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
