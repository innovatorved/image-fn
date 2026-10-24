// src/storage.ts
//
// Azure Blob Storage integration for image-fn.
//
// Design goals
//  - Stateless compute: any region can serve any request because image bytes
//    (raw originals + transformed variants) live in Azure Blob Storage.
//  - Passwordless auth in production: Azure VM System-Assigned Managed Identity
//    via DefaultAzureCredential (no keys shipped in the image).
//  - Local development: fall back to AZURE_STORAGE_CONNECTION_STRING (Azurite
//    or a real account) when no managed identity is available.
//  - RA-GRS read failover: reads retry automatically against
//    `<account>-secondary.blob.core.windows.net` when the primary region
//    (eastus) is unavailable.
//  - Optional region-local read replica: European compute nodes can read from a
//    locally Object-Replicated storage account first, then fall back to primary.

import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";

export const STORAGE_ACCOUNT_NAME = process.env.AZURE_STORAGE_ACCOUNT_NAME || "";
export const REPLICA_STORAGE_ACCOUNT_NAME = process.env.AZURE_REPLICA_STORAGE_ACCOUNT_NAME || "";
export const CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING || "";
export const RAW_CONTAINER_NAME = process.env.AZURE_RAW_CONTAINER || "raw-images";
export const CACHE_CONTAINER_NAME = process.env.AZURE_CACHE_CONTAINER || "processed-cache";

const RETRY_OPTIONS = {
  maxTries: 3,
  tryTimeoutInMs: 5000,
  retryDelayInMs: 800,
} as const;

// Container bootstrap must never gate the load-balancer health probe for long:
// if Azure Storage is momentarily unreachable, we boot anyway and let the first
// request retry lazily.
const INIT_TIMEOUT_MS = Number(process.env.AZURE_STORAGE_INIT_TIMEOUT_MS) > 0
  ? Number(process.env.AZURE_STORAGE_INIT_TIMEOUT_MS)
  : 7500;

const isStorageConfigured = Boolean(STORAGE_ACCOUNT_NAME || CONNECTION_STRING);
let connectionStringBlobClient: BlobServiceClient | null = null;
let storageReady = false;

function buildBlobClient(accountName: string, enableSecondaryFailover = true): BlobServiceClient | null {
  // Local development / Azurite path: the connection string already encodes the
  // account, endpoint and shared key, so managed identity is not used.
  if (CONNECTION_STRING) {
    connectionStringBlobClient ??= BlobServiceClient.fromConnectionString(CONNECTION_STRING);
    return connectionStringBlobClient;
  }
  if (!accountName) {
    return null;
  }

  const primaryUrl = `https://${accountName}.blob.core.windows.net`;
  const credential = new DefaultAzureCredential();

  return new BlobServiceClient(primaryUrl, credential, {
    retryOptions: {
      ...RETRY_OPTIONS,
      // Automatic RA-GRS read failover when the primary storage region is down.
      // Reads are retried against this host; writes always target the primary.
      secondaryHost: enableSecondaryFailover
        ? `${accountName}-secondary.blob.core.windows.net`
        : undefined,
    },
  });
}

// Primary client (East US RA-GRS storage account - used for all writes and primary reads)
export const primaryBlobClient = buildBlobClient(STORAGE_ACCOUNT_NAME, true);

// Optional regional replica client (e.g., North Europe Object-Replicated storage
// account for fast local reads). Failover is disabled: this account is a read
// replica, not RA-GRS, so there is no `-secondary` endpoint to fall back to.
export const replicaBlobClient = REPLICA_STORAGE_ACCOUNT_NAME
  ? buildBlobClient(REPLICA_STORAGE_ACCOUNT_NAME, false)
  : null;

export const rawContainer: ContainerClient | null = primaryBlobClient
  ? primaryBlobClient.getContainerClient(RAW_CONTAINER_NAME)
  : null;

export const cacheContainer: ContainerClient | null = primaryBlobClient
  ? primaryBlobClient.getContainerClient(CACHE_CONTAINER_NAME)
  : null;

export const replicaRawContainer: ContainerClient | null = replicaBlobClient
  ? replicaBlobClient.getContainerClient(RAW_CONTAINER_NAME)
  : null;

export const replicaCacheContainer: ContainerClient | null = replicaBlobClient
  ? replicaBlobClient.getContainerClient(CACHE_CONTAINER_NAME)
  : null;

export function isAzureStorageEnabled(): boolean {
  return isStorageConfigured && primaryBlobClient !== null;
}

/** True once `initStorageContainers()` has successfully reached the account. */
export function isStorageReady(): boolean {
  return storageReady;
}

/**
 * Blob names are attacker-influenced (query params / upload filenames). Strip
 * path separators and traversal so a caller can never address another container
 * or a parent "directory" inside the account.
 */
export function sanitizeBlobName(blobName: string): string {
  const segment = blobName
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part !== "" && part !== "." && part !== "..")
    .pop();
  if (!segment) return "";
  return segment.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
}

