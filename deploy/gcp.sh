#!/usr/bin/env bash
# Deploy the Nukkad API to Google Cloud Run (Mumbai). Safe to re-run: it creates what's missing and redeploys.
#
#   PROJECT_ID=nukkad-prod MONGO_URI='mongodb+srv://...' ./deploy/gcp.sh
#
# Optional env: REGION (asia-south1), SERVICE (nukkad-api), WEB_ORIGIN (comma-separated frontend URLs),
#               OTP_DEV_MODE (true = login codes shown on screen; set false once SMS is set up).
set -euo pipefail
cd "$(dirname "$0")/.."
# private values (PROJECT_ID, MONGO_URI, ...) can live in deploy/.env.deploy, which git ignores
if [ -f deploy/.env.deploy ]; then set -a; . deploy/.env.deploy; set +a; fi

: "${PROJECT_ID:?Set PROJECT_ID (your GCP project ID)}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-nukkad-api}"
WEB_ORIGIN="${WEB_ORIGIN:-http://localhost:3200}"
OTP_DEV_MODE="${OTP_DEV_MODE:-true}"
BUCKET="${BUCKET:-${PROJECT_ID}-nukkad-uploads}"
RUN_SA="${SERVICE}@${PROJECT_ID}.iam.gserviceaccount.com"

step() { printf '\n\033[1;33m▶ %s\033[0m\n' "$*"; }

gcloud config set project "$PROJECT_ID" >/dev/null
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
BUILD_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

step "Enabling APIs (first run takes a minute)"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com cloudscheduler.googleapis.com storage.googleapis.com compute.googleapis.com

step "Service account the API runs as"
gcloud iam service-accounts describe "$RUN_SA" >/dev/null 2>&1 ||
  gcloud iam service-accounts create "$SERVICE" --display-name "Nukkad API (Cloud Run)"
# source deploys build with the default compute service account
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$BUILD_SA" --role roles/run.builder --condition None >/dev/null

step "Secrets"
secret() { # name value [update]
  if gcloud secrets describe "$1" >/dev/null 2>&1; then
    [ "${3:-}" = update ] && printf %s "$2" | gcloud secrets versions add "$1" --data-file=- >/dev/null
  else
    printf %s "$2" | gcloud secrets create "$1" --data-file=- --replication-policy automatic >/dev/null
  fi
  gcloud secrets add-iam-policy-binding "$1" --member "serviceAccount:$RUN_SA" --role roles/secretmanager.secretAccessor >/dev/null
}
if [ -n "${MONGO_URI:-}" ]; then secret nukkad-mongo-uri "$MONGO_URI" update
elif ! gcloud secrets describe nukkad-mongo-uri >/dev/null 2>&1; then echo "Set MONGO_URI on the first run"; exit 1; fi
secret nukkad-jwt-secret "$(openssl rand -hex 32)"
secret nukkad-jobs-secret "$(openssl rand -hex 24)"

step "Photo bucket gs://$BUCKET (public read)"
gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1 ||
  gcloud storage buckets create "gs://$BUCKET" --location "$REGION" --uniform-bucket-level-access
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member allUsers --role roles/storage.objectViewer >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member "serviceAccount:$RUN_SA" --role roles/storage.objectAdmin >/dev/null

step "Building and deploying $SERVICE to Cloud Run ($REGION)"
gcloud run deploy "$SERVICE" --source . --region "$REGION" --allow-unauthenticated \
  --service-account "$RUN_SA" \
  --set-env-vars "^@^NODE_ENV=production@GCS_BUCKET=$BUCKET@OTP_DEV_MODE=$OTP_DEV_MODE@WEB_ORIGIN=$WEB_ORIGIN" \
  --set-secrets "MONGO_URI=nukkad-mongo-uri:latest,JWT_SECRET=nukkad-jwt-secret:latest,JOBS_SECRET=nukkad-jobs-secret:latest" \
  --memory 512Mi --cpu 1 --min-instances 0 --max-instances 3 --concurrency 80 --timeout 60

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)')"

step "Scheduler: opening alerts every 5 minutes"
JOBS_SECRET="$(gcloud secrets versions access latest --secret nukkad-jobs-secret)"
JOB_ARGS=(--location "$REGION" --schedule "*/5 * * * *" --time-zone "Asia/Kolkata" --uri "$URL/internal/jobs" --http-method POST)
if gcloud scheduler jobs describe nukkad-jobs --location "$REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs update http nukkad-jobs "${JOB_ARGS[@]}" --update-headers "x-jobs-secret=$JOBS_SECRET" >/dev/null
else
  gcloud scheduler jobs create http nukkad-jobs "${JOB_ARGS[@]}" --headers "x-jobs-secret=$JOBS_SECRET" >/dev/null
fi

step "Health check"
curl -fsS "$URL/health" && echo
printf '\n\033[1;32m✓ API live at %s\033[0m\n' "$URL"
echo "Frontend: set NEXT_PUBLIC_API_URL=$URL, and re-run this with WEB_ORIGIN=<frontend URL> so the browser is allowed to call it."
