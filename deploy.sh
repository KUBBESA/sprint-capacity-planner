#!/usr/bin/env bash
# Sprint Capacity Planner - deploy de produccion de una sola pasada.
#
# Uso (las credenciales van por argumentos o variables de entorno; nunca se guardan aqui):
#   ./deploy.sh
#   CLIENT_ID=abc CLIENT_SECRET=xyz HOSTED_ZONE_ID=Z0717533Z5OPZ4UCKHL0 ./deploy.sh
#
# Requisito previo: app OAuth 2.0 (3LO) creada en developer.atlassian.com (ver template.yaml).

set -euo pipefail

PROFILE="${PROFILE:-kubbesa}"
REGION="${REGION:-us-east-1}"
STACK="${STACK:-sprint-capacity-planner}"

CLIENT_ID="${CLIENT_ID:-${1:-}}"
CLIENT_SECRET="${CLIENT_SECRET:-${2:-}}"
HOSTED_ZONE_ID="${HOSTED_ZONE_ID:-${3:-Z0717533Z5OPZ4UCKHL0}}"

if [[ -z "$CLIENT_ID" || -z "$CLIENT_SECRET" ]]; then
  echo "ERROR: faltan CLIENT_ID/CLIENT_SECRET de la app OAuth de Atlassian." >&2
  echo "Uso: CLIENT_ID=... CLIENT_SECRET=... ./deploy.sh" >&2
  exit 1
fi

ACC="$(aws sts get-caller-identity --profile "$PROFILE" --query Account --output text)"
BUCKET="scp-static-${ACC}-${REGION}"
DOMAIN="sprint.crediviva.com.pa"

echo "==> sam build"
sam build --profile "$PROFILE"

echo "==> sam deploy (pila: $STACK)"
sam deploy \
  --stack-name "$STACK" \
  --region "$REGION" \
  --profile "$PROFILE" \
  --resolve-s3 \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    HostedZoneId="$HOSTED_ZONE_ID" \
    ClientId="$CLIENT_ID" \
    ClientSecret="$CLIENT_SECRET"

echo "==> Subir frontend"
aws s3 cp index.html "s3://${BUCKET}/" --profile "$PROFILE"

echo "==> Invalidar cache de CloudFront"
CF_DOMAIN="$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" --profile "$PROFILE" --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontDomain`].OutputValue' --output text)"
DIST_ID="$(aws cloudfront list-distributions --profile "$PROFILE" --query "DistributionList.Items[?DomainName==\`${CF_DOMAIN}\`].Id" --output text)"
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/index.html" "/" --profile "$PROFILE" >/dev/null

echo "==> Smoke test en https://${DOMAIN}"
HDR="https://${DOMAIN}"
CODE_ROOT="$(curl -s -o /dev/null -w '%{http_code}' "$HDR/")"
CODE_LOGIN="$(curl -s -o /dev/null -w '%{http_code}' -L --max-redirs 0 "$HDR/auth/login")"
CODE_ME="$(curl -s -o /dev/null -w '%{http_code}' "$HDR/auth/me")"
CODE_SESS="$(curl -s -o /dev/null -w '%{http_code}' "$HDR/api/planner/sessions")"
[[ "$CODE_ROOT" == "200" ]] || { echo "FALLO: raiz devolvio $CODE_ROOT"; exit 1; }
[[ "$CODE_LOGIN" == "302" ]] || { echo "FALLO: /auth/login devolvio $CODE_LOGIN (esperado 302 -> Atlassian)"; exit 1; }
[[ "$CODE_ME" == "401" ]] || { echo "FALLO: /auth/me devolvio $CODE_ME (esperado 401 sin cookie)"; exit 1; }
[[ "$CODE_SESS" == "401" ]] || { echo "FALLO: /api/planner/sessions devolvio $CODE_SESS (esperado 401)"; exit 1; }

echo ""
echo "OK - app desplegada: https://${DOMAIN}"
echo "Login Atlassian -> /auth/login  |  Probar en una pestana: importar Sprint + guardar."