function isNotFound(err: unknown): boolean {
  const status = (err as { statusCode?: number })?.statusCode;
  const code = (err as { code?: string })?.code;
  return status === 404 || code === "BlobNotFound" || code === "ContainerNotFound";
}

/**
 * Single-round-trip blob read. Returns null when the blob (or container) does
 * not exist, and rethrows transport errors so the caller can decide whether to
 * fall back to another account.
 */
async function tryDownload(container: ContainerClient, blobName: string): Promise<Buffer | null> {
  try {
    return await container.getBlockBlobClient(blobName).downloadToBuffer();
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export async function initStorageContainers(): Promise<void> {
  if (!rawContainer || !cacheContainer) {
    console.warn("[Azure Storage] No storage account configured. Running in stateless local-only mode.");
    return;
  }
  try {
    await withTimeout(
      Promise.all([rawContainer.createIfNotExists(), cacheContainer.createIfNotExists()]),
      INIT_TIMEOUT_MS
    );
    storageReady = true;
    console.log(
      `[Azure Storage] Connected to primary account '${STORAGE_ACCOUNT_NAME || "connection-string"}' ` +
        `(containers: ${RAW_CONTAINER_NAME}, ${CACHE_CONTAINER_NAME})`
    );
    if (REPLICA_STORAGE_ACCOUNT_NAME) {
      console.log(`[Azure Storage] Local read-replica enabled: '${REPLICA_STORAGE_ACCOUNT_NAME}'`);
    }
  } catch (err) {
    console.warn(
      "[Azure Storage] Container initialization warning (verify the Storage Blob Data Contributor role is assigned):",
      err instanceof Error ? err.message : err
    );
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Azure Storage init timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Reads a transformed image variant from Azure Blob Storage cache.
 * Checks the regional replica first (if configured), then falls back to the
 * primary account (which transparently fails over to the RA-GRS secondary).
 */
export async function getCachedVariant(cacheKey: string): Promise<{ buffer: Buffer; source: string } | null> {
  if (!isAzureStorageEnabled()) return null;

  // 1. Local region replica first (e.g., North Europe stimagefneurep01)
  if (replicaCacheContainer) {
    try {
      const buffer = await tryDownload(replicaCacheContainer, cacheKey);
      if (buffer) return { buffer, source: "HIT-AZURE-REPLICA" };
    } catch {
      // Replica unavailable / replication lag - fall through to primary.
    }
  }

  // 2. Primary storage account (auto RA-GRS failover to the `-secondary` host)
  if (cacheContainer) {
    try {
      const buffer = await tryDownload(cacheContainer, cacheKey);
      if (buffer) return { buffer, source: "HIT-AZURE-BLOB" };
    } catch (err) {
      console.error(`[Azure Storage] Error reading cache key '${cacheKey}':`, err);
    }
  }

  return null;
}

/**
 * Persists a newly transformed image buffer to the primary Azure Storage
 * Account. Azure RA-GRS and Object Replication replicate the blob to the
 * secondary/EU regions automatically.
 */
export async function putCachedVariant(cacheKey: string, bytes: Uint8Array, contentType: string): Promise<void> {
  if (!cacheContainer) return;
  try {
    const blob = cacheContainer.getBlockBlobClient(cacheKey);
    await blob.uploadData(bytes, {
      blobHTTPHeaders: {
        blobContentType: contentType,
        blobCacheControl: "public, max-age=31536000, immutable",
      },
    });
  } catch (err) {
    console.error(`[Azure Storage] Error writing cache key '${cacheKey}':`, err);
  }
}

/**
 * Reads an uploaded raw source image from Azure Blob Storage.
 * Tries the regional replica first, then the primary account.
 */
export async function getRawBlob(blobName: string): Promise<Buffer | null> {
  if (!isAzureStorageEnabled()) return null;
  const name = sanitizeBlobName(blobName);

  if (replicaRawContainer) {
    try {
      const buffer = await tryDownload(replicaRawContainer, name);
      if (buffer) return buffer;
    } catch {
      // Replica unavailable - fall through to primary.
    }
  }

  if (rawContainer) {
    try {
      const buffer = await tryDownload(rawContainer, name);
      if (buffer) return buffer;
    } catch (err) {
      console.error(`[Azure Storage] Error reading raw blob '${name}':`, err);
    }
  }

  return null;
}

/**
 * Uploads an original raw image to the primary Azure Blob Storage container.
 * Throws when storage is not configured so the HTTP layer can surface a 503.
 */
export async function uploadRawBlob(blobName: string, bytes: Uint8Array, contentType: string): Promise<void> {
  if (!rawContainer) {
    throw new Error("Azure Storage is not configured. Set AZURE_STORAGE_ACCOUNT_NAME or AZURE_STORAGE_CONNECTION_STRING.");
  }
  const blob = rawContainer.getBlockBlobClient(sanitizeBlobName(blobName));
  await blob.uploadData(bytes, {
    blobHTTPHeaders: {
      blobContentType: contentType,
    },
  });
}
