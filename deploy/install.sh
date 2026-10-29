#!/bin/sh
# iCloud Google Calendar Sync - one-time setup on the target host.
#
#   curl -fsSLO https://raw.githubusercontent.com/Dustin284/icloud-google-sync/main/deploy/install.sh
#   less install.sh            # read it first
#   sh install.sh [directory]  # default: ./icloud-google-sync
#
# Downloads docker-compose.yml, .env and the Caddyfile, creates the secrets (encryption key and
# login password are generated, the Google OAuth client is asked for) and starts the container
# from the prebuilt image. Running it again keeps existing secrets and settings.
set -eu

REPO="${ICGS_REPO:-Dustin284/icloud-google-sync}"
BRANCH="${ICGS_BRANCH:-main}"
RAW="https://raw.githubusercontent.com/${REPO}/${BRANCH}"
DIR="${1:-icloud-google-sync}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker is not installed (https://docs.docker.com/engine/install/)"
docker compose version >/dev/null 2>&1 || die "the docker compose plugin is missing"
command -v curl >/dev/null 2>&1 || die "curl is not installed"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 && SUDO="sudo"
fi

mkdir -p "$DIR/secrets" "$DIR/deploy"
cd "$DIR"

say "1/5  Downloading files from ${REPO}"
curl -fsSL "$RAW/docker-compose.yml" -o docker-compose.yml
curl -fsSL "$RAW/deploy/Caddyfile" -o deploy/Caddyfile
if [ ! -f .env ]; then
  curl -fsSL "$RAW/.env.example" -o .env
  NEW_ENV=1
else
  NEW_ENV=0
  echo ".env exists - kept"
fi

random_b64() {
  # $1 = number of random bytes; URL-safe base64 without newline
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 "$1" | tr -d '\n' | tr '+/' '-_'
  else
    head -c "$1" /dev/urandom | base64 | tr -d '\n' | tr '+/' '-_'
  fi
}

ask() {
  # $1 = prompt, $2 = default; reads from the terminal even when piped
  printf '%s' "$1" >/dev/tty
  [ -n "${2:-}" ] && printf ' [%s]' "$2" >/dev/tty
  printf ': ' >/dev/tty
  read -r answer </dev/tty || answer=""
  [ -z "$answer" ] && answer="${2:-}"
  printf '%s' "$answer"
}

ask_secret() {
  printf '%s: ' "$1" >/dev/tty
  stty -echo </dev/tty 2>/dev/null || true
  read -r answer </dev/tty || answer=""
  stty echo </dev/tty 2>/dev/null || true
  printf '\n' >/dev/tty
  printf '%s' "$answer"
}

set_env() {
  # replace KEY=... in .env (value must not contain '|')
  sed -i.bak "s|^$1=.*|$1=$2|" .env && rm -f .env.bak
}

say "2/5  Address"
if [ "$NEW_ENV" -eq 1 ]; then
  HOST=$(ask "Public host name, e.g. calsync.example.org (DNS must point here)" "")
  [ -n "$HOST" ] || die "a host name is required (Google needs an https address)"
  CADDY=$(ask "Start the bundled Caddy for automatic HTTPS? (y/n)" "y")
  set_env APP_BASE_URL "https://$HOST"
  set_env PUBLIC_HOSTNAME "$HOST"
  if [ "$CADDY" = "y" ] || [ "$CADDY" = "Y" ]; then
    set_env FORWARDED_ALLOW_IPS "172.16.0.0/12"
    echo "COMPOSE_PROFILES=caddy" >> .env
  fi
else
  HOST=$(sed -n 's|^APP_BASE_URL=https\{0,1\}://||p' .env)
fi

say "3/5  Secrets (stored in ./secrets, readable only by the container user)"
if [ ! -s secrets/app_encryption_key ]; then
  random_b64 32 > secrets/app_encryption_key
  echo "generated app_encryption_key - back it up together with the data volume"
fi
if [ ! -s secrets/admin_password ]; then
  random_b64 18 > secrets/admin_password
  echo "generated admin_password"
fi
if [ ! -s secrets/google_client_id ]; then
  echo "Google Cloud console -> APIs & Services -> Credentials -> OAuth client (Web application)"
  echo "Authorized redirect URI: https://${HOST}/api/google/oauth/callback"
  ask "Google OAuth client ID" "" > secrets/google_client_id
fi
if [ ! -s secrets/google_client_secret ]; then
  ask_secret "Google OAuth client secret (input hidden)" > secrets/google_client_secret
fi
for f in app_encryption_key admin_password google_client_id google_client_secret; do
  [ -s "secrets/$f" ] || die "secrets/$f is empty"
done
chmod 400 secrets/app_encryption_key secrets/admin_password secrets/google_client_id secrets/google_client_secret
$SUDO chown 10001:10001 secrets/app_encryption_key secrets/admin_password secrets/google_client_id secrets/google_client_secret \
  || echo "warning: could not chown the secrets to UID 10001 - the container may not be able to read them"

say "4/5  Pulling the image and starting"
docker compose pull
docker compose up -d

say "5/5  Waiting for the health check"
i=0
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q app)" 2>/dev/null)" = "healthy" ]; do
  i=$((i + 1))
  [ "$i" -gt 30 ] && die "container did not become healthy - see: docker compose logs app"
  sleep 2
done

say "Done."
echo "Open:      https://${HOST}"
echo "User:      $(sed -n 's/^ADMIN_USERNAME=//p' .env)"
echo "Password:  $SUDO cat $(pwd)/secrets/admin_password   (put it into your password manager)"
echo "Update:    cd $(pwd) && docker compose pull && docker compose up -d"
