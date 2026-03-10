#!/usr/bin/env bash
# Idempotent deployment script for azuki on AWS Lightsail with nginx + Cloudflare
# Usage: sudo ./setup.sh <domain>
# Example: sudo ./setup.sh azuki.example.com

set -euo pipefail

# ── Argument validation ──
if [[ $# -lt 1 ]]; then
    echo "Usage: sudo $0 <domain>"
    echo "Example: sudo $0 azuki.example.com"
    exit 1
fi

if [[ $EUID -ne 0 ]]; then
    echo "Error: this script must be run as root (use sudo)"
    exit 1
fi

DOMAIN="$1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "==> Deploying azuki for domain: ${DOMAIN}"

# ── Install nginx if not present ──
if ! command -v nginx &>/dev/null; then
    echo "==> Installing nginx..."
    apt-get update -qq
    apt-get install -y -qq nginx
else
    echo "==> nginx already installed"
fi

# ── Create directories ──
echo "==> Creating directories..."
mkdir -p /etc/nginx/ssl
chmod 700 /etc/nginx/ssl
mkdir -p /etc/nginx/snippets
mkdir -p /etc/nginx/conf.d

# ── Update Cloudflare IP list ──
echo "==> Fetching Cloudflare IP ranges..."
CF_REALIP_CONF="/etc/nginx/snippets/cloudflare-realip.conf"
FETCH_SUCCESS=true

CF_IPV4=$(curl -sf --max-time 10 https://www.cloudflare.com/ips-v4/) || FETCH_SUCCESS=false
CF_IPV6=$(curl -sf --max-time 10 https://www.cloudflare.com/ips-v6/) || FETCH_SUCCESS=false

if [[ "$FETCH_SUCCESS" == "true" && -n "$CF_IPV4" && -n "$CF_IPV6" ]]; then
    echo "==> Writing fresh Cloudflare IP list"
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
    } > "$CF_REALIP_CONF"
else
    echo "==> WARNING: Could not fetch Cloudflare IPs, using bundled fallback"
    cp "${SCRIPT_DIR}/nginx/snippets/cloudflare-realip.conf" "$CF_REALIP_CONF"
fi

# ── Check Origin Certificate ──
echo "==> Checking SSL certificates..."
if [[ ! -f /etc/nginx/ssl/origin.pem ]] || [[ ! -f /etc/nginx/ssl/origin-key.pem ]]; then
    echo ""
    echo "============================================================"
    echo "  ERROR: Cloudflare Origin Certificate not found!"
    echo ""
    echo "  Place your certificate files at:"
    echo "    /etc/nginx/ssl/origin.pem       (certificate, chmod 644)"
    echo "    /etc/nginx/ssl/origin-key.pem   (private key, chmod 600)"
    echo ""
    echo "  To generate:"
    echo "    1. Cloudflare Dashboard > SSL/TLS > Origin Server"
    echo "    2. Create Certificate (RSA, 15 years)"
    echo "    3. Copy certificate -> origin.pem"
    echo "    4. Copy private key  -> origin-key.pem"
    echo "============================================================"
    echo ""
    exit 1
fi
chmod 644 /etc/nginx/ssl/origin.pem
chmod 600 /etc/nginx/ssl/origin-key.pem
echo "==> SSL certificates found"

# ── Copy nginx config files ──
echo "==> Installing nginx configuration..."
cp "${SCRIPT_DIR}/nginx/nginx.conf" /etc/nginx/nginx.conf

cp "${SCRIPT_DIR}/nginx/conf.d/azuki.conf" /etc/nginx/conf.d/azuki.conf
# Replace domain placeholder
sed -i "s/AZUKI_DOMAIN/${DOMAIN}/g" /etc/nginx/conf.d/azuki.conf

# Remove Ubuntu default site if present (conf.d-only structure)
rm -f /etc/nginx/sites-enabled/default

# ── UFW firewall setup ──
echo "==> Configuring UFW firewall..."

# Ensure IPv6 is enabled
if grep -q "^IPV6=no" /etc/default/ufw 2>/dev/null; then
    sed -i 's/^IPV6=no/IPV6=yes/' /etc/default/ufw
    echo "==> Enabled IPv6 in UFW"
fi

# Allow SSH
ufw allow 22/tcp comment 'SSH' >/dev/null 2>&1 || true

# Remove any existing broad 80/443 rules before adding Cloudflare-only rules
ufw delete allow 80/tcp >/dev/null 2>&1 || true
ufw delete allow 443/tcp >/dev/null 2>&1 || true
ufw delete allow 'Nginx Full' >/dev/null 2>&1 || true
ufw delete allow 'Nginx HTTP' >/dev/null 2>&1 || true
ufw delete allow 'Nginx HTTPS' >/dev/null 2>&1 || true

# Build Cloudflare IP list for UFW (use fetched or fallback)
declare -a CF_IPS=()
if [[ "$FETCH_SUCCESS" == "true" && -n "$CF_IPV4" && -n "$CF_IPV6" ]]; then
    while IFS= read -r ip; do [[ -n "$ip" ]] && CF_IPS+=("$ip"); done <<< "$CF_IPV4"
    while IFS= read -r ip; do [[ -n "$ip" ]] && CF_IPS+=("$ip"); done <<< "$CF_IPV6"
else
    # Parse from bundled fallback file
    while IFS= read -r line; do
        ip=$(echo "$line" | grep -oP 'set_real_ip_from \K[^;]+' || true)
        [[ -n "$ip" ]] && CF_IPS+=("$ip")
    done < "${SCRIPT_DIR}/nginx/snippets/cloudflare-realip.conf"
fi

echo "==> Adding UFW rules for ${#CF_IPS[@]} Cloudflare IP ranges..."
for ip in "${CF_IPS[@]}"; do
    ufw allow from "$ip" to any port 80,443 proto tcp comment 'Cloudflare' >/dev/null 2>&1 || true
done

# Set default deny and enable
ufw default deny incoming >/dev/null 2>&1
ufw default allow outgoing >/dev/null 2>&1
ufw --force enable >/dev/null 2>&1
echo "==> UFW configured"

# ── Test nginx configuration ──
echo "==> Testing nginx configuration..."
if ! nginx -t 2>&1; then
    echo "ERROR: nginx configuration test failed!"
    exit 1
fi
echo "==> nginx configuration OK"

# ── Create data directories ──
# UID/GID must match the 'azuki' user in the Dockerfile (10001:10001)
echo "==> Creating data directories..."
mkdir -p /opt/azuki/data /opt/azuki/media
chown -R 10001:10001 /opt/azuki/data /opt/azuki/media

# ── Start Docker Compose ──
echo "==> Pulling latest image and starting Docker Compose..."
cd "$PROJECT_DIR"
export WEB_ORIGIN="https://${DOMAIN}"
docker compose pull
docker compose up -d

echo "==> Waiting for app to be ready on port 3000..."
for i in $(seq 1 30); do
    if curl -sf --max-time 2 http://127.0.0.1:3000/ >/dev/null 2>&1; then
        echo "==> App is ready"
        break
    fi
    if [[ $i -eq 30 ]]; then
        echo "WARNING: App did not respond on port 3000 within 60s"
        echo "  Check with: docker compose logs"
    fi
    sleep 2
done

# ── Start or reload nginx ──
if systemctl is-active --quiet nginx; then
    echo "==> Reloading nginx..."
    systemctl reload nginx
else
    echo "==> Starting nginx..."
    systemctl start nginx
fi
systemctl enable nginx >/dev/null 2>&1

# ── Install Cloudflare IP update cron job ──
echo "==> Installing daily Cloudflare IP update cron..."
cp "${SCRIPT_DIR}/nginx/update-cloudflare-ips.sh" /etc/cron.daily/update-cloudflare-ips
chmod 755 /etc/cron.daily/update-cloudflare-ips

# ── Extract setup token (if in setup mode) ──
SETUP_TOKEN=$(docker compose logs azuki 2>/dev/null | grep -oP 'SETUP TOKEN: \K\S+' | tail -1)

# ── Verification ──
echo ""
echo "============================================================"
echo "  Deployment complete!"
echo ""
echo "  Domain:  ${DOMAIN}"
echo "  nginx:   $(systemctl is-active nginx)"
echo "  Docker:  $(docker compose ps --format '{{.Status}}' 2>/dev/null | head -1)"
if [[ -n "$SETUP_TOKEN" ]]; then
    echo ""
    echo "  Setup token: ${SETUP_TOKEN}"
    echo "  Open https://${DOMAIN} and enter this token to complete setup"
fi
echo ""
echo "  Next steps:"
echo "    1. Ensure Cloudflare DNS A/AAAA record points to this server"
echo "    2. Set SSL/TLS mode to Full (Strict) in Cloudflare"
echo "    3. Enable Always Use HTTPS in Cloudflare"
echo "    4. Test: curl -I https://${DOMAIN}"
echo "============================================================"
