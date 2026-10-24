// src/scripts/init-storage.ts
//
// One-off helper to create the `raw-images` and `processed-cache` containers
// (plus the optional regional replica containers) before a deployment.
//
//   bun run storage:init
//
// Requires either Managed Identity (AZURE_STORAGE_ACCOUNT_NAME) or
// AZURE_STORAGE_CONNECTION_STRING for local development.

import {
  CACHE_CONTAINER_NAME,
  RAW_CONTAINER_NAME,
  REPLICA_STORAGE_ACCOUNT_NAME,
  STORAGE_ACCOUNT_NAME,
  initStorageContainers,
  isAzureStorageEnabled,
} from "../storage";

await initStorageContainers();

if (!isAzureStorageEnabled()) {
  console.error(
    "[storage:init] No Azure Storage account configured.\n" +
      "  Set AZURE_STORAGE_ACCOUNT_NAME (Managed Identity / DefaultAzureCredential)\n" +
      "  or AZURE_STORAGE_CONNECTION_STRING (local dev, e.g. Azurite)."
  );
  process.exit(1);
}

console.log(
  `[storage:init] Ready.\n` +
    `  primary account : ${STORAGE_ACCOUNT_NAME || "connection-string"}\n` +
    `  raw container    : ${RAW_CONTAINER_NAME}\n` +
    `  cache container  : ${CACHE_CONTAINER_NAME}\n` +
    `  replica account  : ${REPLICA_STORAGE_ACCOUNT_NAME || "none"}`
);
